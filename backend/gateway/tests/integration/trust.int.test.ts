/**
 * Risk-adaptive escrow hold and trust scores against real Postgres (spec gh-23 acceptance criteria):
 *  - two agents (R_eff 0.98 / 0.50), identical adjudicated low-risk CLEAR → ≈ 1.03 h vs ≈ 3.82 h,
 *    trust rows recomputable from their stored columns and the config snapshot;
 *  - retried settlement → one trust row, no duplicated rating change; matured clean hold → +β once;
 *  - security events penalise once (event_type:receipt), whatever the escrow status; operator undo;
 *  - concurrent settlements / credits / penalties of one agent serialise (no lost update, no deadlock);
 *  - self-heal: fail-safe → no trust row; RESCORE writes it and promotes for T_hold, or freezes.
 */

import crypto from 'crypto';
import { formatDarajaTime, redactPayload } from '../../src/domain/callback';
import { round6 } from '../../src/domain/trust';
import { idempotencyService } from '../../src/services/idempotency.service';
import { claimBatch, insertIntake } from '../../src/repositories/intake.repository';
import { insertSecurityEvent, recordPayloadMutation, securityHoldReceipt } from '../../src/repositories/security.repository';
import { agentMaturity, creditReceipt, findAgent, medianSettledAmount, operatorAdjust, trustStats } from '../../src/repositories/trust.repository';
import { withTransaction } from '../../src/repositories/db.types';
import { EscrowService } from '../../src/services/escrow.service';
import { ResilientRiskClient } from '../../src/services/risk_client.service';
import { SettlementWorker } from '../../src/workers/settlement.worker';
import { RescoreWorker } from '../../src/workers/rescore.worker';
import { count, createTestDb, describeDb, INIT_SQL, mlStub, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

let db: TestDb;
const quiet = () => {
  for (const level of ['info', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
};
const rcpt = (p: string) => `${p}${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 10);

async function enqueue(receipt: string, agentCode: string, amount = '1000.00', at = new Date(Date.now() - 60_000)) {
  const body = {
    TransactionType: 'Pay Bill', TransID: receipt, TransTime: formatDarajaTime(at), TransAmount: amount,
    BusinessShortCode: '600638', BillRefNumber: agentCode, MSISDN: `2547${crypto.randomInt(10_000_000, 99_999_999)}`,
  };
  await insertIntake(db.pool, { receipt, hash: idempotencyService.hashPayload(Buffer.from(JSON.stringify(body))), channel: 'C2B', payload: redactPayload(body) });
}

const worker = () => new SettlementWorker({ pool: db.pool, riskClient: new ResilientRiskClient(), spool: null, config: { batchSize: 5 } });
async function drain(w = worker()) {
  while ((await w.runOnce()) > 0) {
    /* keep going */
  }
}

/**
 * Prior settled payments (one per day, `amount` KES, escrow `status`, matured) and, optionally,
 * their clean-maturity credits. Returns the receipts.
 */
async function seedHistory(agentId: string, n: number, credited: boolean, amount = 1000, status = 'HELD'): Promise<string[]> {
  const receipts: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rcpt('HS');
    receipts.push(r);
    await db.pool.query(
      `WITH t AS (
         INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, timestamp, counterparty_hash)
         VALUES ($1, $2::text, 'k1:x', $4, 'C2B', NOW() - make_interval(days => $3), 'k1:' || $2::text) RETURNING transaction_id)
       INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds)
       SELECT transaction_id, 1, $5, NOW() - interval '1 hour', 3600 FROM t`,
      [agentId, r, i + 1, amount, status]
    );
    if (credited) {
      await db.pool.query(
        `INSERT INTO agent_trust_events (agent_id, cause, ref, old_rating, new_rating, delta) VALUES ($1, 'HOLD_MATURED_CLEAN', $2, 0.5, 0.5, 0)`,
        [agentId, r]
      );
    }
  }
  return receipts;
}

const rating = async (agentId: string) => Number((await db.pool.query(`SELECT agent_trust_rating FROM sales_agents WHERE agent_id = $1`, [agentId])).rows[0].agent_trust_rating);
const escrowOf = async (receipt: string) =>
  (await db.pool.query(
    `SELECT e.*, EXTRACT(EPOCH FROM (e.release_due_at - NOW()))::float8 AS due_in FROM escrow_accounts e
       JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = $1`,
    [receipt]
  )).rows[0];
const trustEvents = async (agentId: string) =>
  (await db.pool.query(`SELECT cause, ref, old_rating::float8 AS old, new_rating::float8 AS new FROM agent_trust_events WHERE agent_id = $1 AND delta <> 0 ORDER BY created_at, ref`, [agentId])).rows;

describeDb('risk-adaptive escrow hold and trust scores (real Postgres)', () => {
  beforeAll(async () => {
    db = await createTestDb('sm_trust');
    await db.pool.query(INIT_SQL);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });
  beforeEach(async () => {
    quiet();
    await db.pool.query(
      `TRUNCATE agent_trust_events, trust_scores, trust_config_snapshots, security_events, escrow_accounts, verification_events,
                transactions, mpesa_callbacks, sales_agents, retail_outlets, users CASCADE`
    );
  });

  it('AC: R_eff 0.98 vs 0.50, same adjudicated low-risk CLEAR at the typical amount → ≈ 1.03 h vs ≈ 3.82 h; rows recomputable', async () => {
    const [a, b] = [await seedAgent(db.pool, 'TRUSTA'), await seedAgent(db.pool, 'TRUSTB')];
    await seedHistory(a, 20, true); // mature: 20 clean holds over 20 days, KES 20,000
    await seedHistory(b, 20, false);
    await db.pool.query(`UPDATE sales_agents SET agent_trust_rating = CASE agent_id WHEN $1::uuid THEN 0.98 ELSE 0.5 END`, [a]);
    mlStub(() => ({ decision: 'CLEAR', layer2_adjudicated: true, xgb_probability: 0.02, triggered_layer: 2 }));
    const [ra, rb] = [rcpt('ACA'), rcpt('ACB')];
    await enqueue(ra, 'TRUSTA');
    await enqueue(rb, 'TRUSTB');
    await drain();

    const [ea, eb] = [await escrowOf(ra), await escrowOf(rb)];
    expect(ea).toMatchObject({ escrow_status: 'HELD', hold_seconds: 3702, hold_period_hours: 2, quarantine_reason: null });
    expect(eb).toMatchObject({ escrow_status: 'HELD', hold_seconds: 13738, hold_period_hours: 4 });
    expect(ea.due_in).toBeGreaterThan(3702 - 60);
    expect(ea.due_in).toBeLessThanOrEqual(3702);

    const { rows } = await db.pool.query(
      `SELECT t.mpesa_receipt_id AS r, s.*, s.final_trust_index::text AS st, c.params
         FROM trust_scores s JOIN verification_events v USING (verification_id) JOIN transactions t USING (transaction_id)
         JOIN trust_config_snapshots c USING (config_hash) ORDER BY t.mpesa_receipt_id`
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const w = row.params.txWeight;
      const p = Number(row.p_used);
      const r = Number(row.agent_rating_used);
      expect(Number(row.transaction_trust)).toBeCloseTo(1 - p, 6);
      expect(round6((1 - p) ** w * r ** (1 - w)).toFixed(6)).toBe(row.st);
      const s = Number(row.st);
      const { holdMinHours: lo, holdMaxHours: hi, gamma, kappa } = row.params;
      expect(row.hold_seconds).toBe(Math.round(Math.min(hi, (lo + (hi - lo) * (1 - s) ** gamma) * Math.max(1, Number(row.amount_factor)) ** kappa) * 3600));
      expect(row).toMatchObject({ p_source: 'xgb', amount_factor: '1.000000', velocity_score: '0.5000', split_ratio_score: '0.1000' });
    }
    expect(rows.find((x) => x.r === ra)).toMatchObject({ st: '0.980000', agent_rating_used: '0.980000', hold_reason: 'transaction' });
    expect(rows.find((x) => x.r === rb)).toMatchObject({ st: '0.800846', agent_rating_used: '0.500000', hold_reason: 'agent' });
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_config_snapshots`)).toBe(1);
    expect(Number((await db.pool.query(`SELECT scored_txn_count FROM sales_agents WHERE agent_id = $1`, [a])).rows[0].scored_txn_count)).toBe(1);
    // The ML score never moves the rating.
    expect(await rating(a)).toBe(0.98);
    expect(await rating(b)).toBe(0.5);

    const stats = await trustStats(db.pool);
    expect(stats).toMatchObject({ scored24h: 2, holdReason24h: { transaction: 1, agent: 1 } });
    expect(stats.avgTrustIndex24h).toBeCloseTo((0.98 + 0.800846) / 2, 5);
  });

  it('new agent: rating 1.0 but not mature → R_eff 0.85; trust freeze → QUARANTINED (trust_below_threshold, 72 h)', async () => {
    const agent = await seedAgent(db.pool, 'NEWAG');
    await db.pool.query(`UPDATE sales_agents SET agent_trust_rating = 1 WHERE agent_id = $1`, [agent]);
    mlStub(() => ({ decision: 'CLEAR', layer2_adjudicated: true, xgb_probability: 0.02 }));
    const r1 = rcpt('NA');
    await enqueue(r1, 'NEWAG');
    await drain();
    expect((await db.pool.query(`SELECT agent_rating_used::text AS r FROM trust_scores`)).rows[0].r).toBe('0.850000');

    await db.pool.query(`UPDATE sales_agents SET agent_trust_rating = 0.5 WHERE agent_id = $1`, [agent]);
    mlStub(() => ({ decision: 'CLEAR', layer2_adjudicated: true, xgb_probability: 0.4 }));
    const r2 = rcpt('NB');
    await enqueue(r2, 'NEWAG');
    await drain();
    expect(await escrowOf(r2)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'trust_below_threshold', hold_period_hours: 72, security_hold: false });
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_scores WHERE final_trust_index = 0.568063`)).toBe(1);
    expect((await trustStats(db.pool)).quarantinedByReason).toEqual({ trust_below_threshold: 1 });
  });

  it('REVIEW → QUARANTINED with a trust row; fail-safe → QUARANTINED, no trust row', async () => {
    await seedAgent(db.pool, 'REVAG');
    mlStub(() => ({ decision: 'REVIEW' }));
    const r1 = rcpt('RV');
    await enqueue(r1, 'REVAG');
    await drain();
    mlStub(() => 'down');
    const r2 = rcpt('FS');
    await enqueue(r2, 'REVAG');
    await drain();
    expect(await escrowOf(r1)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'model_decision' });
    expect(await escrowOf(r2)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'fail_safe' });
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_scores`)).toBe(1);
  });

  it('AC: a retried settlement leaves one trust row and no duplicated rating change; a matured clean hold credits exactly once', async () => {
    const agent = await seedAgent(db.pool, 'RETRY');
    mlStub(() => ({ decision: 'CLEAR' }));
    const [r1, r2] = [rcpt('RT'), rcpt('RU')];
    await enqueue(r1, 'RETRY');
    await enqueue(r2, 'RETRY');

    // A worker claims, settles one row and "dies"; the rest is reclaimed; the zombie is fenced out.
    const stolen = await claimBatch(db.pool, 2, 300_000, 5);
    await worker().process(stolen[0]);
    await db.pool.query(`UPDATE mpesa_callbacks SET claimed_at = NOW() - interval '6 minutes' WHERE status = 'PROCESSING'`);
    await drain();
    expect(await worker().process(stolen[1])).toBe('lease_lost');
    // The settlement itself re-run on the same transaction: a no-op.
    const { rows: [t] } = await db.pool.query(`SELECT transaction_id FROM transactions WHERE mpesa_receipt_id = $1`, [r1]);
    const again = await new EscrowService(db.pool).processSettlement(t.transaction_id, await new ResilientRiskClient().evaluate({
      transaction_id: r1, transaction: { agent_id: agent, timestamp: new Date().toISOString(), amount: 1000, counterparty_id: 'k1:x' }, history: [],
    }), '100.00');
    expect(again).toEqual({ escrowStatus: 'HELD', created: false });
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_scores`)).toBe(2);
    expect(Number((await db.pool.query(`SELECT scored_txn_count FROM sales_agents`)).rows[0].scored_txn_count)).toBe(2);
    expect(await count(db.pool, `SELECT count(*) AS n FROM agent_trust_events`)).toBe(0);

    // Not matured yet → nothing; matured → +β once, however often the sweep runs.
    const w = worker();
    expect(await w.creditMaturedHolds()).toBe(0);
    await db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - interval '1 minute'`);
    await db.pool.query(
      `INSERT INTO security_events (event_type, mpesa_receipt_id, incoming_hash, detail) VALUES ('PAYMENT_REVERSED', $1, 'x', 'x')`,
      [r2]
    ); // a matured hold with a security event is never credited
    await w.housekeeping(true); // the sweep runs from the worker's own housekeeping
    expect(await trustEvents(agent)).toEqual([{ cause: 'HOLD_MATURED_CLEAN', ref: r1, old: 0.5, new: 0.525 }]);
    expect(await w.creditMaturedHolds()).toBe(0);
    await w.housekeeping(true);
    expect(await trustEvents(agent)).toEqual([{ cause: 'HOLD_MATURED_CLEAN', ref: r1, old: 0.5, new: 0.525 }]);
    expect(await rating(agent)).toBe(0.525);
  });

  it('daily cap: at most TRUST_MAX_CREDITS_PER_DAY maturity credits per agent per day (the rest wait); statement confirmations are exempt', async () => {
    const agent = await seedAgent(db.pool, 'CAPAG');
    for (let i = 0; i < 10; i++) {
      await db.pool.query(
        `INSERT INTO agent_trust_events (agent_id, cause, ref, old_rating, new_rating, delta) VALUES ($1, 'HOLD_MATURED_CLEAN', $2, 0.5, 0.5, 0)`,
        [agent, `CAP${i}`]
      );
    }
    mlStub(() => ({ decision: 'CLEAR' }));
    const [r, s] = [rcpt('CP'), rcpt('CS')];
    await enqueue(r, 'CAPAG');
    await enqueue(s, 'CAPAG');
    await drain();
    await db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - interval '1 minute'`);
    expect(await withTransaction(db.pool, (tx) => creditReceipt(tx, 'STATEMENT_CONFIRMED', s))).toBe(0.525);
    expect(await worker().creditMaturedHolds()).toBe(0);
    await db.pool.query(`UPDATE agent_trust_events SET created_at = NOW() - interval '1 day'`); // a new day
    expect(await worker().creditMaturedHolds()).toBe(1); // r only: s already has its one credit
    expect((await trustEvents(agent)).map((e) => `${e.cause}:${e.ref}`).sort()).toEqual([`HOLD_MATURED_CLEAN:${r}`, `STATEMENT_CONFIRMED:${s}`]);
  });

  it('credits: one per receipt across both kinds; a RELEASED matured hold earns it; never a zero-delta credit at R = 1', async () => {
    const agent = await seedAgent(db.pool, 'CRDAG');
    const [confirmed, released] = await seedHistory(agent, 2, false);
    await db.pool.query(`UPDATE escrow_accounts e SET escrow_status = 'RELEASED' FROM transactions t WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1`, [released]);
    const credit = (cause: 'STATEMENT_CONFIRMED' | 'HOLD_MATURED_CLEAN', r: string) => withTransaction(db.pool, (tx) => creditReceipt(tx, cause, r));
    expect(await credit('STATEMENT_CONFIRMED', confirmed)).toBe(0.525);
    expect(await credit('HOLD_MATURED_CLEAN', confirmed)).toBeNull();
    expect(await worker().creditMaturedHolds()).toBe(1); // the RELEASED one only
    expect((await trustEvents(agent)).map((e) => `${e.cause}:${e.ref}`).sort()).toEqual([`HOLD_MATURED_CLEAN:${released}`, `STATEMENT_CONFIRMED:${confirmed}`]);
    // Maturity counts credited receipts that are still clean: a later reversal stops it counting.
    expect((await agentMaturity(db.pool, agent)).cleanHolds).toBe(2);
    await db.pool.query(`INSERT INTO security_events (event_type, mpesa_receipt_id, incoming_hash, detail) VALUES ('PAYMENT_REVERSED', $1, 'x', 'x')`, [confirmed]);
    expect(await agentMaturity(db.pool, agent)).toEqual({ cleanHolds: 1, distinctDays: 1, settledValue: 1000 });

    const top = await seedAgent(db.pool, 'TOPAG');
    const [x] = await seedHistory(top, 1, false);
    await db.pool.query(`UPDATE sales_agents SET agent_trust_rating = 1 WHERE agent_id = $1`, [top]);
    expect(await credit('STATEMENT_CONFIRMED', x)).toBeNull();
    expect(await worker().creditMaturedHolds()).toBe(0);
    expect(await count(db.pool, `SELECT count(*) AS n FROM agent_trust_events WHERE agent_id = $1`, [top])).toBe(0);
  });

  it('median: only payments that cleared count (quarantined, security-held or reversed ones cannot inflate it)', async () => {
    const agent = await seedAgent(db.pool, 'MEDAG');
    await seedHistory(agent, 5, false, 100); // five cleared KES 100 sales
    await seedHistory(agent, 3, false, 50_000, 'QUARANTINED'); // never-clearing self-payments
    const [held] = await seedHistory(agent, 1, false, 50_000);
    await db.pool.query(`UPDATE escrow_accounts e SET security_hold = TRUE FROM transactions t WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1`, [held]);
    const [reversed] = await seedHistory(agent, 1, false, 50_000);
    await db.pool.query(`INSERT INTO security_events (event_type, mpesa_receipt_id, incoming_hash, detail) VALUES ('PAYMENT_REVERSED', $1, 'x', 'x')`, [reversed]);
    expect(await medianSettledAmount(db.pool, { agentId: agent, at: new Date(), excludeReceipt: 'NONE', days: 30 })).toEqual({ median: 100, count: 5 });
  });

  it('penalty: −0.15 once per security-hold event type and receipt (HELD, RELEASED, before or after settlement); operator undo', async () => {
    const agent = await seedAgent(db.pool, 'PENAG');
    mlStub(() => ({ decision: 'CLEAR' }));
    const [held, released, early] = [rcpt('PH'), rcpt('PR'), rcpt('PE')];
    await enqueue(held, 'PENAG');
    await enqueue(released, 'PENAG');
    await enqueue(early, 'PENAG');
    // A mutation alarm before settlement: no agent yet → the settlement applies the penalty.
    await recordPayloadMutation(db.pool, early, 'k1:a', 'k1:b');
    await drain();
    expect(await escrowOf(early)).toMatchObject({ escrow_status: 'QUARANTINED', security_hold: true, quarantine_reason: 'security_hold' });
    expect(await rating(agent)).toBe(0.35);

    await db.pool.query(`UPDATE escrow_accounts e SET escrow_status = 'RELEASED' FROM transactions t WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1`, [released]);
    for (const [receipt, stmt] of [[held, 'stmt:1'], [held, 'stmt:2'], [released, 'stmt:1']]) {
      await withTransaction(db.pool, async (tx) => {
        await insertSecurityEvent(tx, { type: 'PAYMENT_REVERSED', receipt, originalHash: null, incomingHash: stmt, detail: 'reversal' });
        await securityHoldReceipt(tx, receipt);
      });
    }
    await recordPayloadMutation(db.pool, early, 'k1:a', 'k1:c'); // same type, same receipt: no second penalty
    expect(await escrowOf(released)).toMatchObject({ escrow_status: 'RELEASED' });
    expect((await trustEvents(agent)).map((e) => e.ref).sort()).toEqual([`PAYLOAD_MUTATION:${early}`, `PAYMENT_REVERSED:${held}`, `PAYMENT_REVERSED:${released}`].sort());
    expect(await rating(agent)).toBe(0.05);

    // Operator undoes a false alarm (idempotent per agent and ref), audited.
    const undo = (agentId: string) => withTransaction(db.pool, (tx) =>
      operatorAdjust(tx, { agentId, delta: 0.15, ref: 'T-1', detail: 'clock-skew false alarm' }));
    expect(await findAgent(db.pool, ' penag ')).toBe(agent);
    expect(await undo(agent)).toBe(0.2);
    expect(await undo(agent)).toBeNull();
    expect(await rating(agent)).toBe(0.2);
    // The same ticket id on another agent is that agent's own adjustment.
    const other = await seedAgent(db.pool, 'PENAG2');
    expect(await undo(other)).toBe(0.65);
    expect((await db.pool.query(`SELECT ref FROM agent_trust_events WHERE cause = 'OPERATOR_ADJUST'`)).rows.map((x) => x.ref).sort())
      .toEqual([`operator:${agent}:T-1`, `operator:${other}:T-1`].sort());
    await expect(withTransaction(db.pool, (tx) => operatorAdjust(tx, { agentId: agent, delta: 0.1, ref: 'r'.repeat(155), detail: 'x' }))).rejects.toThrow(/longer than 154/);
  });

  it('concurrency: two workers, a maturity sweep and penalties on one agent serialise — no deadlock, no lost update', async () => {
    const agent = await seedAgent(db.pool, 'CONAG');
    mlStub(() => ({ decision: 'CLEAR' }));
    const early = Array.from({ length: 5 }, () => rcpt('CE'));
    for (const r of early) await enqueue(r, 'CONAG');
    await drain();
    await db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - interval '1 minute'`);
    for (let i = 0; i < 20; i++) await enqueue(rcpt('CN'), 'CONAG');

    const [a, b] = [worker(), worker()];
    await Promise.all([
      drain(a),
      drain(b),
      a.creditMaturedHolds(),
      recordPayloadMutation(db.pool, early[0], 'k1:a', 'k1:b'),
      recordPayloadMutation(db.pool, early[1], 'k1:a', 'k1:b'),
    ]);
    await a.creditMaturedHolds();

    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks WHERE status = 'SETTLED'`)).toBe(25);
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_scores`)).toBe(25);
    expect(Number((await db.pool.query(`SELECT scored_txn_count FROM sales_agents`)).rows[0].scored_txn_count)).toBe(25);
    // Every change starts from the previous one's result: the events form one chain ending at R.
    const events = await trustEvents(agent);
    expect(events.filter((e) => e.cause === 'SECURITY_PENALTY')).toHaveLength(2);
    let r = 0.5;
    const left = [...events];
    while (left.length) {
      const i = left.findIndex((e) => e.old === r);
      expect(i).toBeGreaterThanOrEqual(0);
      r = left.splice(i, 1)[0].new;
    }
    expect(await rating(agent)).toBe(r);
  });

  it('self-heal: fail-safe → no trust row; RESCORE writes it and promotes for T_hold — or freezes (model-made, never re-scored)', async () => {
    const agent = await seedAgent(db.pool, 'HEALAG');
    mlStub(() => 'down');
    const [ok, frozen] = [rcpt('SH'), rcpt('SF')];
    await enqueue(ok, 'HEALAG');
    await drain();
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_scores`)).toBe(0);

    mlStub(() => ({ decision: 'CLEAR', layer2_adjudicated: true, xgb_probability: 0.02 }));
    const rescorer = new RescoreWorker({ pool: db.pool, riskClient: new ResilientRiskClient() });
    expect(await rescorer.runOnce()).toBe(1);
    const e = await escrowOf(ok);
    expect(e).toMatchObject({ escrow_status: 'HELD', quarantine_reason: null });
    const { rows: [ts] } = await db.pool.query(
      `SELECT s.hold_seconds, v.kind FROM trust_scores s JOIN verification_events v USING (verification_id)`
    );
    expect(ts).toEqual({ hold_seconds: e.hold_seconds, kind: 'RESCORE' });

    // A low-rated agent: the recovered CLEAR is frozen, and self-heal never touches it again.
    mlStub(() => 'down');
    await enqueue(frozen, 'HEALAG');
    await drain();
    await db.pool.query(`UPDATE sales_agents SET agent_trust_rating = 0.1 WHERE agent_id = $1`, [agent]);
    mlStub(() => ({ decision: 'CLEAR', layer2_adjudicated: true, xgb_probability: 0.02 }));
    expect(await rescorer.runOnce()).toBe(1);
    expect(await escrowOf(frozen)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'trust_below_threshold' });
    await db.pool.query(`UPDATE escrow_accounts SET next_rescore_at = NOW() - interval '1 hour'`);
    expect(await rescorer.runOnce()).toBe(0);
    expect(await count(db.pool, `SELECT count(*) AS n FROM trust_scores`)).toBe(2);
  });
});
