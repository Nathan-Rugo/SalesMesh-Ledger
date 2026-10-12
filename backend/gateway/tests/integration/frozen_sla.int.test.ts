/**
 * Frozen-payout SLA escalation against real Postgres (spec gh-11, part 3c): one test per I/O-matrix
 * row, a concurrent double sweep that marks each item once, and GET /api/v1/admin/frozen-payouts over
 * HTTP. The freeze-clock trigger is generic (INSERT or UPDATE OF escrow_status); four writer paths are
 * tested: the settle insert, securityHoldReceipt, payout failure while security-held, rescore promote. SMS is faked; `now` is injected for
 * the daytime window, and freeze ages are set with SQL.
 */

import crypto from 'crypto';
import express from 'express';
import { signAccessToken } from '../../src/auth/tokens';
import { AdminController } from '../../src/controllers/admin.controller';
import { promoteToHeld } from '../../src/repositories/escrow.repository';
import { exhaustStatusChecks, resolvePayout } from '../../src/repositories/payout.repository';
import { securityHoldReceipt } from '../../src/repositories/security.repository';
import { createAdminRouter } from '../../src/routes/admin.routes';
import { digest, FrozenPayoutService } from '../../src/services/frozen.service';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { listen, type TestServer } from '../support/http';
import { createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

const NIGHT = new Date('2026-10-12T19:30:00Z'); // 22:30 Africa/Nairobi

describeDb('frozen-payout SLA escalation (real Postgres)', () => {
  let db: TestDb;
  let srv: TestServer;
  let metrics: GatewayMetrics;
  let service: FrozenPayoutService;
  let sent: Array<{ to: string; message: string }>;
  let warn: jest.SpyInstance;
  /** Each sweep runs an hour later (at most hourly), from 08:00 Nairobi. */
  let clock: number;
  const tick = () => new Date((clock += 3600_000));

  const make = () =>
    new FrozenPayoutService({
      db: db.pool,
      metrics,
      notifier: { send: async (to, message) => void sent.push({ to, message }) },
      config: { frozenEscrowSlaHours: 72, unresolvedPayoutSlaHours: 24, reminderHours: [8, 20] },
    });

  beforeAll(async () => {
    db = await createTestDb('sm_frozen');
    await db.pool.query(INIT_SQL);
    const app = express();
    app.use('/api/v1/admin', createAdminRouter(new AdminController({ list: () => service.list() } as FrozenPayoutService)));
    srv = await listen(app);
  });
  afterAll(async () => {
    await srv?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE payouts, escrow_accounts, verification_events, transactions, security_events CASCADE`);
    await db.pool.query(`DELETE FROM users WHERE role = 'MERCHANT_ADMIN'`);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    sent = [];
    clock = Date.parse('2026-10-12T04:00:00Z');
    metrics = new GatewayMetrics();
    service = make();
  });
  afterEach(async () => {
    await service.settled();
    jest.restoreAllMocks();
  });

  async function admin(o: { disabled?: boolean } = {}) {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const { rows: [u] } = await db.pool.query(
      `INSERT INTO users (full_name, phone_number, role, disabled_at) VALUES ('Ops', $1, 'MERCHANT_ADMIN', $2) RETURNING user_id`,
      [phone, o.disabled ? new Date() : null]
    );
    return { phone, userId: u.user_id as string };
  }

  async function agent() {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, `AG${crypto.randomBytes(4).toString('hex').toUpperCase()}`, phone);
    const { rows: [d] } = await db.pool.query(
      `INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW()) RETURNING destination_id`,
      [agentId, phone]
    );
    return { agentId, phone, destinationId: d.destination_id as string };
  }

  /** A settled payment and its escrow (the settle insert); returns the escrow and its receipt. */
  async function escrow(agentId: string, gross: string, o: { status?: string; payoutId?: string; securityHold?: boolean; reason?: string } = {}) {
    const receipt = `R${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, receipt]
    );
    const status = o.status ?? 'QUARANTINED';
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds, payout_id, security_hold, quarantine_reason)
       VALUES ($1, $2::numeric, $3, NOW(), 3600, $4, $5, $6) RETURNING escrow_id`,
      [t.transaction_id, gross, status, o.payoutId ?? null, o.securityHold ?? false, status === 'QUARANTINED' ? (o.reason ?? 'model_decision') : null]
    );
    return { escrowId: e.escrow_id as string, receipt };
  }

  /** A payout that exhausted its Transaction Status attempts → UNRESOLVED (by exhaustStatusChecks). */
  async function unresolved(a: { agentId: string; phone: string; destinationId: string }, amount = 1500) {
    const payoutId = crypto.randomUUID();
    await db.pool.query(
      `INSERT INTO payouts (payout_id, agent_id, destination_id, msisdn, amount, gross_cents, carry_in_cents, carry_out_cents, disclosure_version,
                            consent_hash, accepted_at, status, status_attempts, next_status_at)
       VALUES ($1, $2, $3, $4, $5::int, $5::int * 100::bigint, 0, 0, '1', 'x', NOW(), 'UNKNOWN', 6, NOW() - interval '1 minute')`,
      [payoutId, a.agentId, a.destinationId, a.phone, amount]
    );
    expect((await exhaustStatusChecks(db.pool, { maxAttempts: 6, leaseMs: 120_000 })).map((c) => c.payout.payoutId)).toEqual([payoutId]);
    return payoutId;
  }

  const escrowRow = async (id: string) => (await db.pool.query(`SELECT escrow_status, frozen_at, sla_escalated_at FROM escrow_accounts WHERE escrow_id = $1`, [id])).rows[0];
  const ageEscrow = (id: string, hours: number) =>
    db.pool.query(`UPDATE escrow_accounts SET frozen_at = NOW() - make_interval(hours => $2::int) WHERE escrow_id = $1`, [id, hours]);
  const agePayout = (id: string, hours: number) =>
    db.pool.query(`UPDATE payouts SET unresolved_at = NOW() - make_interval(hours => $2::int) WHERE payout_id = $1`, [id, hours]);
  async function sweep(now = tick(), s = service) {
    const r = await s.escalate(now);
    await s.settled();
    return r;
  }

  it('breach: an escrow past its SLA is marked once, admins get one digest (counts and KES only), metric +1', async () => {
    const ops = await admin();
    const ops2 = await admin();
    await admin({ disabled: true });
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '4200.00');
    await ageEscrow(escrowId, 73);
    expect(await sweep()).toEqual({ escrows: 1, escrowCents: 420_000, payouts: 0, payoutCents: 0 });
    expect((await escrowRow(escrowId)).sla_escalated_at).toBeInstanceOf(Date);
    const text = 'SalesMesh admin: 1 quarantined escrow (KES 4,200) passed their SLA. Review: GET /api/v1/admin/frozen-payouts.';
    expect(sent).toEqual([{ to: ops.phone, message: text }, { to: ops2.phone, message: text }]);
    expect(metrics.frozenSla).toEqual({ escalated: 1, alertsSent: 2, alertsFailed: 0 });
  });

  it('repeat sweep: an escalated item is not marked or alerted again', async () => {
    await admin();
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 100);
    await sweep();
    const first = (await escrowRow(escrowId)).sla_escalated_at;
    sent = [];
    expect(await sweep()).toEqual({ escrows: 0, escrowCents: 0, payouts: 0, payoutCents: 0 });
    expect(sent).toEqual([]);
    expect((await escrowRow(escrowId)).sla_escalated_at).toEqual(first);
    expect(metrics.frozenSla.escalated).toBe(1);
  });

  it('healed and refrozen: rescore promote clears the clock; a new quarantine starts a new spell that escalates again', async () => {
    await admin();
    const a = await agent();
    const { escrowId, receipt } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 80);
    await sweep();
    // Writer path: rescore promote (leaves QUARANTINED).
    const token = crypto.randomUUID();
    await db.pool.query(`UPDATE escrow_accounts SET rescore_claim_token = $2 WHERE escrow_id = $1`, [escrowId, token]);
    expect(await promoteToHeld(db.pool, escrowId, token, 3600)).toBe(true);
    expect(await escrowRow(escrowId)).toMatchObject({ escrow_status: 'HELD', frozen_at: null, sla_escalated_at: null });
    // Writer path: security hold (re-enters QUARANTINED).
    expect((await securityHoldReceipt(db.pool, receipt)).held).toBe(1);
    const re = await escrowRow(escrowId);
    expect(re).toMatchObject({ escrow_status: 'QUARANTINED', sla_escalated_at: null });
    expect(Date.now() - re.frozen_at.getTime()).toBeLessThan(60_000);
    sent = [];
    expect((await sweep())!.escrows).toBe(0); // the new spell is under its SLA
    await ageEscrow(escrowId, 73);
    expect((await sweep())!.escrows).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('under SLA: listed with overdue false, no alert; a status-only rewrite (QUARANTINED → QUARANTINED) keeps the clock', async () => {
    await admin();
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 71);
    const before = (await escrowRow(escrowId)).frozen_at;
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'QUARANTINED' WHERE escrow_id = $1`, [escrowId]);
    expect((await escrowRow(escrowId)).frozen_at).toEqual(before);
    expect((await sweep())!.escrows).toBe(0);
    expect(sent).toEqual([]);
    const list = await service.list();
    expect(list.escrows).toEqual([expect.objectContaining({ escrowId, overdue: false, escalatedAt: null })]);
  });

  it('no admins: items are still marked, and a WARN is logged', async () => {
    await admin({ disabled: true });
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 73);
    expect((await sweep())!.escrows).toBe(1);
    expect((await escrowRow(escrowId)).sla_escalated_at).toBeInstanceOf(Date);
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[FrozenSLA] no active MERCHANT_ADMIN to alert');
  });

  it('an SMS failure never blocks marking', async () => {
    await admin();
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 73);
    const failing = new FrozenPayoutService({ db: db.pool, metrics, notifier: { send: async () => { throw new Error('AT down'); } }, config: { reminderHours: [8, 20] } });
    expect((await sweep(tick(), failing))!.escrows).toBe(1);
    expect((await escrowRow(escrowId)).sla_escalated_at).toBeInstanceOf(Date);
    expect(metrics.frozenSla).toEqual({ escalated: 1, alertsSent: 0, alertsFailed: 1 });
  });

  it('unresolved payout: escalates after 24 h; resolved by payout:resolve (failed, security-held escrow → QUARANTINED) it leaves the list', async () => {
    await admin();
    const a = await agent();
    const payoutId = await unresolved(a);
    expect((await db.pool.query(`SELECT unresolved_at FROM payouts WHERE payout_id = $1`, [payoutId])).rows[0].unresolved_at).toBeInstanceOf(Date);
    const { escrowId } = await escrow(a.agentId, '15.00', { status: 'CLAIMED', payoutId, securityHold: true });
    expect((await escrowRow(escrowId)).frozen_at).toBeNull();
    expect((await sweep())!.payouts).toBe(0);
    await agePayout(payoutId, 25);
    expect(await sweep()).toEqual({ escrows: 0, escrowCents: 0, payouts: 1, payoutCents: 150_000 });
    expect(sent[0].message).toBe('SalesMesh admin: 1 unresolved payout (KES 1,500) passed their SLA. Review: GET /api/v1/admin/frozen-payouts.');
    expect((await service.list()).payouts).toEqual([expect.objectContaining({ payoutId, overdue: true })]);

    // Writer path: payout failure while security-held.
    expect((await resolvePayout(db.pool, payoutId, { paid: false }, 'ops')).kind).toBe('resolved');
    const list = await service.list();
    expect(list.payouts).toEqual([]);
    expect(await escrowRow(escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', sla_escalated_at: null });
    expect((await escrowRow(escrowId)).frozen_at).toBeInstanceOf(Date);
    expect(list.escrows).toEqual([expect.objectContaining({ escrowId, securityHold: true, quarantineReason: 'security_hold', overdue: false })]);
  });

  it('payouts off with an unrelated bad PAYOUT_* value: escalate() and list() still work', async () => {
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 73);
    process.env.PAYOUT_DISCLOSURE_VERSION = '9';
    try {
      const s = new FrozenPayoutService({ db: db.pool, metrics, notifier: { send: async () => undefined } });
      expect((await sweep(tick(), s))!.escrows).toBe(1);
      expect((await s.list()).escrows).toEqual([expect.objectContaining({ escrowId, overdue: true })]);
    } finally {
      delete process.env.PAYOUT_DISCLOSURE_VERSION;
    }
  });

  it('outside the alert window nothing is marked until the window opens', async () => {
    await admin();
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    await ageEscrow(escrowId, 73);
    expect(await sweep(NIGHT)).toBeNull();
    expect((await escrowRow(escrowId)).sla_escalated_at).toBeNull();
    expect(sent).toEqual([]);
    expect((await sweep(new Date('2026-10-13T05:00:00Z')))!.escrows).toBe(1); // 08:00 Nairobi
  });

  it('runs at most once an hour', async () => {
    const a = await agent();
    const { escrowId } = await escrow(a.agentId, '10.00');
    const now = tick();
    expect(await sweep(now)).not.toBeNull();
    await ageEscrow(escrowId, 73);
    expect(await sweep(new Date(now.getTime() + 59 * 60_000))).toBeNull();
    expect((await sweep(new Date(now.getTime() + 60 * 60_000)))!.escrows).toBe(1);
  });

  it('concurrent sweeps mark each item exactly once', async () => {
    await admin();
    const a = await agent();
    for (let i = 0; i < 5; i++) await ageEscrow((await escrow(a.agentId, '10.00')).escrowId, 73);
    await agePayout(await unresolved(a), 25);
    const now = tick();
    const services = Array.from({ length: 4 }, make);
    const results = await Promise.all(services.map((s) => s.escalate(now)));
    await Promise.all(services.map((s) => s.settled()));
    expect(results.reduce((n, r) => n + r!.escrows, 0)).toBe(5);
    expect(results.reduce((n, r) => n + r!.payouts, 0)).toBe(1);
    expect(metrics.frozenSla.escalated).toBe(6);
  });

  it('trigger: the settle insert starts the clock; a non-quarantined insert has none', async () => {
    const a = await agent();
    const q = await escrow(a.agentId, '10.00');
    const h = await escrow(a.agentId, '10.00', { status: 'HELD' });
    expect((await escrowRow(q.escrowId)).frozen_at).toBeInstanceOf(Date);
    expect((await escrowRow(h.escrowId)).frozen_at).toBeNull();
  });

  it('digest wording: both kinds, plurals and cents', () => {
    expect(digest({ escrows: 3, escrowCents: 420_000, payouts: 1, payoutCents: 150_000 })).toBe(
      'SalesMesh admin: 3 quarantined escrows (KES 4,200) and 1 unresolved payout (KES 1,500) passed their SLA. Review: GET /api/v1/admin/frozen-payouts.'
    );
    expect(digest({ escrows: 0, escrowCents: 0, payouts: 2, payoutCents: 123_450 })).toBe(
      'SalesMesh admin: 2 unresolved payouts (KES 1,234.50) passed their SLA. Review: GET /api/v1/admin/frozen-payouts.'
    );
  });

  describe('GET /api/v1/admin/frozen-payouts', () => {
    const get = (token?: string) => srv.request('GET', '/api/v1/admin/frozen-payouts', { headers: token ? { Authorization: `Bearer ${token}` } : {} });

    it('MERCHANT_ADMIN: 200 with sla, escrows and payouts, overdue first then oldest; no full msisdn; no-store', async () => {
      const ops = await admin();
      const a = await agent();
      const young = await escrow(a.agentId, '1.00');
      const old = await escrow(a.agentId, '2.00', { reason: 'fail_safe' });
      const older = await escrow(a.agentId, '3.00', { reason: 'trust_below_threshold' });
      await ageEscrow(young.escrowId, 1);
      await ageEscrow(old.escrowId, 80);
      await ageEscrow(older.escrowId, 90);
      const payoutId = await unresolved(a, 700);
      await agePayout(payoutId, 30);
      const token = (await signAccessToken({ userId: ops.userId, role: 'MERCHANT_ADMIN', pinChangeRequired: false })).token;
      const res = await get(token);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.sla).toEqual({ escrow_hours: 72, payout_hours: 24 });
      expect(res.body.totals).toEqual({ escrows: 3, payouts: 1 });
      expect(res.body.escrows.map((e: any) => e.escrow_id)).toEqual([older.escrowId, old.escrowId, young.escrowId]);
      expect(res.body.escrows[0]).toMatchObject({ amount: 3, receipt: older.receipt, quarantine_reason: 'trust_below_threshold', security_hold: false, ufaa_frozen: false, overdue: true, escalated_at: null, agent_name: 'Test Agent' });
      expect(res.body.escrows[2].overdue).toBe(false);
      expect(res.body.payouts).toEqual([expect.objectContaining({ payout_id: payoutId, amount: 700, overdue: true, msisdn: expect.stringMatching(/^2547\*+\d{2}$/) })]);
      expect(JSON.stringify(res.body)).not.toContain(a.phone);
    });

    it('SALES_AGENT → 403 forbidden; no token → 401', async () => {
      const token = (await signAccessToken({ userId: crypto.randomUUID(), role: 'SALES_AGENT', pinChangeRequired: false })).token;
      const res = await get(token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await get()).status).toBe(401);
    });
  });
});
