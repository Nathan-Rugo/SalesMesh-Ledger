/**
 * Chaos over real sockets (spec gh-15, I/O matrix rows 4–6): the gateway's own Postgres, Redis and
 * ml-engine connections go through an in-process TCP fault proxy that cuts, delays or resets them.
 * The hot path runs with its production deadline (150 ms, NFR-01), not the 1.5 s test default.
 * Fabric peer outage is covered by tests/e2e/ledger.e2e.test.ts and is not repeated here.
 */

import http from 'http';
import { startFaultProxy, type FaultProxy } from '../../support/fault-proxy';
import { count, mlResponse, seedAgent } from '../helpers';
import { c2b, deliverUntilAck, describeStack, quiet, runPrefix, startStack, type Stack } from './harness';

jest.setTimeout(120_000);

const DEADLINE_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeStack('resilience: chaos via TCP fault proxy (real Postgres + Redis)', () => {
  let s: Stack;
  let prefix: string;
  let ml: http.Server;
  let mlProxy: FaultProxy;
  const mlCalls = new Map<string, number>();

  beforeAll(async () => {
    quiet();
    s = await startStack('sm_chaos', { HOT_PATH_DEADLINE_MS: String(DEADLINE_MS) });
    await seedAgent(s.db.pool, 'AGCHAOS');
    // Warm the hot pool: cold connects (SCRAM auth via the proxy) alone can exceed the 150 ms deadline.
    for (let i = 0; i < 50 && s.mods.hotPool.idleCount < 10; i++) {
      await Promise.allSettled(Array.from({ length: 10 }, () => s.mods.hotPool.query('SELECT 1')));
    }
    // A real HTTP ml-engine stand-in (CLEAR for everything), reached through its own proxy.
    ml = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const r = JSON.parse(body);
        mlCalls.set(r.transaction_id, (mlCalls.get(r.transaction_id) ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(mlResponse(r, { decision: 'CLEAR' })));
      });
    });
    await new Promise<void>((r) => ml.listen(0, '127.0.0.1', r));
    mlProxy = await startFaultProxy('127.0.0.1', (ml.address() as { port: number }).port);
    process.env.ML_SERVICE_URL = `http://127.0.0.1:${mlProxy.port}`;
  });
  afterAll(async () => {
    await s?.close();
    await mlProxy?.close();
    await new Promise((r) => ml?.close(r));
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    prefix = runPrefix();
    s.pg.restore();
    s.redis.restore();
    mlProxy.restore();
  });

  const receipts = (n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
  const send = (receipt: string) => s.post(c2b(receipt, 'AGCHAOS'));
  const intakeRows = () => count(s.db.pool, `SELECT count(*) AS n FROM mpesa_callbacks WHERE mpesa_receipt_id LIKE $1`, [`${prefix}%`]);
  const worker = (batchSize = 25) =>
    new s.mods.SettlementWorker({ pool: s.db.pool, riskClient: new s.mods.ResilientRiskClient(), spool: s.mods.spoolService, config: { batchSize } });
  const drain = async (w = worker()) => {
    while ((await w.runOnce()) > 0) {
      /* keep going */
    }
  };
  /** Exactly one intake row, transaction and escrow per receipt. */
  const expectExactlyOnce = async (rs: string[]) => {
    const { rows } = await s.db.pool.query(
      `SELECT r AS receipt,
              (SELECT count(*) FROM mpesa_callbacks WHERE mpesa_receipt_id = r)::int AS intake,
              (SELECT count(*) FROM transactions WHERE mpesa_receipt_id = r)::int AS tx,
              (SELECT count(*) FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = r)::int AS escrow
         FROM unnest($1::text[]) AS r`,
      [rs]
    );
    expect(rows.filter((r) => r.intake !== 1 || r.tx !== 1 || r.escrow !== 1)).toEqual([]);
  };
  const spooled = async (rs: string[]) => {
    const items: string[] = await s.mods.redisClient.lrange(s.mods.SPOOL_KEY, 0, -1);
    return new Set(items.map((i) => JSON.parse(i).receipt).filter((r: string) => rs.includes(r)));
  };
  /** Redis db 0 is shared with other test files, so leftover entries can sit ahead of ours and
   *  drainSpool takes one batch per call: keep draining until none of these receipts remain. */
  const drainSpoolOf = async (rs: string[]) => {
    const w = worker();
    for (let i = 0; i < 50 && (await spooled(rs)).size > 0; i++) {
      await w.drainSpool(); // parked entries count as 0 moved, so no early exit on 0
    }
  };
  const redisReady = async () => {
    for (let i = 0; i < 100 && s.mods.redisClient.status !== 'ready'; i++) await sleep(100);
    expect(s.mods.redisClient.status).toBe('ready');
  };

  it('Redis cut: deliveries still ACK via Postgres (claim unverified), duplicates still dedup; after restore nothing is duplicated', async () => {
    const rs = receipts(10);
    (console.error as jest.Mock).mockClear(); // only this test's calls count
    s.redis.cut();
    const first = await Promise.all(rs.map(send));
    const again = await Promise.all(rs.map(send)); // Daraja redelivers while Redis is still down
    expect([...first, ...again].filter((x) => x !== 200)).toEqual([]);
    expect(await intakeRows()).toBe(10);
    const logged = (console.error as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Redis unavailable, dedup unverified');

    s.redis.restore();
    await redisReady();
    expect((await Promise.all(rs.map(send))).filter((x) => x !== 200)).toEqual([]);
    expect(await intakeRows()).toBe(10);
    await drain();
    await expectExactlyOnce(rs);
  });

  it('Postgres cut: 503 (never a 200 without a durable row) and spooled; Daraja-style retry after restore settles exactly once', async () => {
    const rs = receipts(5);
    s.pg.cut();
    const during = await Promise.all(rs.map(send));
    expect(during.every((x) => x === 503)).toBe(true);
    expect(await spooled(rs)).toEqual(new Set(rs));

    s.pg.restore();
    const retries = await Promise.all(rs.map((r) => deliverUntilAck(() => send(r))));
    expect(retries.map((r) => r.at(-1))).toEqual(rs.map(() => 200));
    // The spool drain and the Daraja retry both deliver: ON CONFLICT keeps one row.
    await drainSpoolOf(rs);
    expect(await spooled(rs)).toEqual(new Set());
    expect(await intakeRows()).toBe(5);
    await drain();
    await expectExactlyOnce(rs);
  });

  it(`Postgres latency above the ${DEADLINE_MS} ms deadline: 503 while slow; every 200 has a row; retry after restore → exactly once`, async () => {
    const rs = receipts(5);
    s.pg.cut(); // drop pooled connections so every delivery has to go through the slow link
    s.pg.restore();
    s.pg.latency(DEADLINE_MS * 3);
    const during = await Promise.all(rs.map(async (r) => ({ r, status: await send(r) })));
    expect(during.filter((d) => d.status === 200)).toEqual([]);
    expect(during.every((d) => d.status === 503)).toBe(true);

    s.pg.restore();
    await sleep(DEADLINE_MS * 6); // a 503'd insert may still commit late: the retry must cope
    const retries = await Promise.all(rs.map((r) => deliverUntilAck(() => send(r))));
    expect(retries.map((r) => r.at(-1))).toEqual(rs.map(() => 200));
    await drainSpoolOf(rs);
    await drain();
    await expectExactlyOnce(rs);
  });

  it('flaky Postgres (every 2nd connection reset): some 503s, every receipt ACKed after redelivery, exactly once', async () => {
    const rs = receipts(20);
    s.pg.cut();
    s.pg.restore();
    const before = s.pg.stats().dropped;
    s.pg.dropEvery(2);
    const seen = await Promise.all(rs.map((r) => deliverUntilAck(() => send(r))));
    s.pg.restore();

    expect(s.pg.stats().dropped).toBeGreaterThan(before);
    // 0 = the proxy reset the socket itself (transport error): Daraja retries that like a 503.
    expect(seen.flat().filter((x) => x !== 200 && x !== 503 && x !== 0)).toEqual([]);
    expect(seen.map((r) => r.at(-1))).toEqual(rs.map(() => 200));
    expect(seen.flat().some((x) => x === 503 || x === 0)).toBe(true);
    await drainSpoolOf(rs);
    await drain();
    await expectExactlyOnce(rs);
  });

  it('ml-engine down mid-run: scored rows before the cut CLEAR, the rest fail safe QUARANTINED; re-score promotes each exactly once', async () => {
    const rs = receipts(6);
    for (const r of rs) expect(await send(r)).toBe(200);
    const w = worker(1);
    expect(await w.runOnce()).toBe(1);
    expect(await w.runOnce()).toBe(1);
    mlProxy.cut();
    await drain(w);

    const status = async () =>
      (
        await s.db.pool.query(
          `SELECT t.mpesa_receipt_id AS r, e.escrow_status AS status, e.quarantine_reason AS reason
             FROM escrow_accounts e JOIN transactions t USING (transaction_id)
            WHERE t.mpesa_receipt_id LIKE $1 ORDER BY 1`,
          [`${prefix}%`]
        )
      ).rows;
    const mid = await status();
    expect(mid.map((x) => x.status)).toEqual(['HELD', 'HELD', 'QUARANTINED', 'QUARANTINED', 'QUARANTINED', 'QUARANTINED']);
    expect(mid.slice(2).every((x) => x.reason === 'fail_safe')).toBe(true);
    const { rows: causes } = await s.db.pool.query(
      `SELECT DISTINCT v.fail_safe_cause AS cause FROM verification_events v JOIN transactions t USING (transaction_id)
        WHERE t.mpesa_receipt_id LIKE $1 AND v.is_fail_safe ORDER BY 1`,
      [`${prefix}%`]
    );
    // The breaker opens after 3 failures, so later rows fail safe without a call.
    expect(causes.map((c) => c.cause)).toEqual(['circuit_open', 'service_unavailable']);

    mlProxy.restore();
    const callsBefore = new Map(mlCalls);
    const rescorer = new s.mods.RescoreWorker({ pool: s.db.pool, riskClient: new s.mods.ResilientRiskClient(), config: { batchSize: 10 } });
    expect(await rescorer.runOnce()).toBe(4);
    expect(await rescorer.runOnce()).toBe(0);
    expect((await status()).map((x) => x.status)).toEqual(rs.map(() => 'HELD'));
    for (const r of rs.slice(2)) expect((mlCalls.get(r) ?? 0) - (callsBefore.get(r) ?? 0)).toBe(1);
    expect(
      await count(
        s.db.pool,
        `SELECT count(*) AS n FROM verification_events v JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id LIKE $1 AND v.kind = 'RESCORE'`,
        [`${prefix}%`]
      )
    ).toBe(4);
  });
});
