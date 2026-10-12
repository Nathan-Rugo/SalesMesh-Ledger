/**
 * Unclaimed payout reminders against real Postgres (spec gh-11, part 3a): one test per I/O-matrix
 * row, with a fake notifier and an injected `now` (the daytime window); escrow ages are set with SQL.
 */

import crypto from 'crypto';
import { applyPayoutResult } from '../../src/repositories/payout.repository';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { PayoutService } from '../../src/services/payout.service';
import { createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

const NOON = new Date('2026-10-12T09:00:00Z'); // 12:00 Africa/Nairobi (UTC+3)
const NIGHT = new Date('2026-10-12T19:30:00Z'); // 22:30 Africa/Nairobi

describeDb('unclaimed payout reminders (real Postgres)', () => {
  let db: TestDb;
  let metrics: GatewayMetrics;
  let service: PayoutService;
  let sent: Array<{ to: string; message: string }>;
  let failSms: boolean;
  /** Each default sweep runs an hour later (reminders query at most hourly), from 08:00 Nairobi. */
  let clock: number;
  const tick = () => new Date((clock += 3600_000));

  beforeAll(async () => {
    db = await createTestDb('sm_remind');
    await db.pool.query(INIT_SQL);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(() => {
    process.env.PAYOUTS_ENABLED = 'true';
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    sent = [];
    failSms = false;
    clock = Date.parse('2026-10-12T04:00:00Z');
    metrics = new GatewayMetrics();
    service = make();
  });
  afterEach(async () => {
    await service.settled();
    jest.restoreAllMocks();
    delete process.env.PAYOUTS_ENABLED;
  });

  const make = () =>
    new PayoutService({
      db: db.pool,
      metrics,
      notifier: {
        send: async (to, message) => {
          if (failSms) throw new Error('AT down');
          sent.push({ to, message });
        },
      },
      config: { minAmount: 10, reminderDays: [7, 30, 90], reminderHours: [8, 20] },
    });

  async function agent(o: { destination?: boolean } = {}) {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, null, phone);
    if (o.destination !== false) {
      await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [agentId, phone]);
    }
    return { agentId, phone };
  }

  /** An escrow matured `days` ago (gross commission in shillings). */
  async function escrow(agentId: string, gross: string, days: number, o: { status?: string; securityHold?: boolean } = {}) {
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, `R${crypto.randomBytes(5).toString('hex').toUpperCase()}`]
    );
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds, security_hold)
       VALUES ($1, $2::numeric, $3, NOW() - make_interval(days => $4::int), 3600, $5) RETURNING escrow_id`,
      [t.transaction_id, gross, o.status ?? 'HELD', days, o.securityHold ?? false]
    );
    return e.escrow_id as string;
  }

  const age = (escrowId: string, days: number) =>
    db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - make_interval(days => $2::int) WHERE escrow_id = $1`, [escrowId, days]);
  const stage = async (escrowId: string) => (await db.pool.query(`SELECT unclaimed_reminder_stage FROM escrow_accounts WHERE escrow_id = $1`, [escrowId])).rows[0].unclaimed_reminder_stage;
  /** Runs one daytime sweep; returns the SMS this agent got. */
  async function sweep(phone: string, now = tick(), s = service) {
    await s.remindUnclaimed(now);
    await s.settled();
    return sent.filter((m) => m.to === phone).map((m) => m.message);
  }

  it('stage 1 at 7 days: one SMS with the amount and how to claim; the same day again sends nothing', async () => {
    const a = await agent();
    const old = await escrow(a.agentId, '40.50', 8);
    await escrow(a.agentId, '9.75', 1); // same balance, newer
    await escrow(a.agentId, '500.00', -1); // not matured: not in the balance
    expect(await sweep(a.phone)).toEqual(['SalesMesh: KES 50 commission is waiting for you to claim. Claim it in the SalesMesh app with your PIN; it is paid to your verified M-Pesa line.']);
    expect(await stage(old)).toBe(1);
    expect(metrics.payoutClaims.reminders).toBe(1);
    sent = [];
    expect(await sweep(a.phone)).toEqual([]);
  });

  it('stage 2 at 30 days and stage 3 at 90 days: one SMS each, once', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '20.00', 8);
    expect(await sweep(a.phone)).toHaveLength(1);
    await age(e, 31);
    expect(await sweep(a.phone)).toHaveLength(2);
    expect(await stage(e)).toBe(2);
    expect(await sweep(a.phone)).toHaveLength(2);
    await age(e, 91);
    expect(await sweep(a.phone)).toHaveLength(3);
    expect(await stage(e)).toBe(3);
    expect(await sweep(a.phone)).toHaveLength(3);
  });

  it('outage catch-up: 40 days with no stage sent → only the stage-2 SMS', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '20.00', 40);
    expect(await sweep(a.phone)).toHaveLength(1);
    expect(await stage(e)).toBe(2);
    expect(await sweep(a.phone)).toHaveLength(1);
  });

  it('claimed, then new escrows mature: a new cycle keyed on the new oldest escrow restarts at stage 1', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, '20.00', 40);
    expect(await sweep(a.phone)).toHaveLength(1);
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'RELEASED' WHERE escrow_id = $1`, [e1]); // claimed and paid
    const e2 = await escrow(a.agentId, '15.00', 3);
    expect(await sweep(a.phone)).toHaveLength(1); // 3 days: not yet
    await age(e2, 8);
    const msgs = await sweep(a.phone);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatch(/^SalesMesh: KES 15 commission/);
    expect(await stage(e2)).toBe(1);
  });

  it('payout FAILED: the escrows come back HELD with their stage, so sent stages never repeat', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '20.00', 40);
    expect(await sweep(a.phone)).toHaveLength(1);
    const payoutId = crypto.randomUUID();
    const { rows: [d] } = await db.pool.query(`SELECT destination_id FROM payout_destinations WHERE agent_id = $1`, [a.agentId]);
    await db.pool.query(
      `INSERT INTO payouts (payout_id, agent_id, destination_id, msisdn, amount, gross_cents, carry_in_cents, carry_out_cents, disclosure_version, consent_hash, accepted_at)
       VALUES ($1, $2, $3, $4, 20, 2000, 0, 0, '1', 'x', NOW())`,
      [payoutId, a.agentId, d.destination_id, a.phone]
    );
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'CLAIMED', payout_id = $2 WHERE escrow_id = $1`, [e, payoutId]);
    expect((await applyPayoutResult(db.pool, { originatorConversationId: payoutId, conversationId: null, resultCode: '2001', receiverName: null, receipt: null })).kind).toBe('applied');
    expect(await stage(e)).toBe(2);
    expect(await sweep(a.phone)).toHaveLength(1);
  });

  it('below the minimum: nothing, and no stage recorded (a later sweep can still remind)', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '9.99', 8);
    expect(await sweep(a.phone)).toEqual([]);
    expect(await stage(e)).toBe(0);
  });

  it('the carry counts towards the balance', async () => {
    const a = await agent();
    await db.pool.query(`UPDATE sales_agents SET payout_carry_cents = 2 WHERE agent_id = $1`, [a.agentId]);
    await escrow(a.agentId, '9.98', 8);
    expect(await sweep(a.phone)).toEqual([expect.stringMatching(/^SalesMesh: KES 10 commission/)]);
  });

  it('disabled user or an open payout: nothing', async () => {
    const off = await agent();
    const e1 = await escrow(off.agentId, '20.00', 8);
    await db.pool.query(`UPDATE users SET disabled_at = NOW() WHERE phone_number = $1`, [off.phone]);
    expect(await sweep(off.phone)).toEqual([]);
    expect(await stage(e1)).toBe(0);

    const busy = await agent();
    const e2 = await escrow(busy.agentId, '20.00', 8);
    const { rows: [d] } = await db.pool.query(`SELECT destination_id FROM payout_destinations WHERE agent_id = $1`, [busy.agentId]);
    await db.pool.query(
      `INSERT INTO payouts (payout_id, agent_id, destination_id, msisdn, amount, gross_cents, carry_in_cents, carry_out_cents, disclosure_version, consent_hash, accepted_at, status)
       VALUES ($1, $2, $3, $4, 20, 2000, 0, 0, '1', 'x', NOW(), 'UNRESOLVED')`,
      [crypto.randomUUID(), busy.agentId, d.destination_id, busy.phone]
    );
    expect(await sweep(busy.phone)).toEqual([]);
    expect(await stage(e2)).toBe(0);
  });

  it('QUARANTINED and security-held escrows are never reminded about nor counted', async () => {
    const a = await agent();
    await escrow(a.agentId, '500.00', 100, { status: 'QUARANTINED' });
    const held = await escrow(a.agentId, '500.00', 100, { securityHold: true });
    expect(await sweep(a.phone)).toEqual([]);
    expect(await stage(held)).toBe(0);
    await escrow(a.agentId, '12.00', 8);
    expect(await sweep(a.phone)).toEqual([expect.stringMatching(/^SalesMesh: KES 12 commission/)]);
  });

  it('no ACTIVE destination: the SMS says to register a payout line first', async () => {
    const a = await agent({ destination: false });
    await escrow(a.agentId, '20.00', 8);
    expect(await sweep(a.phone)).toEqual([
      'SalesMesh: KES 20 commission is waiting for you to claim. Register your M-Pesa payout line in the SalesMesh app first, then claim it with your PIN.',
    ]);
  });

  it('night (outside 08:00–20:00 Nairobi): nothing marked; sent at the next daytime sweep', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '20.00', 8);
    expect(await service.remindUnclaimed(NIGHT)).toBe(0);
    expect(await service.remindUnclaimed(new Date('2026-10-12T04:59:00Z'))).toBe(0); // 07:59
    expect(await service.remindUnclaimed(new Date('2026-10-12T17:00:00Z'))).toBe(0); // 20:00
    expect(await stage(e)).toBe(0);
    expect(await sweep(a.phone, new Date('2026-10-12T05:00:00Z'))).toHaveLength(1); // 08:00
  });

  it('SMS fails: the stage is still recorded (no retry storm) and the failure is counted', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '20.00', 8);
    failSms = true;
    await sweep(a.phone);
    expect(await stage(e)).toBe(1);
    expect(metrics.payoutClaims.remindersFailed).toBe(1);
    expect(metrics.payoutClaims.reminders).toBe(0);
    failSms = false;
    expect(await sweep(a.phone)).toEqual([]);
  });

  it('PAYOUTS_ENABLED≠true: no-op', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '20.00', 8);
    process.env.PAYOUTS_ENABLED = 'false';
    expect(await service.remindUnclaimed(NOON)).toBe(0);
    expect(await stage(e)).toBe(0);
    process.env.PAYOUTS_ENABLED = 'true'; // left pending, not lost
    expect(await sweep(a.phone)).toHaveLength(1);
  });

  it('a sweep holding the key escrow locked: a concurrent sweep skips the agent; after COMMIT exactly one SMS', async () => {
    const a = await agent();
    const key = await escrow(a.agentId, '20.00', 40);
    await escrow(a.agentId, '20.00', 39);
    const other = await db.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM escrow_accounts WHERE escrow_id = $1 FOR UPDATE`, [key]);
      expect(await service.remindUnclaimed(tick())).toBe(0);
      await service.settled();
      expect(sent).toEqual([]);
      await other.query('COMMIT');
    } finally {
      other.release();
    }
    expect(await sweep(a.phone)).toHaveLength(1);
    expect(await sweep(a.phone)).toHaveLength(1);
  });

  it('the key escrow security-held after stage 2: the next-oldest escrow does not resend a stage', async () => {
    const a = await agent();
    const key = await escrow(a.agentId, '20.00', 40);
    await escrow(a.agentId, '20.00', 35);
    expect(await sweep(a.phone)).toHaveLength(1);
    expect(await stage(key)).toBe(2);
    await db.pool.query(`UPDATE escrow_accounts SET security_hold = TRUE WHERE escrow_id = $1`, [key]);
    expect(await sweep(a.phone)).toHaveLength(1);
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'QUARANTINED', quarantine_reason = 'security_hold' WHERE escrow_id = $1`, [key]);
    expect(await sweep(a.phone)).toHaveLength(1);
  });

  it('queries at most once an hour; a night skip does not use up the hour', async () => {
    const a = await agent();
    await escrow(a.agentId, '20.00', 8);
    expect(await service.remindUnclaimed(new Date('2026-10-12T04:30:00Z'))).toBe(0); // 07:30, night
    expect(await sweep(a.phone, new Date('2026-10-12T05:00:00Z'))).toHaveLength(1); // 08:00
    const b = await agent();
    await escrow(b.agentId, '20.00', 8);
    expect(await sweep(b.phone, new Date('2026-10-12T05:59:00Z'))).toEqual([]); // within the hour
    expect(await sweep(b.phone, new Date('2026-10-12T06:00:00Z'))).toHaveLength(1);
  });
});
