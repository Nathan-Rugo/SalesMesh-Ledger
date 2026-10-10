/**
 * Settlement pipeline against real Postgres (spec gh-6 acceptance criteria):
 *  - two workers, 50 callbacks → each settles exactly once;
 *  - a worker killed mid-batch → rows reclaimed after the visibility timeout, no duplicates;
 *  - ON CONFLICT idempotency of every write;
 *  - ml-engine down → QUARANTINED, is_fail_safe, cause recorded;
 *  - recovered ml-engine CLEAR → re-score promotes to HELD exactly once with two workers,
 *    leaving INITIAL + RESCORE verification events;
 *  - UNRESOLVED retry window, STK replay, payload mutation hold, history window, requeue.
 */

import { createTestDb, count, describeDb, INIT_SQL, mlStub, seedAgent, type TestDb } from './helpers';
import { redactPayload, msisdnHash } from '../../src/domain/callback';
import { idempotencyService } from '../../src/services/idempotency.service';
import { claimBatch, insertIntake, requeue } from '../../src/repositories/intake.repository';
import { recordPayloadMutation } from '../../src/repositories/security.repository';
import { fetchHistory } from '../../src/repositories/transaction.repository';
import { EscrowService } from '../../src/services/escrow.service';
import { ResilientRiskClient } from '../../src/services/risk_client.service';
import { SettlementWorker } from '../../src/workers/settlement.worker';
import { RescoreWorker } from '../../src/workers/rescore.worker';

jest.setTimeout(120_000);

