/**
 * UFAA report-and-remit against real Postgres (spec gh-11, part 3b): one test per I/O-matrix row,
 * with a fake notifier and an injected clock; the report / claim race (freeze at report); a CSV
 * escaping test.
 */

import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { signAccessToken } from '../../src/auth/tokens';
import { PayoutController } from '../../src/controllers/payout.controller';
import { claimableEscrows, createPayout, dueReminders } from '../../src/repositories/payout.repository';
import { securityHoldReceipt } from '../../src/repositories/security.repository';
import { createPayoutRouter } from '../../src/routes/payout.routes';
import { ufaaPrepare } from '../../src/scripts/ufaa-prepare';
import { ufaaRemit } from '../../src/scripts/ufaa-remit';
import { ufaaReport } from '../../src/scripts/ufaa-report';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { LogNotifier } from '../../src/services/notifier.service';
import { PayoutService } from '../../src/services/payout.service';
import { filingDeadline, holderReportCsv, ownerIdNumber, UfaaService } from '../../src/services/ufaa.service';
import { listen } from '../support/http';
import { count, createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

const PERIOD = '2026-06-30';
const PREPARED_AT = new Date('2026-07-15T07:00:00Z'); // 10:00 Nairobi
const DAY = 86_400_000;
const at = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

describe('UFAA holder report CSV', () => {
  it('quotes commas, quotes and newlines, and neutralises formula cells', () => {
    const csv = holderReportCsv([
      { itemId: 'i1', agentId: 'a', userId: 'u', escrowIds: ['e'], amountCents: 123456, ownerName: 'Doe, "JJ"', msisdn: '254712345678', payableFrom: new Date('2025-03-01T00:00:00Z'), ownerNo: 1 },
      { itemId: 'i2', agentId: 'a', userId: 'u', escrowIds: ['e'], amountCents: 5, ownerName: '=HYPERLINK("x")', msisdn: '254712345679', payableFrom: new Date('2025-06-30T20:00:00Z'), ownerNo: 123 },
    ], '45');
    expect(csv).toBe(
      'owner_name,id_number,phone,amount_kes,asset_type,date_payable,holder_reference\r\n' +
        '"Doe, ""JJ""",45000001,254712345678,1234.56,Unpaid commission,2025-03-01,i1\r\n' +
        `"'=HYPERLINK(""x"")",45000123,254712345679,0.05,Unpaid commission,2025-06-30,i2\r\n`
    );
  });

  it('ID number: holder code + owner serial, 8 digits; null when it does not fit', () => {
    expect(ownerIdNumber('45', 1)).toBe('45000001');
    expect(ownerIdNumber('123456', 99)).toBe('12345699');
    expect(ownerIdNumber('123456', 100)).toBeNull();
    expect(ownerIdNumber('7', 9_999_999)).toBe('79999999');
  });
});

describe('UFAA filing deadline', () => {
  it('end of 1 November, Africa/Nairobi: 23:00 is on time, 2 November 00:30 is late', () => {
    expect(new Date('2026-11-01T23:00:00+03:00') > filingDeadline('2026-06-30')).toBe(false);
    expect(new Date('2026-11-02T00:30:00+03:00') > filingDeadline('2026-06-30')).toBe(true);
  });
});

describeDb('UFAA report-and-remit (real Postgres)', () => {
  let db: TestDb;
  let service: UfaaService;
  let sent: Array<{ to: string; message: string }>;
  let failSms: boolean;
  let clock: Date;
  let dir: string;
  let infos: jest.SpyInstance;

  beforeEach(async () => {
    process.env.PAYOUTS_ENABLED = 'true';
    db = await createTestDb('sm_ufaa');
    await db.pool.query(INIT_SQL);
    sent = [];
    failSms = false;
    clock = PREPARED_AT;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufaa-'));
    infos = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new UfaaService({
      db: db.pool,
      metrics: new GatewayMetrics(),
      notifier: {
        send: async (to, message) => {
          if (failSms) throw new Error('AT down');
          sent.push({ to, message });
        },
      },
      now: () => clock,
      reportDir: dir,
      holderIdCode: '45',
      dormancyYears: 1,
    });
  });
  afterEach(async () => {
    // Logs mask the phone.
    expect(infos.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/2547\d{8}/);
    jest.restoreAllMocks();
    delete process.env.PAYOUTS_ENABLED;
    fs.rmSync(dir, { recursive: true, force: true });
    await db?.drop();
  });

  async function agent(name = 'Test Agent') {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, null, phone);
    const { rows: [u] } = await db.pool.query(`UPDATE users SET full_name = $2 FROM sales_agents a WHERE a.user_id = users.user_id AND a.agent_id = $1 RETURNING users.user_id`, [agentId, name]);
    return { agentId, phone, userId: u.user_id as string };
  }

  /** An escrow that became payable at `due` (ISO, e.g. '2025-06-30T12:00:00+03:00'). */
  async function escrow(agentId: string, gross: string, due: string, o: { status?: string; securityHold?: boolean } = {}) {
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, `R${crypto.randomBytes(5).toString('hex').toUpperCase()}`]
    );
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds, security_hold)
       VALUES ($1, $2::numeric, $3, $4, 3600, $5) RETURNING escrow_id`,
      [t.transaction_id, gross, o.status ?? 'HELD', due, o.securityHold ?? false]
    );
    return e.escrow_id as string;
  }

  const ret = async () => (await db.pool.query(`SELECT *, period_end::text AS period_end FROM ufaa_returns`)).rows[0];
  const status = async (id: string) => (await db.pool.query(`SELECT escrow_status, ufaa_return_id FROM escrow_accounts WHERE escrow_id = $1`, [id])).rows[0];
  const events = async (type: string) => (await db.pool.query(`SELECT subject_user_id, detail FROM security_events WHERE event_type = $1`, [type])).rows;
  const prepare = (period = PERIOD) => ufaaPrepare(service, [period], 'ops');
  const report = (id: string) => ufaaReport(service, [id], 'ops');
  const remit = (id: string, ref = 'CBK-2026-001') => ufaaRemit(service, [id, '--reference', ref], 'ops');
  const itemId = async (agentId: string) => (await db.pool.query(`SELECT item_id FROM ufaa_return_items WHERE agent_id = $1`, [agentId])).rows[0].item_id as string;

  /** GET /api/v1/payouts as the user. */
  async function getPayouts(userId: string) {
    const payouts = new PayoutService({ db: db.pool, notifier: { send: async () => undefined }, metrics: new GatewayMetrics(), config: { minAmount: 10, maxAmount: 150_000 } });
    const app = express();
    app.use('/api/v1/payouts', createPayoutRouter(new PayoutController(payouts)));
    const srv = await listen(app);
    try {
      const token = (await signAccessToken({ userId, role: 'SALES_AGENT', pinChangeRequired: false })).token;
      const res = await srv.request('GET', '/api/v1/payouts', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      return res.body;
    } finally {
      await srv.close();
    }
  }

  /** Two dormant agents (A: two escrows, B: one) plus everything that must stay out. */
  async function seed() {
    const a = await agent();
    const b = await agent();
    const c = await agent();
    const a1 = await escrow(a.agentId, '100.25', '2025-03-01T10:00:00+03:00');
    const a2 = await escrow(a.agentId, '50.50', '2025-06-30T23:00:00+03:00'); // last dormant instant (Nairobi)
    const aNew = await escrow(a.agentId, '999.00', '2025-07-01T00:30:00+03:00'); // payable after the cutoff
    const b1 = await escrow(b.agentId, '20.00', '2024-12-01T10:00:00+03:00');
    await escrow(c.agentId, '70.00', '2025-01-01T10:00:00+03:00', { status: 'QUARANTINED' });
    await escrow(c.agentId, '80.00', '2025-01-01T10:00:00+03:00', { securityHold: true });
    await db.pool.query(`UPDATE sales_agents SET payout_carry_cents = 42 WHERE agent_id = $1`, [a.agentId]);
    return { a, b, c, a1, a2, aNew, b1 };
  }

  async function prepared() {
    const s = await seed();
    await prepare();
    return { ...s, id: (await ret()).return_id as string };
  }

  it('prepare: one item per agent with the summed amount, one SMS and one event each; return NOTICED', async () => {
    const s = await seed();
    const out = await prepare();
    expect(out).toMatch(/is NOTICED: 2 owner\(s\), KES 170\.75 dormant; 2 notice\(s\) sent now\. Report on or after 2026-09-13/);
    const r = await ret();
    expect(r).toMatchObject({ period_end: PERIOD, status: 'NOTICED', noticed_items: 2, noticed_cents: '17075' });
    const { rows: items } = await db.pool.query(`SELECT agent_id, amount_cents, escrow_ids, msisdn FROM ufaa_return_items ORDER BY amount_cents DESC`);
    expect(items).toEqual([
      { agent_id: s.a.agentId, amount_cents: '15075', escrow_ids: [s.a1, s.a2], msisdn: s.a.phone },
      { agent_id: s.b.agentId, amount_cents: '2000', escrow_ids: [s.b1], msisdn: s.b.phone },
    ]);
    expect(sent.map((m) => m.to).sort()).toEqual([s.a.phone, s.b.phone].sort());
    expect(sent.find((m) => m.to === s.a.phone)!.message).toBe(
      'SalesMesh: KES 150.75 unpaid commission has been waiting for you since 1 March 2025. ' +
        'Claim it in the SalesMesh app before 13 September 2026 or it will be transferred to the Unclaimed Financial Assets Authority.'
    );
    const ev = await events('UFAA_NOTICE_SENT');
    expect(ev.map((e) => e.subject_user_id).sort()).toEqual([s.a.userId, s.b.userId].sort());
    expect(ev[0].detail).toMatch(/by ops/);
    expect(ev.map((e) => e.detail).join()).not.toMatch(/2547\d{8}/);
    // Nothing moved: escrows still HELD and claimable, the carry untouched.
    expect((await status(s.a1)).escrow_status).toBe('HELD');
    expect((await db.pool.query(`SELECT payout_carry_cents FROM sales_agents WHERE agent_id = $1`, [s.a.agentId])).rows[0].payout_carry_cents).toBe(42);
  });

  it('bad period: not a 30 June, or not yet ended → refused, nothing written', async () => {
    await seed();
    await expect(prepare('2026-06-29')).rejects.toThrow(/refused: the period must end on a 30 June/);
    await expect(prepare('2026-13-30')).rejects.toThrow(/refused/);
    clock = new Date('2026-06-30T12:00:00+03:00');
    await expect(prepare('2026-06-30')).rejects.toThrow(/refused: the period has not ended yet/);
    await expect(prepare('2027-06-30')).rejects.toThrow(/not ended/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM ufaa_returns`)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('SMS not configured (log-only notifier) → refused, nothing written', async () => {
    await seed();
    const logOnly = new UfaaService({ db: db.pool, metrics: new GatewayMetrics(), notifier: new LogNotifier(), now: () => clock, reportDir: dir, holderIdCode: '45', dormancyYears: 1 });
    await expect(ufaaPrepare(logOnly, [PERIOD], 'ops')).rejects.toThrow(/SMS is not configured.*nothing written/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM ufaa_returns`)).toBe(0);
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events`)).toBe(0);
  });

  it('payouts disabled → refused (owners could not claim), nothing written', async () => {
    await seed();
    delete process.env.PAYOUTS_ENABLED;
    await expect(prepare()).rejects.toThrow(/refused: payouts are disabled.*nothing written/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM ufaa_returns`)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('prepared too late to file on time → NOTICED with a LATE warning', async () => {
    await seed();
    clock = new Date('2026-09-15T10:00:00+03:00');
    expect(await prepare()).toMatch(/is NOTICED[\s\S]*\nWARNING: the earliest report date is after the filing deadline \(2026-11-01\)/);
  });

  it('undeliverable: notices still failing + --accept-failed → recorded as attempts (event says undeliverable); NOTICED', async () => {
    const s = await seed();
    failSms = true;
    await expect(prepare()).rejects.toThrow(/stays DRAFT.*--accept-failed/);
    await expect(ufaaPrepare(service, [PERIOD, '--bogus'], 'ops')).rejects.toThrow(/usage/);
    const out = await ufaaPrepare(service, [PERIOD, '--accept-failed'], 'ops');
    expect(out).toMatch(/is NOTICED: 2 owner\(s\), KES 170\.75 dormant; 0 notice\(s\) sent now, 2 undeliverable \(recorded as attempts\)/);
    expect((await ret()).status).toBe('NOTICED');
    const ev = await events('UFAA_NOTICE_SENT');
    expect(ev.map((e) => e.subject_user_id).sort()).toEqual([s.a.userId, s.b.userId].sort());
    for (const e of ev) expect(e.detail).toMatch(/notice SMS undeliverable; recorded as a good-faith attempt \(--accept-failed\) by ops/);
  });

  it('every item dropped before its notice → NOTICED with noticed_at = the clock; GET for a NOTICED-only or dropped agent shows remitted: []', async () => {
    const s = await seed();
    failSms = true;
    await expect(prepare()).rejects.toThrow(/stays DRAFT/);
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'RELEASED' WHERE escrow_id = ANY($1::uuid[])`, [[s.a1, s.b1]]);
    failSms = false;
    clock = at(PREPARED_AT, 3);
    expect(await prepare()).toMatch(/is NOTICED: 0 owner\(s\), KES 0\.00 dormant; 0 notice\(s\) sent now/);
    expect(new Date((await ret()).noticed_at).getTime()).toBe(clock.getTime());
    expect((await getPayouts(s.a.userId)).remitted).toEqual([]); // dropped
  });

  it('GET for an agent in a NOTICED (not yet reported) return shows remitted: []', async () => {
    const s = await prepared();
    expect((await getPayouts(s.a.userId)).remitted).toEqual([]);
  });

  it('env wiring: UFAA_DORMANCY_YEARS, UFAA_REPORT_DIR and UFAA_HOLDER_ID_CODE are read when not injected', async () => {
    const s = await seed();
    const aOld = await escrow(s.a.agentId, '5.00', '2024-06-30T23:00:00+03:00'); // more than 2 years before 2026-06-30
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufaa-env-'));
    process.env.UFAA_DORMANCY_YEARS = '2';
    process.env.UFAA_REPORT_DIR = envDir;
    process.env.UFAA_HOLDER_ID_CODE = '77';
    try {
      const fromEnv = new UfaaService({ db: db.pool, metrics: new GatewayMetrics(), notifier: { send: async (to, message) => void sent.push({ to, message }) }, now: () => clock });
      await ufaaPrepare(fromEnv, [PERIOD], 'ops');
      // Two years: only escrows payable by 2024-06-30 (Nairobi). a1, a2 and b1 (dormant under 1 year) are inside the window.
      const { rows } = await db.pool.query(`SELECT agent_id, escrow_ids FROM ufaa_return_items`);
      expect(rows).toEqual([{ agent_id: s.a.agentId, escrow_ids: [aOld] }]);
      clock = at(PREPARED_AT, 61);
      await ufaaReport(fromEnv, [(await ret()).return_id], 'ops');
      expect(path.dirname((await ret()).report_path)).toBe(path.resolve(envDir));
      expect(fs.readdirSync(envDir)).toHaveLength(1);
      expect(fs.readFileSync((await ret()).report_path, 'utf8')).toMatch(/^Test Agent,77\d{6},/m);
    } finally {
      delete process.env.UFAA_DORMANCY_YEARS;
      delete process.env.UFAA_REPORT_DIR;
      delete process.env.UFAA_HOLDER_ID_CODE;
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });

  it('duplicate prepare → "already prepared", nothing sent again', async () => {
    await prepared();
    sent = [];
    await expect(prepare()).rejects.toThrow(/already prepared: return .* is NOTICED/);
    expect(sent).toEqual([]);
    expect(await count(db.pool, `SELECT count(*) AS n FROM ufaa_return_items`)).toBe(2);
  });

  it('nothing dormant → "nothing to report", no return created', async () => {
    const a = await agent();
    await escrow(a.agentId, '10.00', '2025-07-01T10:00:00+03:00');
    expect(await prepare()).toMatch(/Nothing to report.*No return created/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM ufaa_returns`)).toBe(0);
  });

  it('a failed notice keeps the return DRAFT (report refused); a re-run sends only the missing notices', async () => {
    const s = await seed();
    failSms = true;
    await expect(prepare()).rejects.toThrow(/0 notice\(s\) sent, 2 FAILED; it stays DRAFT/);
    const id = (await ret()).return_id;
    expect((await ret()).status).toBe('DRAFT');
    await expect(report(id)).rejects.toThrow(/not every owner has been noticed/);
    await expect(remit(id)).rejects.toThrow(/refused: notices incomplete; re-run ufaa:prepare/);
    failSms = false;
    clock = at(PREPARED_AT, 2);
    expect(await prepare()).toMatch(/is NOTICED.*2 notice\(s\) sent now/);
    expect(sent.map((m) => m.to).sort()).toEqual([s.a.phone, s.b.phone].sort());
    expect(new Date((await ret()).noticed_at).getTime()).toBe(at(PREPARED_AT, 2).getTime());
    expect(await events('UFAA_NOTICE_SENT')).toHaveLength(2);
  });

  it('a resumed prepare never notices an owner who claimed since the snapshot (item dropped)', async () => {
    const s = await seed();
    failSms = true;
    await expect(prepare()).rejects.toThrow(/stays DRAFT/);
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'RELEASED' WHERE escrow_id = $1`, [s.b1]);
    failSms = false;
    expect(await prepare()).toMatch(/is NOTICED.*1 notice\(s\) sent now/);
    expect(sent.map((m) => m.to)).toEqual([s.a.phone]);
    expect((await db.pool.query(`SELECT dropped_at IS NOT NULL AS d FROM ufaa_return_items WHERE agent_id = $1`, [s.b.agentId])).rows[0].d).toBe(true);
  });

  it('a later period never re-reports escrows still in an earlier, unremitted return', async () => {
    const s = await prepared();
    clock = new Date('2027-07-15T10:00:00+03:00');
    expect(await prepare('2027-06-30')).toMatch(/is NOTICED: 1 owner\(s\), KES 999\.00 dormant/);
    const { rows } = await db.pool.query(
      `SELECT i.escrow_ids FROM ufaa_return_items i JOIN ufaa_returns r USING (return_id) WHERE r.period_end = '2027-06-30'`
    );
    expect(rows).toEqual([{ escrow_ids: [s.aNew] }]);
  });

  it('too early: report < 60 days after the notices → refused with the earliest date', async () => {
    const { id } = await prepared();
    clock = at(PREPARED_AT, 59);
    await expect(report(id)).rejects.toThrow(/noticed less than 60 days ago; report on or after 2026-09-13/);
    expect((await ret()).status).toBe('NOTICED');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('report: ≥ 60 days → CSV of the items, return REPORTED with totals, one event per agent; a re-run is "already reported"', async () => {
    const s = await prepared();
    clock = at(PREPARED_AT, 60);
    const out = await report(s.id);
    expect(out).not.toMatch(/LATE/);
    expect(out).toMatch(/is REPORTED: 2 owner\(s\), KES 170\.75 \(0 dropped/);
    const r = await ret();
    expect(r).toMatchObject({ status: 'REPORTED', reported_items: 2, reported_cents: '17075' });
    const csv = fs.readFileSync(r.report_path, 'utf8').trim().split('\r\n');
    expect(csv[0]).toBe('owner_name,id_number,phone,amount_kes,asset_type,date_payable,holder_reference');
    const id = async (agentId: string) => {
      const n = (await db.pool.query(`SELECT ufaa_owner_no FROM sales_agents WHERE agent_id = $1`, [agentId])).rows[0].ufaa_owner_no;
      return `45${String(n).padStart(6, '0')}`;
    };
    const [idA, idB] = [await id(s.a.agentId), await id(s.b.agentId)];
    expect(idA).toMatch(/^45\d{6}$/);
    expect(idA).not.toBe(idB);
    expect(csv.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^Test Agent,${idB},${s.b.phone},20\\.00,Unpaid commission,2024-12-01,[0-9a-f-]{36}$`)),
        expect.stringMatching(new RegExp(`^Test Agent,${idA},${s.a.phone},150\\.75,Unpaid commission,2025-03-01,[0-9a-f-]{36}$`)),
      ])
    );
    expect(csv).toHaveLength(3);
    expect(await events('UFAA_REPORTED')).toHaveLength(2);
    await expect(report(s.id)).rejects.toThrow(/already reported: the return is REPORTED/);
  });

  it('report without a valid UFAA_HOLDER_ID_CODE, or an owner serial too large → refused, nothing written, return stays NOTICED', async () => {
    const s = await prepared();
    clock = at(PREPARED_AT, 61);
    const svc = (holderIdCode: string) =>
      new UfaaService({ db: db.pool, metrics: new GatewayMetrics(), notifier: { send: async () => undefined }, now: () => clock, reportDir: dir, holderIdCode, dormancyYears: 1 });
    for (const code of ['', '1234567', '4a']) {
      await expect(ufaaReport(svc(code), [s.id], 'ops')).rejects.toThrow(/refused: set UFAA_HOLDER_ID_CODE.*nothing written/);
    }
    await db.pool.query(`UPDATE sales_agents SET ufaa_owner_no = 100 WHERE agent_id = $1`, [s.a.agentId]);
    await expect(ufaaReport(svc('123456'), [s.id], 'ops')).rejects.toThrow(/refused: owner serial 100 does not fit.*nothing written/);
    expect(await ret()).toMatchObject({ status: 'NOTICED', report_path: null });
    expect(await count(db.pool, `SELECT count(*) AS n FROM ufaa_return_items WHERE dropped_at IS NOT NULL`)).toBe(0);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE ufaa_return_id IS NOT NULL`)).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('leap year: dormancy is calendar years — for period 2028-06-30, payable 2027-06-30 23:00 is dormant, 2027-07-01 00:30 is not', async () => {
    const a = await agent();
    const lastIn = await escrow(a.agentId, '10.00', '2027-06-30T23:00:00+03:00');
    await escrow(a.agentId, '20.00', '2027-07-01T00:30:00+03:00'); // 365-day arithmetic would include it (2028 is a leap year)
    clock = new Date('2028-07-15T10:00:00+03:00');
    await prepare('2028-06-30');
    expect((await db.pool.query(`SELECT escrow_ids, amount_cents FROM ufaa_return_items`)).rows).toEqual([{ escrow_ids: [lastIn], amount_cents: '1000' }]);
  });

  it('late: report after 1 November → CSV still written, with a loud LATE warning', async () => {
    const { id } = await prepared();
    clock = new Date('2026-11-05T09:00:00+03:00');
    const out = await report(id);
    expect(out).toMatch(/^LATE: penalties may apply\. The filing deadline was 2026-11-01\./);
    expect(fs.existsSync((await ret()).report_path)).toBe(true);
  });

  it('notices more than a year old → reported with a "re-notice owners" warning', async () => {
    const { id } = await prepared();
    clock = at(PREPARED_AT, 367);
    const out = await report(id);
    expect(out).toMatch(/^LATE: penalties may apply/);
    expect(out).toMatch(/WARNING: the last notice was sent more than a year ago.*re-notice owners/);
  });

  it('claimed meanwhile: an agent who claims before the report is dropped; never in the CSV, frozen or remitted', async () => {
    const s = await prepared();
    await db.pool.query(`UPDATE escrow_accounts SET escrow_status = 'RELEASED' WHERE escrow_id = $1`, [s.a2]);
    clock = at(PREPARED_AT, 61);
    expect(await report(s.id)).toMatch(/REPORTED: 1 owner\(s\), KES 20\.00 \(1 dropped/);
    expect(fs.readFileSync((await ret()).report_path, 'utf8')).not.toContain(s.a.phone);
    expect(await status(s.a1)).toEqual({ escrow_status: 'HELD', ufaa_return_id: null });
    expect(await remit(s.id)).toBe(`Return ${s.id} (${PERIOD}) is REMITTED: 1 owner(s), KES 20.00, reference CBK-2026-001.`);
    expect(await status(s.a1)).toEqual({ escrow_status: 'HELD', ufaa_return_id: null });
    expect(await events('UFAA_REMITTED')).toHaveLength(1);
  });

  it('frozen: after the report the escrows are not claimable or reminded; GET shows "being transferred"; reported = remitted', async () => {
    const s = await prepared();
    await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [s.a.agentId, s.a.phone]);
    clock = at(PREPARED_AT, 61);
    await report(s.id);
    for (const e of [s.a1, s.a2, s.b1]) expect(await status(e)).toEqual({ escrow_status: 'HELD', ufaa_return_id: s.id });
    expect(await claimableEscrows(db.pool, s.b.agentId)).toEqual([]);
    expect((await claimableEscrows(db.pool, s.a.agentId)).map((e) => e.escrowId)).toEqual([s.aNew]);
    // Frozen escrows already at stage 3 must not suppress the reminder for A's newer commission.
    await db.pool.query(`UPDATE escrow_accounts SET unclaimed_reminder_stage = 3 WHERE escrow_id = ANY($1::uuid[])`, [[s.a1, s.a2, s.b1]]);
    const due = await dueReminders(db.pool, { stages: [7, 30, 90], minAmount: 10, limit: 100 });
    expect(due.map((d) => d.agentId)).toEqual([s.a.agentId]); // via the newer escrow only; B is frozen
    const body = await getPayouts(s.b.userId);
    expect(body.remitted).toEqual([
      { amount: 20, period_end: PERIOD, reference: null, holder_reference: await itemId(s.b.agentId), note: 'Being transferred to the Unclaimed Financial Assets Authority (UFAA).' },
    ]);
    expect(body.balance).toMatchObject({ cents: 0, escrows: 0 });
    // A claims: only the newer escrow; the frozen ones stay out.
    const claim = await createPayout(db.pool, { agentId: s.a.agentId, payoutId: crypto.randomUUID(), acceptedAt: new Date(), disclosureVersion: '1', disclosureText: 'x', minAmount: 10, maxAmount: 150_000 });
    expect(claim).toMatchObject({ kind: 'created', escrows: 1 });
    expect(await status(s.aNew)).toMatchObject({ escrow_status: 'CLAIMED', ufaa_return_id: null });
    await remit(s.id);
    const r = await ret();
    expect(r.remitted_cents).toBe(r.reported_cents);
    expect(r.remitted_cents).toBe('17075');
  });

  it('held after report: one frozen escrow security-held before remit → the others REMITTED; it stays frozen; event + WARNING to recover from UFAA', async () => {
    const s = await prepared();
    clock = at(PREPARED_AT, 61);
    await report(s.id);
    // The real path: a reversal of a1's receipt security-holds the frozen HELD escrow.
    const { rows: [rc] } = await db.pool.query(`SELECT t.mpesa_receipt_id FROM transactions t JOIN escrow_accounts e USING (transaction_id) WHERE e.escrow_id = $1`, [s.a1]);
    expect(await securityHoldReceipt(db.pool, rc.mpesa_receipt_id)).toMatchObject({ released: [] });
    const out = await remit(s.id);
    expect(out).toMatch(/REMITTED: 2 owner\(s\), KES 70\.50/);
    expect(out).toMatch(/WARNING: 1 escrow\(s\) of 1 owner\(s\) security-held after the report \(KES 100\.25\): not remitted, kept frozen\. .*recover KES 100\.25 from UFAA/);
    expect(await status(s.a1)).toEqual({ escrow_status: 'QUARANTINED', ufaa_return_id: s.id }); // never payable
    expect(await status(s.a2)).toEqual({ escrow_status: 'REMITTED', ufaa_return_id: s.id });
    expect(await status(s.b1)).toEqual({ escrow_status: 'REMITTED', ufaa_return_id: s.id });
    expect(await ret()).toMatchObject({ remitted_cents: '7050', remitted_items: 2 });
    const ev = (await events('UFAA_REMITTED')).filter((e) => e.subject_user_id === s.a.userId).map((e) => e.detail);
    expect(ev).toHaveLength(2);
    expect(ev.join('\n')).toMatch(/recover KES 100\.25 from UFAA/);
    // Even if the hold is lifted, the frozen escrow is never claimable again.
    await db.pool.query(`UPDATE escrow_accounts SET security_hold = FALSE, escrow_status = 'HELD' WHERE escrow_id = $1`, [s.a1]);
    expect((await claimableEscrows(db.pool, s.a.agentId)).map((e) => e.escrowId)).toEqual([s.aNew]);
    expect((await getPayouts(s.a.userId)).remitted).toEqual([
      { amount: 50.5, period_end: PERIOD, reference: 'CBK-2026-001', holder_reference: await itemId(s.a.agentId), note: 'Transferred to the Unclaimed Financial Assets Authority: claim from UFAA.' },
    ]);
  });

  it('remit: HELD escrows → REMITTED with the return, one event per agent; a re-run changes nothing', async () => {
    const s = await prepared();
    clock = at(PREPARED_AT, 61);
    await report(s.id);
    clock = at(PREPARED_AT, 70);
    expect(await remit(s.id)).toBe(`Return ${s.id} (${PERIOD}) is REMITTED: 2 owner(s), KES 170.75, reference CBK-2026-001.`);
    for (const e of [s.a1, s.a2, s.b1]) expect(await status(e)).toEqual({ escrow_status: 'REMITTED', ufaa_return_id: s.id });
    expect((await status(s.aNew)).escrow_status).toBe('HELD');
    expect(await ret()).toMatchObject({ status: 'REMITTED', remittance_reference: 'CBK-2026-001', remitted_items: 2, remitted_cents: '17075' });
    expect(await events('UFAA_REMITTED')).toHaveLength(2);
    // DLT-03: REMITTED is deferred in the #9 chaincode, so a remit queues no ledger op.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM ledger_outbox WHERE escrow_id = ANY($1::uuid[]) AND op <> 'COMMIT'`, [[s.a1, s.a2, s.b1]])).rows[0].n).toBe(0);
    // The sub-shilling carry is never remitted.
    expect((await db.pool.query(`SELECT payout_carry_cents FROM sales_agents WHERE agent_id = $1`, [s.a.agentId])).rows[0].payout_carry_cents).toBe(42);

    const snapshot = async () => [
      (await db.pool.query(`SELECT escrow_id, escrow_status, ufaa_return_id FROM escrow_accounts ORDER BY escrow_id`)).rows,
      (await db.pool.query(`SELECT * FROM ufaa_returns`)).rows,
      (await db.pool.query(`SELECT * FROM ufaa_return_items ORDER BY item_id`)).rows,
      await count(db.pool, `SELECT count(*) AS n FROM security_events`),
    ];
    const before = await snapshot();
    await expect(remit(s.id, 'CBK-OTHER')).rejects.toThrow(/already remitted \(reference CBK-2026-001\)/);
    await expect(report(s.id)).rejects.toThrow(/already reported: the return is REMITTED/);
    expect(await snapshot()).toEqual(before);
  });

  it('wrong order: remit before report is refused; bad reference and unknown return too', async () => {
    const { id } = await prepared();
    await expect(remit(id)).rejects.toThrow(/refused: the return is NOTICED; run ufaa:report first/);
    await expect(remit(id, 'bad ref;')).rejects.toThrow(/the reference must be/);
    await expect(remit(crypto.randomUUID())).rejects.toThrow(/no UFAA return/);
    await expect(ufaaRemit(service, [id], 'ops')).rejects.toThrow(/usage/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE escrow_status = 'REMITTED'`)).toBe(0);
  });

  it('after remit: GET /payouts lists the remitted amount with "claim from UFAA" and the holder reference; it is not in the balance', async () => {
    const s = await prepared();
    clock = at(PREPARED_AT, 61);
    await report(s.id);
    await remit(s.id);
    const body = await getPayouts(s.a.userId);
    expect(body.remitted).toEqual([
      { amount: 150.75, period_end: PERIOD, reference: 'CBK-2026-001', holder_reference: await itemId(s.a.agentId), note: 'Transferred to the Unclaimed Financial Assets Authority: claim from UFAA.' },
    ]);
    // Only the newer escrow (999.00) and the carry remain claimable.
    expect(body.balance).toMatchObject({ cents: 99942, escrows: 1 });
  });

  it('deterministic race: a claim holding the escrow locks commits after liveItems → the report drops the item, no freeze', async () => {
    const s = await prepared();
    clock = at(PREPARED_AT, 61);
    const claim = await db.pool.connect();
    try {
      await claim.query('BEGIN');
      await claimableEscrows(claim, s.a.agentId, true); // locks A's escrows, as a claim does
      await claim.query(`UPDATE escrow_accounts SET escrow_status = 'RELEASED' WHERE escrow_id = ANY($1::uuid[])`, [[s.a1, s.a2]]);
      const pending = report(s.id);
      // Wait until the report (past liveItems, which saw A as claimable) blocks on A's escrow locks.
      for (let i = 0; ; i += 1) {
        const { rows } = await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%' AND query LIKE '%escrow_accounts%'`);
        if (rows.length) break;
        if (i > 200) throw new Error('report never blocked on the escrow locks');
        await new Promise((r) => setTimeout(r, 25));
      }
      await claim.query('COMMIT');
      expect(await pending).toMatch(/REPORTED: 1 owner\(s\), KES 20\.00 \(1 dropped/);
    } finally {
      claim.release();
    }
    for (const e of [s.a1, s.a2]) expect(await status(e)).toEqual({ escrow_status: 'RELEASED', ufaa_return_id: null });
    expect((await db.pool.query(`SELECT dropped_at IS NOT NULL AS d FROM ufaa_return_items WHERE agent_id = $1`, [s.a.agentId])).rows[0].d).toBe(true);
    expect(await ret()).toMatchObject({ reported_cents: '2000', reported_items: 1 });
  });

  it('a report racing a claim on the same agent: each escrow ends CLAIMED or frozen, never both; the total is preserved', async () => {
    const s = await prepared();
    await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [s.a.agentId, s.a.phone]);
    clock = at(PREPARED_AT, 61);
    const [claim] = await Promise.all([
      createPayout(db.pool, {
        agentId: s.a.agentId,
        payoutId: crypto.randomUUID(),
        acceptedAt: new Date(),
        disclosureVersion: '1',
        disclosureText: 'x',
        minAmount: 10,
        maxAmount: 150_000,
      }),
      report(s.id),
    ]);
    await remit(s.id);
    const rows = (await db.pool.query(`SELECT escrow_id, escrow_status, payout_id, ufaa_return_id FROM escrow_accounts WHERE escrow_id = ANY($1::uuid[])`, [[s.a1, s.a2, s.aNew]])).rows;
    for (const r of rows) expect(r.payout_id !== null && r.ufaa_return_id !== null).toBe(false);
    const remitted = rows.filter((r) => r.escrow_status === 'REMITTED').map((r) => r.escrow_id).sort();
    const r = await ret();
    if (claim.kind === 'created' && claim.escrows === 3) {
      // The claim won: everything CLAIMED, A dropped from the report.
      expect(remitted).toEqual([]);
      expect(r.reported_cents).toBe('2000');
      expect(r.remitted_cents).toBe('2000');
    } else {
      // The report won: A's dormant escrows frozen, then REMITTED; the claim took only the newer one.
      expect(remitted).toEqual([s.a1, s.a2].sort());
      expect(rows.find((x) => x.escrow_id === s.aNew).escrow_status).toBe('CLAIMED');
      expect(r.reported_cents).toBe('17075');
      expect(r.remitted_cents).toBe('17075');
    }
    // Total preserved: every A escrow is accounted for exactly once.
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE escrow_id = ANY($1::uuid[]) AND escrow_status IN ('CLAIMED', 'REMITTED')`, [[s.a1, s.a2, s.aNew]])).toBe(3);
  });
});
