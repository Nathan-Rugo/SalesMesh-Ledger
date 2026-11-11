/**
 * Duplicate injection over HTTP (spec gh-15, I/O matrix rows 1–3): the real webhook route, real
 * Postgres + Redis, then the real SettlementWorker. FR-02: every receipt settles exactly once.
 */

import { count, mlStub, seedAgent } from '../helpers';
import { c2b, describeStack, quiet, runPrefix, startStack, stkCallback, type Stack } from './harness';

jest.setTimeout(120_000);

describeStack('resilience: duplicate injection (real Postgres + Redis)', () => {
  let s: Stack;
  let prefix: string;

  beforeAll(async () => {
    quiet();
    s = await startStack('sm_dup');
  });
  afterAll(async () => {
    await s?.close();
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    prefix = runPrefix();
    mlStub(() => ({ decision: 'CLEAR' }));
  });

  const worker = () => new s.mods.SettlementWorker({ pool: s.db.pool, riskClient: new s.mods.ResilientRiskClient(), spool: null, config: { batchSize: 25 } });
  const drain = async () => {
    const w = worker();
    while ((await w.runOnce()) > 0) {
      /* keep going */
    }
  };
  const rows = (table: string, extra = '') =>
    count(s.db.pool, `SELECT count(*) AS n FROM ${table} WHERE mpesa_receipt_id LIKE $1 ${extra}`, [`${prefix}%`]);

  it('exact replay storm: 50 receipts × 5 identical concurrent deliveries → all 200; one intake, transaction and escrow each', async () => {
    await seedAgent(s.db.pool, 'AGDUP');
    const receipts = Array.from({ length: 50 }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
    const deliveries = receipts.flatMap((r, i) => Array.from({ length: 5 }, () => c2b(r, 'AGDUP', '500.00', `2547083741${String(i).padStart(2, '0')}`)));
    // At most 25 requests in flight (the 5 copies of a receipt are adjacent, so they still race each
    // other). 250 simultaneous connects overflow the listen backlog on Windows (ECONNREFUSED), which
    // tests the OS, not the gateway.
    const statuses: number[] = new Array(deliveries.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        while (next < deliveries.length) {
          const i = next++;
          statuses[i] = await s.post(deliveries[i]);
        }
      })
    );

    expect(statuses.filter((x) => x !== 200)).toEqual([]);
    expect(await rows('mpesa_callbacks')).toBe(50);
    await drain();
    expect(await rows('mpesa_callbacks', `AND status = 'SETTLED'`)).toBe(50);
    expect(await rows('transactions')).toBe(50);
    expect(
      await count(s.db.pool, `SELECT count(*) AS n FROM escrow_accounts JOIN transactions USING (transaction_id) WHERE mpesa_receipt_id LIKE $1`, [`${prefix}%`])
    ).toBe(50);
    expect(await rows('security_events')).toBe(0);

    // A late replay after settlement is still a 200 with nothing new.
    expect(await s.post(c2b(receipts[0], 'AGDUP', '500.00', '254708374100'))).toBe(200);
    expect(await rows('mpesa_callbacks')).toBe(50);
  });

  it('out-of-order / cross-channel: C2B confirmation before the STK callback (same receipt + amount) → one settlement + STK_CHANNEL_ECHO', async () => {
    const agentId = await seedAgent(s.db.pool, 'AGECHO');
    const checkout = `ws_CO_${prefix}`;
    await s.db.pool.query(`INSERT INTO stk_requests (checkout_request_id, agent_id, amount, status) VALUES ($1, $2, 500, 'ACCEPTED')`, [checkout, agentId]);
    const receipt = `${prefix}ECHO1`;

    expect(await s.post(c2b(receipt, 'AGECHO', '500.00'))).toBe(200);
    expect(await s.post(stkCallback(receipt, checkout, 500))).toBe(200);
    expect(await s.post(stkCallback(receipt, checkout, 500))).toBe(200); // the STK callback retried too
    await drain();

    expect(await rows('mpesa_callbacks')).toBe(1);
    expect(await rows('transactions')).toBe(1);
    expect((await s.db.pool.query(`SELECT event_type FROM security_events WHERE mpesa_receipt_id = $1`, [receipt])).rows).toEqual([
      { event_type: 'STK_CHANNEL_ECHO' },
    ]);
    const { rows: [e] } = await s.db.pool.query(
      `SELECT e.escrow_status, e.security_hold FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = $1`,
      [receipt]
    );
    expect(e).toEqual({ escrow_status: 'HELD', security_hold: false });
  });

  it('mutated retry: same receipt, different amount → the original is kept, PAYLOAD_MUTATION hold (escrow QUARANTINED)', async () => {
    await seedAgent(s.db.pool, 'AGMUT');
    const receipt = `${prefix}MUTA1`;
    expect(await s.post(c2b(receipt, 'AGMUT', '500.00'))).toBe(200);
    expect(await s.post(c2b(receipt, 'AGMUT', '50000.00'))).toBe(200); // ACKed: a retry cannot fix it
    await drain();

    expect(await rows('mpesa_callbacks')).toBe(1);
    const { rows: [t] } = await s.db.pool.query(
      `SELECT t.amount, e.escrow_status, e.security_hold FROM transactions t JOIN escrow_accounts e USING (transaction_id) WHERE t.mpesa_receipt_id = $1`,
      [receipt]
    );
    expect(t).toEqual({ amount: '500.00', escrow_status: 'QUARANTINED', security_hold: true });
    expect(await rows('security_events', `AND event_type = 'PAYLOAD_MUTATION'`)).toBe(1);
  });
});