let db: TestDb;
const quiet = () => {
  for (const level of ['info', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
};

function c2b(receipt: string, agentCode: string, opts: { msisdn?: string; time?: string; amount?: string } = {}) {
  const body = {
    TransactionType: 'Pay Bill',
    TransID: receipt,
    TransTime: opts.time ?? '20261001120000', // in the past: future Daraja times are distrusted
    TransAmount: opts.amount ?? '500.00',
    BusinessShortCode: '600638',
    BillRefNumber: agentCode,
    MSISDN: opts.msisdn ?? '254708374149',
    FirstName: 'Jane',
  };
  return { body, raw: Buffer.from(JSON.stringify(body)) };
}

async function enqueue(receipt: string, agentCode: string, opts: Parameters<typeof c2b>[2] = {}) {
  const { body, raw } = c2b(receipt, agentCode, opts);
  return insertIntake(db.pool, {
    receipt,
    hash: idempotencyService.hashPayload(raw),
    channel: 'C2B',
    payload: redactPayload(body),
  });
}

const worker = (cfg: Record<string, unknown> = {}) =>
  new SettlementWorker({
    pool: db.pool,
    riskClient: new ResilientRiskClient(),
    spool: null,
    config: { batchSize: 5, unresolvedBaseDelayMs: 0, ...cfg },
  });

async function drain(w: SettlementWorker): Promise<void> {
  while ((await w.runOnce()) > 0) {
    /* keep going */
  }
}

describeDb('settlement pipeline (real Postgres)', () => {
  beforeAll(async () => {
    db = await createTestDb('sm_pipe');
    await db.pool.query(INIT_SQL);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });
  beforeEach(async () => {
    quiet();
    await db.pool.query(
      `TRUNCATE security_events, escrow_accounts, verification_events, transactions, stk_requests, mpesa_callbacks,
                sales_agents, retail_outlets, users CASCADE`
    );
  });

  it('two workers on one DB: 50 callbacks each settle exactly once', async () => {
    await seedAgent(db.pool, 'AG042');
    const ml = mlStub(() => ({ decision: 'CLEAR' }));
    for (let i = 0; i < 50; i++) await enqueue(`RCPT${String(i).padStart(6, '0')}`, ' ag042 ', { msisdn: `2547083741${String(i).padStart(2, '0')}` });

    const [a, b] = [worker(), worker()];
    await Promise.all([drain(a), drain(b)]);

    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks WHERE status = 'SETTLED'`)).toBe(50);
    expect(await count(db.pool, `SELECT count(*) AS n FROM transactions`)).toBe(50);
    expect(await count(db.pool, `SELECT count(*) AS n FROM verification_events`)).toBe(50);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE escrow_status = 'HELD'`)).toBe(50);
    expect(new Set(ml.calls.map((c) => c.transaction_id)).size).toBe(50);
    expect(ml.calls).toHaveLength(50);

    // Each later transaction was scored with the agent's own earlier history (no foreign rows).
    for (const call of ml.calls) {
      expect(call.history.every((h: any) => h.agent_id === call.transaction.agent_id && h.transaction_id !== call.transaction_id)).toBe(true);
    }
    const { rows } = await db.pool.query(`SELECT * FROM verification_events LIMIT 1`);
    expect(rows[0]).toMatchObject({ decision: 'CLEAR', kind: 'INITIAL', is_fail_safe: false, model_sha256: 'b'.repeat(64), layer2_adjudicated: false });
    expect(rows[0].isolation_forest_score).toBeCloseTo(0.123456789, 9); // raw float, not DECIMAL(5,4)
  });

  it('a worker killed mid-batch: rows are reclaimed after the visibility timeout, no duplicates', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => ({ decision: 'CLEAR' }));
    for (let i = 0; i < 6; i++) await enqueue(`CRSH${String(i).padStart(6, '0')}`, 'AG042');

    const crashed = worker({ batchSize: 6 });
    const stolen = await claimBatch(db.pool, 6, 300_000, 5); // claimed, then the process "dies"
    await crashed.process(stolen[0]); // it got one row done before dying
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks WHERE status = 'PROCESSING'`)).toBe(5);

    const fresh = worker();
    expect(await fresh.runOnce()).toBe(0); // still leased
    await db.pool.query(`UPDATE mpesa_callbacks SET claimed_at = NOW() - interval '6 minutes' WHERE status = 'PROCESSING'`);
    await drain(fresh);

    // The zombie wakes up and tries to finish with its stale token: fenced out.
    for (const row of stolen.slice(1)) expect(await crashed.process(row)).toBe('lease_lost');

    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks WHERE status = 'SETTLED'`)).toBe(6);
    expect(await count(db.pool, `SELECT count(*) AS n FROM transactions`)).toBe(6);
    expect(await count(db.pool, `SELECT count(*) AS n FROM verification_events`)).toBe(6);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts`)).toBe(6);
  });

  it('stale rows with attempts exhausted are swept to DEAD, and requeue brings them back', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => ({ decision: 'CLEAR' }));
    await enqueue('DEAD000001', 'AG042');
    await db.pool.query(
      `UPDATE mpesa_callbacks SET status = 'PROCESSING', attempts = 5, claimed_at = NOW() - interval '6 minutes', claim_token = gen_random_uuid()`
    );
    const w = worker();
    expect(await w.runOnce()).toBe(0); // not reclaimable: attempts exhausted
    await w.housekeeping(true);
    expect((await db.pool.query(`SELECT status FROM mpesa_callbacks`)).rows[0].status).toBe('DEAD');

    const requeued = await requeue(db.pool, { statuses: ['DEAD'], receipts: [], dryRun: false });
    expect(requeued).toHaveLength(1);
    await drain(w);
    expect((await db.pool.query(`SELECT status, attempts FROM mpesa_callbacks`)).rows[0]).toMatchObject({ status: 'SETTLED', attempts: 1 });
  });

  it('every write is ON CONFLICT-idempotent', async () => {
    const agentId = await seedAgent(db.pool, 'AG042');
    const first = await enqueue('IDEM000001', 'AG042');
    const again = await enqueue('IDEM000001', 'AG042');
    expect(first.outcome).toBe('inserted');
    expect(again).toMatchObject({ outcome: 'existing' });

    const escrow = new EscrowService(db.pool);
    const rec = { agent_id: agentId, mpesa_receipt_id: 'IDEM000001', raw_payload_hash: 'k1:x', amount: '10.00', source_channel: 'C2B' as const, counterparty_hash: 'k1:y' };
    const t1 = await escrow.persistTransaction(rec);
    const t2 = await escrow.persistTransaction(rec);
    expect(t2).toBe(t1);
    const risk = new ResilientRiskClient().failSafeDecision('IDEM000001', 'timeout');
    expect((await escrow.processSettlement(t1, risk, '1.00')).created).toBe(true);
    expect((await escrow.processSettlement(t1, risk, '1.00')).created).toBe(false);
    expect(await count(db.pool, `SELECT count(*) AS n FROM verification_events`)).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts`)).toBe(1);
  });

  it('ml-engine down → escrow QUARANTINED, is_fail_safe true, cause recorded, scores NULL', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => 'down');
    await enqueue('DOWN000001', 'AG042');
    await drain(worker());
    const { rows: [r] } = await db.pool.query(
      `SELECT e.escrow_status, e.hold_period_hours, v.* FROM escrow_accounts e JOIN verification_events v USING (transaction_id)`
    );
    expect(r).toMatchObject({
      escrow_status: 'QUARANTINED',
      hold_period_hours: 72,
      is_fail_safe: true,
      fail_safe_cause: 'service_unavailable',
      decision: 'QUARANTINE',
      isolation_forest_score: null,
      xgboost_fraud_prob: null,
      model_version: 'v1.0.0-failsafe',
    });
  });

  it('self-heal: recovered ml-engine CLEAR → HELD exactly once with two re-score workers; INITIAL + RESCORE events', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => 'down');
    await enqueue('HEAL000001', 'AG042');
    await enqueue('HEAL000002', 'AG042');
    await drain(worker());
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE escrow_status = 'QUARANTINED'`)).toBe(2);

    // A model-made quarantine must never be touched by self-heal.
    await db.pool.query(
      `UPDATE verification_events SET is_fail_safe = FALSE, fail_safe_cause = NULL, decision = 'QUARANTINE'
        WHERE transaction_id = (SELECT transaction_id FROM transactions WHERE mpesa_receipt_id = 'HEAL000002')`
    );

    const ml = mlStub(() => ({ decision: 'CLEAR' }));
    const rescorer = () => new RescoreWorker({ pool: db.pool, riskClient: new ResilientRiskClient(), config: { batchSize: 10 } });
    const [r1, r2] = [rescorer(), rescorer()];
    await Promise.all([r1.runOnce(), r2.runOnce()]);
    await Promise.all([r1.runOnce(), r2.runOnce()]); // nothing left to do

    const { rows } = await db.pool.query(
      `SELECT t.mpesa_receipt_id, e.escrow_status, e.hold_period_hours,
              array_agg(v.kind ORDER BY v.evaluated_at, v.kind) AS kinds
         FROM escrow_accounts e JOIN transactions t USING (transaction_id)
         JOIN verification_events v USING (transaction_id)
        GROUP BY 1, 2, 3 ORDER BY 1`
    );
    expect(rows[0]).toMatchObject({ mpesa_receipt_id: 'HEAL000001', escrow_status: 'HELD', hold_period_hours: 24, kinds: ['INITIAL', 'RESCORE'] });
    expect(rows[1]).toMatchObject({ mpesa_receipt_id: 'HEAL000002', escrow_status: 'QUARANTINED', kinds: ['INITIAL'] });
    expect(ml.calls.filter((c) => c.transaction_id === 'HEAL000001')).toHaveLength(1);
    expect(ml.calls.filter((c) => c.transaction_id === 'HEAL000002')).toHaveLength(0);
    const { rows: [due] } = await db.pool.query(
      `SELECT release_due_at > NOW() + interval '23 hours' AS fresh FROM escrow_accounts e
         JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = 'HEAL000001'`
    );
    expect(due.fresh).toBe(true);
  });

  it('a re-score that is still not CLEAR stays QUARANTINED and backs off', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => 'down');
    await enqueue('HEAL000003', 'AG042');
    await drain(worker());
    mlStub(() => ({ decision: 'REVIEW' }));
    const r = new RescoreWorker({ pool: db.pool, riskClient: new ResilientRiskClient() });
    expect(await r.runOnce()).toBe(1);
    expect(await r.runOnce()).toBe(0); // latest event is now model-made: no longer eligible
    const { rows: [e] } = await db.pool.query(`SELECT escrow_status, rescore_claim_token FROM escrow_accounts`);
    expect(e).toMatchObject({ escrow_status: 'QUARANTINED', rescore_claim_token: null });
    expect(await count(db.pool, `SELECT count(*) AS n FROM verification_events WHERE kind = 'RESCORE' AND decision = 'REVIEW'`)).toBe(1);
  });

  it('payload mutation → security hold QUARANTINED; self-heal never touches it', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => ({ decision: 'CLEAR' }));
    await enqueue('MUTA000001', 'AG042');
    await recordPayloadMutation(db.pool, 'MUTA000001', 'k1:orig', 'k1:evil');
    await drain(worker());
    const { rows: [e] } = await db.pool.query(`SELECT escrow_status, security_hold FROM escrow_accounts`);
    expect(e).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });

    // Mutation detected after settlement also forces the hold.
    await enqueue('MUTA000002', 'AG042');
    await drain(worker());
    await recordPayloadMutation(db.pool, 'MUTA000002', 'k1:orig', 'k1:evil2');
    await recordPayloadMutation(db.pool, 'MUTA000002', 'k1:orig', 'k1:evil2'); // idempotent
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE security_hold`)).toBe(2);
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events`)).toBe(2);
    expect(await new RescoreWorker({ pool: db.pool, riskClient: new ResilientRiskClient() }).runOnce()).toBe(0);
  });

  it('unknown agent code → UNRESOLVED, retried until it resolves; past the window it waits for review', async () => {
    mlStub(() => ({ decision: 'CLEAR' }));
    await enqueue('UNRS000001', 'AG777');
    const w = worker({ unresolvedWindowMs: 60_000 });
    expect(await w.runOnce()).toBe(1); // base delay 0: immediately due again
    const { rows: [u] } = await db.pool.query(`SELECT status, resolve_attempts, next_attempt_at <> 'infinity' AS retrying, last_error FROM mpesa_callbacks`);
    expect(u).toMatchObject({ status: 'UNRESOLVED', resolve_attempts: 1, retrying: true });
    expect(u.last_error).toContain('c2b_unknown_agent_code');
    expect(await count(db.pool, `SELECT count(*) AS n FROM transactions`)).toBe(0);

    await seedAgent(db.pool, 'AG777'); // the agent is onboarded within the window
    expect(await w.runOnce()).toBe(1);
    expect((await db.pool.query(`SELECT status FROM mpesa_callbacks`)).rows[0].status).toBe('SETTLED');

    await enqueue('UNRS000002', 'AG888');
    const short = worker({ unresolvedWindowMs: 0 });
    expect(await short.runOnce()).toBe(1);
    expect(await short.runOnce()).toBe(0); // terminal: waits for review / requeue
    const { rows: [t] } = await db.pool.query(
      `SELECT status, next_attempt_at = 'infinity' AS terminal FROM mpesa_callbacks WHERE mpesa_receipt_id = 'UNRS000002'`
    );
    expect(t).toEqual({ status: 'UNRESOLVED', terminal: true });
  });

  it('STK: resolves via stk_requests, and a second receipt for the same request is held UNRESOLVED with an alarm', async () => {
    const agentId = await seedAgent(db.pool, null);
    mlStub(() => ({ decision: 'CLEAR' }));
    await db.pool.query(`INSERT INTO stk_requests (checkout_request_id, agent_id, amount) VALUES ('ws_CO_1', $1, 1500)`, [agentId]);
    const stk = (receipt: string, amount: unknown) => {
      const body = {
        Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, CallbackMetadata: { Item: [
          { Name: 'Amount', Value: amount },
          { Name: 'MpesaReceiptNumber', Value: receipt },
          { Name: 'TransactionDate', Value: 20261001120000 },
          { Name: 'PhoneNumber', Value: 254708374149 },
        ] } } },
      };
      return insertIntake(db.pool, { receipt, hash: idempotencyService.hashPayload(Buffer.from(JSON.stringify(body))), channel: 'DARAJA_STK', payload: redactPayload(body) });
    };
    await stk('STKA000001', 1500.0);
    await drain(worker());
    const { rows: [tx] } = await db.pool.query(`SELECT agent_id, counterparty_hash, timestamp FROM transactions`);
    expect(tx.agent_id).toBe(agentId);
    expect(tx.counterparty_hash).toBe(msisdnHash('254708374149'));
    expect(new Date(tx.timestamp).toISOString()).toBe('2026-10-01T09:00:00.000Z');

    await stk('STKA000002', '1500');
    await drain(worker());
    const { rows: [r] } = await db.pool.query(`SELECT status, last_error FROM mpesa_callbacks WHERE mpesa_receipt_id = 'STKA000002'`);
    expect(r.status).toBe('UNRESOLVED');
    expect(r.last_error).toContain('stk_receipt_replay');
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'STK_RECEIPT_REPLAY'`)).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM transactions`)).toBe(1);
  });

  it('Redis spool (Postgres was down at ACK time) is drained into intake, then settled; spooled mutation raises the alarm', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => ({ decision: 'CLEAR' }));
    const { body, raw } = c2b('SPOL000001', 'AG042');
    const hash = idempotencyService.hashPayload(raw);
    const list: string[] = [
      JSON.stringify({ receipt: 'SPOL000001', hash, channel: 'C2B', payload: redactPayload(body), receivedAt: '2026-10-09T09:00:05.000Z' }),
      JSON.stringify({ receipt: 'SPOL000001', hash, channel: 'C2B', payload: redactPayload(body), receivedAt: '2026-10-09T09:00:06.000Z' }),
      'not json',
    ];
    const spool = {
      peek: async (n: number) => list.slice(0, n),
      remove: async (r: string) => {
        list.splice(list.indexOf(r), 1);
      },
    };
    const w = new SettlementWorker({ pool: db.pool, riskClient: new ResilientRiskClient(), spool, config: {} });
    expect(await w.drainSpool()).toBe(2);
    expect(list).toEqual([]);
    const { rows: [cb] } = await db.pool.query(`SELECT status, received_at FROM mpesa_callbacks`);
    expect(cb.status).toBe('PENDING');
    expect(new Date(cb.received_at).toISOString()).toBe('2026-10-09T09:00:05.000Z');
    await drain(w);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts`)).toBe(1);

    list.push(JSON.stringify({ receipt: 'SPOL000001', hash: hash.slice(0, -4) + 'beef', channel: 'C2B', payload: {}, receivedAt: '2026-10-09T09:01:00.000Z' }));
    await w.drainSpool();
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE security_hold AND escrow_status = 'QUARANTINED'`)).toBe(1);
  });

  it('re-score replays exactly the INITIAL history receipts (a late-committed same-agent row is not added)', async () => {
    const agentId = await seedAgent(db.pool, 'AG042');
    const prior = (receipt: string, at: string, ingested: string) =>
      db.pool.query(
        `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, timestamp, counterparty_hash, ingested_at)
         VALUES ($1, $2, 'h', 10, 'C2B', $3, 'cp', $4)`,
        [agentId, receipt, at, ingested]
      );
    await prior('PRIO000001', '2026-09-30T09:00:00Z', '2026-09-30T09:00:01Z');
    mlStub(() => 'down');
    await enqueue('RPLY000001', 'AG042'); // t = 2026-10-01T09:00:00Z
    await drain(worker());
    const { rows: [ev] } = await db.pool.query(`SELECT history_receipts, evaluated_at FROM verification_events WHERE kind = 'INITIAL'`);
    expect(ev.history_receipts).toEqual(['PRIO000001']);

    // A row whose transaction began before the INITIAL history fetch but committed after it:
    // timestamp <= t and ingested_at <= INITIAL.evaluated_at, so the old ingest cut would leak it in.
    await prior('LATE000001', '2026-10-01T08:00:00Z', new Date(new Date(ev.evaluated_at).getTime() - 1000).toISOString());

    const ml = mlStub(() => ({ decision: 'CLEAR' }));
    expect(await new RescoreWorker({ pool: db.pool, riskClient: new ResilientRiskClient() }).runOnce()).toBe(1);
    const call = ml.calls.find((c) => c.transaction_id === 'RPLY000001');
    expect(call.history.map((h: any) => h.transaction_id)).toEqual(['PRIO000001']);
  });

  it('self-heal ignores model-made quarantines and RELEASED escrows', async () => {
    await seedAgent(db.pool, 'AG042');
    mlStub(() => 'down');
    await enqueue('SKIP000001', 'AG042');
    await enqueue('SKIP000002', 'AG042');
    await drain(worker());
    // SKIP000001: a model-made QUARANTINE is the latest event (appended after the fail-safe one).
    await db.pool.query(
      `INSERT INTO verification_events (transaction_id, model_version, decision, kind, evaluated_at)
       SELECT transaction_id, 'v1.0.0', 'QUARANTINE', 'RESCORE', NOW() + interval '1 second'
         FROM transactions WHERE mpesa_receipt_id = 'SKIP000001'`
    );
    // SKIP000002: released, though its only event is a retryable fail-safe.
    await db.pool.query(
      `UPDATE escrow_accounts SET escrow_status = 'RELEASED'
        WHERE transaction_id = (SELECT transaction_id FROM transactions WHERE mpesa_receipt_id = 'SKIP000002')`
    );
    const before = (await db.pool.query(`SELECT * FROM escrow_accounts ORDER BY escrow_id`)).rows;

    const ml = mlStub(() => ({ decision: 'CLEAR' }));
    expect(await new RescoreWorker({ pool: db.pool, riskClient: new ResilientRiskClient() }).runOnce()).toBe(0);
    expect(ml.calls).toHaveLength(0);
    expect((await db.pool.query(`SELECT * FROM escrow_accounts ORDER BY escrow_id`)).rows).toEqual(before);
    expect(await count(db.pool, `SELECT count(*) AS n FROM verification_events WHERE kind = 'RESCORE'`)).toBe(1);
  });

  it('history: (t − 30 d, t], same agent only, excludes this receipt, most recent first, truncation flagged', async () => {
    const a = await seedAgent(db.pool, 'AGH1');
    const other = await seedAgent(db.pool, 'AGH2');
    const t = new Date('2026-10-09T09:00:00Z');
    const ins = (agent: string, receipt: string, at: string) =>
      db.pool.query(
        `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, timestamp, counterparty_hash)
         VALUES ($1, $2, 'h', 10, 'C2B', $3, 'cp')`,
        [agent, receipt, at]
      );
    await ins(a, 'HIST000001', '2026-09-09T09:00:00Z'); // exactly t − 30 d: excluded
    await ins(a, 'HIST000002', '2026-09-09T09:00:01Z');
    await ins(a, 'HIST000003', '2026-10-09T09:00:00Z'); // == t: included
    await ins(a, 'HIST000004', '2026-10-09T09:00:00Z');
    await ins(a, 'HIST000005', '2026-10-09T09:00:01Z'); // after t: excluded
    await ins(a, 'SELF000001', '2026-10-01T00:00:00Z'); // this receipt
    await ins(other, 'HIST000006', '2026-10-01T00:00:00Z');

    const all = await fetchHistory(db.pool, { agentId: a, at: t, excludeReceipt: 'SELF000001', limit: 2000 });
    expect(all.rows.map((r) => r.transaction_id)).toEqual(['HIST000004', 'HIST000003', 'HIST000002']);
    expect(all.truncated).toBe(false);
    const capped = await fetchHistory(db.pool, { agentId: a, at: t, excludeReceipt: 'SELF000001', limit: 2 });
    expect(capped.rows.map((r) => r.transaction_id)).toEqual(['HIST000004', 'HIST000003']);
    expect(capped.truncated).toBe(true);
    const none = await fetchHistory(db.pool, { agentId: other, at: new Date('2020-01-01Z'), excludeReceipt: 'X', limit: 2000 });
    expect(none.rows).toEqual([]);
  });
});
