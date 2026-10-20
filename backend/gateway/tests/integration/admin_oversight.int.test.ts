/**
 * Merchant admin risk queue against real Postgres (spec gh-14), over HTTP: the list carries the run's
 * risk scores and SHAP (none for security holds or pre-010 events); release / keep / payout resolve
 * need MERCHANT_ADMIN, a 10–280 character note and the admin's PIN; each is state-guarded and commits
 * exactly one audit row, also when two admins submit at once. No override calls B2C. SMS is faked.
 */

import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../../src/auth/auth.service';
import { hashPin } from '../../src/auth/credentials';
import { LoginThrottle } from '../../src/auth/throttle';
import { signAccessToken } from '../../src/auth/tokens';
import { AdminController } from '../../src/controllers/admin.controller';
import { upsertCredential } from '../../src/repositories/auth.repository';
import { promoteToHeld } from '../../src/repositories/escrow.repository';
import { exhaustStatusChecks } from '../../src/repositories/payout.repository';
import { createAdminRouter } from '../../src/routes/admin.routes';
import { FrozenPayoutService } from '../../src/services/frozen.service';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { PayoutService } from '../../src/services/payout.service';
import type { RiskEvaluationResponse } from '../../src/services/risk_client.service';
import { RescoreWorker } from '../../src/workers/rescore.worker';
import { listen, type TestServer } from '../support/http';
import { MemoryThrottleStore } from '../support/memory-store';
import { count, createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

const PIN = '4826';
const NOTE = 'Checked the till slip with the outlet manager.';
const SHAP = [
  { feature: 'velocity_v_i', attribution: 1.4, value: 12 },
  { feature: 'split_ratio_r_s', attribution: 0.6, value: 0.5 },
  { feature: 'agent_zscore', attribution: -0.3, value: 0.1 },
];
const UNITS = 'xgboost_log_odds_margin_uncalibrated';

describeDb('admin risk queue (real Postgres)', () => {
  let db: TestDb;
  let srv: TestServer;
  let b2c: { b2cPayment: jest.Mock; transactionStatus: jest.Mock };

  beforeAll(async () => {
    db = await createTestDb('sm_admin_q');
    await db.pool.query(INIT_SQL);
    const metrics = new GatewayMetrics();
    const auth = new AuthService({ db: db.pool, throttle: new LoginThrottle(new MemoryThrottleStore()), metrics });
    b2c = { b2cPayment: jest.fn(), transactionStatus: jest.fn() };
    const payouts = new PayoutService({ db: db.pool, b2c, auth, metrics, notifier: { send: async () => undefined } });
    const service = new FrozenPayoutService({
      db: db.pool,
      auth,
      payouts,
      metrics,
      notifier: { send: async () => undefined },
      config: { frozenEscrowSlaHours: 72, unresolvedPayoutSlaHours: 24, reminderHours: [8, 20] },
    });
    const app = express();
    app.use('/api/v1/admin', createAdminRouter(new AdminController(service)));
    srv = await listen(app);
  });
  afterAll(async () => {
    await srv?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE payouts, escrow_accounts, verification_events, transactions, security_events CASCADE`);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    expect(b2c.b2cPayment).not.toHaveBeenCalled();
  });

  async function user(role: 'MERCHANT_ADMIN' | 'SALES_AGENT') {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const { rows: [u] } = await db.pool.query(
      `INSERT INTO users (full_name, phone_number, role) VALUES ('Ops', $1, $2) RETURNING user_id`,
      [phone, role]
    );
    await upsertCredential(db.pool, u.user_id, await hashPin(PIN), { mustChange: false, oneTimeExpiresAt: null });
    const token = (await signAccessToken({ userId: u.user_id, role, pinChangeRequired: false })).token;
    return { userId: u.user_id as string, token };
  }
  const admin = () => user('MERCHANT_ADMIN');

  async function agent() {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, `AG${crypto.randomBytes(4).toString('hex').toUpperCase()}`, phone);
    const { rows: [d] } = await db.pool.query(
      `INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW()) RETURNING destination_id`,
      [agentId, phone]
    );
    return { agentId, phone, destinationId: d.destination_id as string };
  }

  /** A QUARANTINED escrow with its INITIAL verification event (SHAP optional). */
  async function frozen(
    agentId: string,
    o: { shap?: boolean; failSafe?: boolean; securityHold?: boolean; dueInHours?: number; reason?: string; layer2?: boolean } = {}
  ) {
    const receipt = `R${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, receipt]
    );
    await db.pool.query(
      `INSERT INTO verification_events (transaction_id, isolation_forest_score, xgboost_fraud_prob, model_version, decision, is_fail_safe,
                                        fail_safe_cause, layer2_adjudicated, shap_features, shap_units, evaluated_at)
       VALUES ($1, $2, $3, $4, 'QUARANTINE', $5, $8, $9, $6::jsonb, $7, NOW() - interval '1 hour')`,
      [
        t.transaction_id,
        o.failSafe ? null : 0.71,
        o.failSafe ? null : 0.93,
        o.failSafe ? 'v1.0.0-failsafe' : 'v1.0.0',
        !!o.failSafe,
        o.shap ? JSON.stringify(SHAP) : null,
        o.shap ? UNITS : null,
        o.failSafe ? 'service_unavailable' : null,
        o.failSafe ? null : (o.layer2 ?? true),
      ]
    );
    const reason = o.reason ?? (o.securityHold ? 'security_hold' : o.failSafe ? 'fail_safe' : 'model_decision');
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds, security_hold, quarantine_reason)
       VALUES ($1, 25.50, 'QUARANTINED', NOW() + make_interval(hours => $2::int), 3600, $3, $4) RETURNING escrow_id`,
      [t.transaction_id, o.dueInHours ?? -1, !!o.securityHold, reason]
    );
    return { escrowId: e.escrow_id as string, receipt, transactionId: t.transaction_id as string };
  }

  const row = async (id: string) =>
    (await db.pool.query(
      `SELECT escrow_status, quarantine_reason, release_due_at, reviewed_at, sla_escalated_at, frozen_at, rescore_claim_token FROM escrow_accounts WHERE escrow_id = $1`,
      [id]
    )).rows[0];
  const audits = () => count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'ESCROW_OVERRIDE'`);
  const post = (path: string, token: string | null, body: unknown) =>
    srv.request('POST', `/api/v1/admin${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
  const list = async (token: string) => (await srv.request('GET', '/api/v1/admin/frozen-payouts', { headers: { Authorization: `Bearer ${token}` } })).body;

  it('list: the run behind each quarantine with its SHAP; none recorded (pre-010 / fail-safe); never for a security hold', async () => {
    const ops = await admin();
    const a = await agent();
    const model = await frozen(a.agentId, { shap: true });
    const legacy = await frozen(a.agentId);
    const failSafe = await frozen(a.agentId, { failSafe: true });
    const held = await frozen(a.agentId, { shap: true, securityHold: true });
    await db.pool.query(`UPDATE escrow_accounts SET frozen_at = NOW() - interval '80 hours' WHERE escrow_id = $1`, [model.escrowId]);
    const body = await list(ops.token);
    const by = (id: string) => body.escrows.find((e: any) => e.escrow_id === id);
    expect(by(model.escrowId)).toMatchObject({
      overdue: true,
      reviewed_at: null,
      risk: { decision: 'QUARANTINE', iso_score: 0.71, xgb_prob: 0.93, model_version: 'v1.0.0', shap: SHAP, units: UNITS },
    });
    expect(by(legacy.escrowId).risk).toMatchObject({ decision: 'QUARANTINE', shap: null, units: null });
    expect(by(failSafe.escrowId).risk).toMatchObject({ iso_score: null, shap: null, model_version: 'v1.0.0-failsafe' });
    expect(by(held.escrowId)).toMatchObject({ security_hold: true, risk: { shap: null, units: null } });
    expect(body).toMatchObject({ totals: { escrows: 4, payouts: 0 }, overdue: { escrows: 1, payouts: 0 }, total_available: 4 });
  });

  it('list: SHAP only when XGBoost made the quarantining decision (not a trust freeze, not a layer-1 quarantine)', async () => {
    const ops = await admin();
    const a = await agent();
    const trust = await frozen(a.agentId, { shap: true, reason: 'trust_below_threshold' });
    const layer1 = await frozen(a.agentId, { shap: true, layer2: false });
    const body = await list(ops.token);
    const by = (id: string) => body.escrows.find((e: any) => e.escrow_id === id);
    expect(by(trust.escrowId).risk).toMatchObject({ model_version: 'v1.0.0', shap: null, units: null });
    expect(by(layer1.escrowId).risk).toMatchObject({ model_version: 'v1.0.0', shap: null, units: null });
  });

  it('list: risk is the latest verification event (a later RESCORE over the INITIAL fail-safe)', async () => {
    const ops = await admin();
    const a = await agent();
    const e = await frozen(a.agentId, { failSafe: true });
    await db.pool.query(`UPDATE escrow_accounts SET quarantine_reason = 'model_decision' WHERE escrow_id = $1`, [e.escrowId]);
    await db.pool.query(
      `INSERT INTO verification_events (transaction_id, isolation_forest_score, xgboost_fraud_prob, model_version, decision, layer2_adjudicated, kind, shap_features, shap_units)
       VALUES ($1, 0.6, 0.88, 'v1.1.0', 'REVIEW', TRUE, 'RESCORE', $2::jsonb, $3)`,
      [e.transactionId, JSON.stringify(SHAP), UNITS]
    );
    const item = (await list(ops.token)).escrows.find((x: any) => x.escrow_id === e.escrowId);
    expect(item.risk).toEqual({ decision: 'REVIEW', iso_score: 0.6, xgb_prob: 0.88, model_version: 'v1.1.0', shap: SHAP, units: UNITS });
  });

  it('keep held is never undone by the self-heal: a kept fail-safe that rescores CLEAR stays QUARANTINED and reviewed', async () => {
    const ops = await admin();
    const a = await agent();
    const kept = await frozen(a.agentId, { failSafe: true });
    const control = await frozen(a.agentId, { failSafe: true });
    expect((await post(`/escrows/${kept.escrowId}/keep`, ops.token, { pin: PIN, note: NOTE })).status).toBe(200);
    const clear = (transactionId: string): RiskEvaluationResponse => ({
      transaction_id: transactionId,
      isolation_score: 0.1,
      xgb_probability: 0.01,
      model_version: 'v1.0.0',
      model_sha256: 'b'.repeat(64),
      decision: 'CLEAR',
      triggered_layer: 1,
      layer2_adjudicated: false,
      reason: 'stub',
      latency_ms: 1,
      evaluated_at: new Date().toISOString(),
      is_fail_safe: false,
      fail_safe_cause: null,
      feature_vector: { velocity_v_i: 0.5, split_ratio_r_s: 0.1, entropy_gaps: 1.2, agent_zscore: 0.3, amount_to_median_ratio: 1, recipient_reuse_count: 0 },
    });
    const evaluate = jest.fn(async (req: { transaction_id: string }) => clear(req.transaction_id));
    const worker = new RescoreWorker({ pool: db.pool, riskClient: { evaluate, isAvailable: () => true } as any, config: { batchSize: 10 } });
    expect(await worker.runOnce()).toBe(1); // only the control is eligible
    expect(evaluate.mock.calls.map(([r]) => r.transaction_id)).toEqual([control.receipt]);
    expect(await row(kept.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', reviewed_at: expect.any(Date) });
    const rescores = (txId: string) => count(db.pool, `SELECT count(*) AS n FROM verification_events WHERE transaction_id = $1 AND kind = 'RESCORE'`, [txId]);
    expect(await rescores(kept.transactionId)).toBe(0);
    expect(await rescores(control.transactionId)).toBe(1);
  });

  it('release: QUARANTINED → HELD (due max(original, now)), reason and rescore lease cleared, one audit row; leaves the queue; repeat → 409', async () => {
    const ops = await admin();
    const a = await agent();
    const past = await frozen(a.agentId, { shap: true, dueInHours: -5 });
    const future = await frozen(a.agentId, { dueInHours: 10 });
    await db.pool.query(`UPDATE escrow_accounts SET rescore_claim_token = gen_random_uuid(), rescore_claimed_at = NOW() WHERE escrow_id = $1`, [past.escrowId]);
    const futureDue = (await row(future.escrowId)).release_due_at as Date;

    const res = await post(`/escrows/${past.escrowId}/release`, ops.token, { pin: PIN, note: `  ${NOTE}  ` });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.escrow).toMatchObject({ escrow_id: past.escrowId, status: 'HELD', reviewed_at: null });
    const r = await row(past.escrowId);
    expect(r).toMatchObject({ escrow_status: 'HELD', quarantine_reason: null, frozen_at: null, rescore_claim_token: null });
    expect(Math.abs(r.release_due_at.getTime() - Date.now())).toBeLessThan(60_000);
    expect((await post(`/escrows/${future.escrowId}/release`, ops.token, { pin: PIN, note: NOTE })).status).toBe(200);
    expect((await row(future.escrowId)).release_due_at).toEqual(futureDue);

    const { rows: [ev] } = await db.pool.query(
      `SELECT subject_user_id, mpesa_receipt_id, detail FROM security_events WHERE event_type = 'ESCROW_OVERRIDE' AND mpesa_receipt_id = $1`,
      [past.receipt]
    );
    expect(ev.subject_user_id).toBe(ops.userId);
    expect(ev.detail).toContain(`released to HELD`);
    expect(ev.detail).toContain(`by admin ${ops.userId}. Note: ${NOTE}`);
    expect((await list(ops.token)).escrows).toEqual([]);

    expect(await post(`/escrows/${past.escrowId}/release`, ops.token, { pin: PIN, note: NOTE })).toMatchObject({ status: 409, body: { error: 'already_decided' } });
    expect(await audits()).toBe(2);
  });

  it('keep held: stays queued, overdue cleared and never escalated, "reviewed" recorded, one audit row; repeat → 409; release still possible', async () => {
    const ops = await admin();
    const a = await agent();
    const e = await frozen(a.agentId, { shap: true });
    await db.pool.query(`UPDATE escrow_accounts SET frozen_at = NOW() - interval '100 hours' WHERE escrow_id = $1`, [e.escrowId]);
    const res = await post(`/escrows/${e.escrowId}/keep`, ops.token, { pin: PIN, note: NOTE });
    expect(res.status).toBe(200);
    expect(res.body.escrow).toMatchObject({ status: 'QUARANTINED', reviewed_at: expect.any(String) });
    expect(await row(e.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', reviewed_at: expect.any(Date), sla_escalated_at: expect.any(Date) });
    const body = await list(ops.token);
    expect(body.escrows[0]).toMatchObject({ escrow_id: e.escrowId, overdue: false, reviewed_at: expect.any(String) });
    expect(body.overdue.escrows).toBe(0);
    expect(await post(`/escrows/${e.escrowId}/keep`, ops.token, { pin: PIN, note: NOTE })).toMatchObject({ status: 409, body: { error: 'already_decided' } });
    expect(await audits()).toBe(1);
    expect((await post(`/escrows/${e.escrowId}/release`, ops.token, { pin: PIN, note: NOTE })).status).toBe(200);
    expect(await row(e.escrowId)).toMatchObject({ escrow_status: 'HELD', reviewed_at: null });
    expect(await audits()).toBe(2);
  });

  it('security hold: read-only, both overrides → 409 security_hold, nothing changes', async () => {
    const ops = await admin();
    const a = await agent();
    const e = await frozen(a.agentId, { securityHold: true });
    const before = await row(e.escrowId);
    for (const action of ['release', 'keep']) {
      expect(await post(`/escrows/${e.escrowId}/${action}`, ops.token, { pin: PIN, note: NOTE })).toMatchObject({ status: 409, body: { error: 'security_hold' } });
    }
    expect(await row(e.escrowId)).toEqual(before);
    expect(await audits()).toBe(0);
  });

  it('two admins at once: exactly one state change and one audit row (release, and keep)', async () => {
    const [ops1, ops2] = await Promise.all([admin(), admin()]);
    const a = await agent();
    for (const action of ['release', 'keep']) {
      await db.pool.query(`TRUNCATE security_events`);
      const e = await frozen(a.agentId);
      const res = await Promise.all([ops1, ops2].map((o) => post(`/escrows/${e.escrowId}/${action}`, o.token, { pin: PIN, note: NOTE })));
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(res.find((r) => r.status === 409)!.body).toEqual({ error: 'already_decided' });
      expect(await audits()).toBe(1);
    }
  });

  it('changed meanwhile: the rescore promoted it first → 409 already_decided, no audit row', async () => {
    const ops = await admin();
    const a = await agent();
    const e = await frozen(a.agentId, { failSafe: true });
    const token = crypto.randomUUID();
    await db.pool.query(`UPDATE escrow_accounts SET rescore_claim_token = $2 WHERE escrow_id = $1`, [e.escrowId, token]);
    expect(await promoteToHeld(db.pool, e.escrowId, token, 3600)).toBe(true);
    expect(await post(`/escrows/${e.escrowId}/release`, ops.token, { pin: PIN, note: NOTE })).toMatchObject({ status: 409, body: { error: 'already_decided' } });
    expect(await audits()).toBe(0);
  });

  it('note, PIN and id checks: 400 invalid_note before the PIN, 401 wrong PIN, 404 unknown or malformed id; nothing changes', async () => {
    const ops = await admin();
    const a = await agent();
    const e = await frozen(a.agentId);
    const before = await row(e.escrowId);
    for (const note of [undefined, '', 'too short', 'x'.repeat(281), 42]) {
      expect(await post(`/escrows/${e.escrowId}/release`, ops.token, { pin: PIN, note })).toMatchObject({ status: 400, body: { error: 'invalid_note' } });
    }
    expect(await post(`/escrows/${e.escrowId}/release`, ops.token, { pin: '0000', note: NOTE })).toMatchObject({ status: 401, body: { error: 'invalid_credentials' } });
    expect(await post(`/escrows/${e.escrowId}/keep`, ops.token, { note: NOTE })).toMatchObject({ status: 401 });
    expect(await post(`/escrows/${crypto.randomUUID()}/release`, ops.token, { pin: PIN, note: NOTE })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await post(`/escrows/not-a-uuid/release`, ops.token, { pin: PIN, note: NOTE })).toMatchObject({ status: 404 });
    expect((await srv.request('POST', `/api/v1/admin/escrows/${e.escrowId}/release`, { headers: { Authorization: `Bearer ${ops.token}` }, raw: '{bad' })).status).toBe(400);
    expect(await row(e.escrowId)).toEqual(before);
    expect(await audits()).toBe(0);
  });

  it('agent token → 403 on every admin route, no token → 401; no state change', async () => {
    const agentUser = await user('SALES_AGENT');
    const a = await agent();
    const e = await frozen(a.agentId);
    const before = await row(e.escrowId);
    const payoutId = crypto.randomUUID();
    for (const path of [`/escrows/${e.escrowId}/release`, `/escrows/${e.escrowId}/keep`, `/payouts/${payoutId}/resolve`]) {
      expect(await post(path, agentUser.token, { pin: PIN, note: NOTE, outcome: 'failed' })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
      expect((await post(path, null, { pin: PIN, note: NOTE })).status).toBe(401);
    }
    expect(await row(e.escrowId)).toEqual(before);
    expect(await audits()).toBe(0);
  });

  describe('unresolved payouts', () => {
    async function unresolved(a: Awaited<ReturnType<typeof agent>>, amount = 1500) {
      const payoutId = crypto.randomUUID();
      await db.pool.query(
        `INSERT INTO payouts (payout_id, agent_id, destination_id, msisdn, amount, gross_cents, carry_in_cents, carry_out_cents, disclosure_version,
                              consent_hash, accepted_at, status, status_attempts, next_status_at)
         VALUES ($1, $2, $3, $4, $5::int, $5::int * 100::bigint, 0, 0, '1', 'x', NOW(), 'UNKNOWN', 6, NOW() - interval '1 minute')`,
        [payoutId, a.agentId, a.destinationId, a.phone, amount]
      );
      await exhaustStatusChecks(db.pool, { maxAttempts: 6, leaseMs: 120_000 });
      return payoutId;
    }
    const events = (payoutId: string) =>
      db.pool.query(`SELECT detail FROM security_events WHERE event_type = 'PAYOUT_STATUS_CHANGED' AND detail LIKE $1 ORDER BY detected_at`, [`%${payoutId}%`]);

    it('paid with an M-Pesa receipt → PAID, event names the admin and the note, masked number; again → 409 not_unresolved', async () => {
      const ops = await admin();
      const a = await agent();
      const payoutId = await unresolved(a);
      const res = await post(`/payouts/${payoutId}/resolve`, ops.token, { pin: PIN, note: NOTE, outcome: 'paid', receipt: ' sgh12abc34 ' });
      expect(res.status).toBe(200);
      expect(res.body.payout).toMatchObject({ payout_id: payoutId, status: 'PAID', receipt: 'SGH12ABC34', msisdn: expect.stringMatching(/^2547\*+\d{2}$/) });
      expect(JSON.stringify(res.body)).not.toContain(a.phone);
      const { rows } = await events(payoutId);
      expect(rows[rows.length - 1].detail).toContain(`resolved by admin ${ops.userId}, note: ${NOTE}`);
      expect(await post(`/payouts/${payoutId}/resolve`, ops.token, { pin: PIN, note: NOTE, outcome: 'failed' })).toMatchObject({
        status: 409,
        body: { error: 'not_unresolved', status: 'PAID' },
      });
    });

    it('failed → FAILED; bad outcome / receipt → 400 before the PIN; unknown payout → 404', async () => {
      const ops = await admin();
      const a = await agent();
      const payoutId = await unresolved(a);
      expect(await post(`/payouts/${payoutId}/resolve`, ops.token, { pin: PIN, note: NOTE, outcome: 'paid', receipt: 'bad!' })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
      expect(await post(`/payouts/${payoutId}/resolve`, ops.token, { pin: PIN, note: NOTE, outcome: 'maybe' })).toMatchObject({ status: 400 });
      expect(await post(`/payouts/${payoutId}/resolve`, ops.token, { pin: PIN, note: 'short', outcome: 'failed' })).toMatchObject({ status: 400, body: { error: 'invalid_note' } });
      expect(await post(`/payouts/${crypto.randomUUID()}/resolve`, ops.token, { pin: PIN, note: NOTE, outcome: 'failed' })).toMatchObject({ status: 404 });
      expect((await post(`/payouts/${payoutId}/resolve`, ops.token, { pin: PIN, note: NOTE, outcome: 'failed' })).body.payout).toMatchObject({ status: 'FAILED' });
    });
  });
});
