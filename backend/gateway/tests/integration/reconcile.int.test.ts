/**
 * Daraja reconciliation against real Postgres (spec gh-6-recon acceptance criteria):
 *  - lost STK: sweep → PAID_UNCONFIRMED → statement import → settled through ML to escrow exactly
 *    once, request consumed, intake row RECONCILED;
 *  - re-importing the same statement changes nothing (run recorded, 0 new rows);
 *  - a late genuine callback returns 200, records RECONCILED_CALLBACK_LATE, holds nothing;
 *  - two concurrent sweeps never double-query a row;
 *  - new C2B, dry run, bad file, known-receipt verification, reversals, ambiguity, FAILED conflict,
 *    masked phones, two-way reconciliation, operator / identity / caps refusals.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import { formatDarajaTime, msisdnMaskHash, normalisedMsisdnHash, redactPayload } from '../../src/domain/callback';
import type { StkQueryOutcome } from '../../src/daraja/client';
import { insertIntake } from '../../src/repositories/intake.repository';
import { markStkFailed } from '../../src/repositories/stk.repository';
import { ImportRejected, importStatement } from '../../src/reconcile/importer';
import { idempotencyService } from '../../src/services/idempotency.service';
import { ResilientRiskClient } from '../../src/services/risk_client.service';
import { SettlementWorker } from '../../src/workers/settlement.worker';
import { ReconcileWorker } from '../../src/workers/reconcile.worker';
import { count, createTestDb, describeDb, INIT_SQL, mlStub, seedAgent, TEST_DATABASE_URL, type TestDb } from './helpers';

jest.setTimeout(120_000);

const SHORTCODE = '174379';
const CUSTOMER = '254712345678';
let db: TestDb;
let tmp: string;
let adminPhone: string;
let controller: any;
let hotRedis: any;

const quiet = () => {
  for (const level of ['info', 'warn', 'error', 'log'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
};

/** dd-mm-yyyy HH:mm:ss in EAT (the statement's clock). */
function eat(d: Date): string {
  const t = formatDarajaTime(d); // yyyyMMddHHmmss EAT
  return `${t.slice(6, 8)}-${t.slice(4, 6)}-${t.slice(0, 4)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
}

interface Row {
  receipt: string;
  completion: Date;
  initiation?: Date;
  details?: string;
  status?: string;
  paidIn?: string;
  withdrawn?: string;
  reason?: string;
  party?: string;
  linked?: string;
  ac?: string;
}

let fileNo = 0;
function statement(rows: Row[], opts: { shortCode?: string; from?: Date; to?: Date } = {}): string {
  const from = opts.from ?? new Date(Date.now() - 2 * 86_400_000);
  const to = opts.to ?? new Date(Date.now() + 86_400_000);
  const q = (v: string) => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    'Organization Name:,ACME TRADERS LTD',
    `Short Code:,${opts.shortCode ?? SHORTCODE}`,
    'Account:,Utility Account',
    `Time Period:,From ${eat(from)} To ${eat(to)}`,
    '',
    'Receipt No.,Completion Time,Initiation Time,Details,Transaction Status,Paid In,Withdrawn,Balance,Reason Type,Other Party Info,Linked Transaction ID,A/C No.',
    ...rows.map((r) =>
      [
        r.receipt,
        eat(r.completion),
        eat(r.initiation ?? r.completion),
        r.details ?? 'Pay Bill Online',
        r.status ?? 'Completed',
        r.paidIn ?? '',
        r.withdrawn ?? '',
        '', // no Balance printed: continuity is not checked (statement.test covers it)
        r.reason ?? 'Pay Bill Online',
        r.party ?? '',
        r.linked ?? '',
        r.ac ?? '',
      ].map(q).join(',')
    ),
  ];
  const file = path.join(tmp, `statement-${++fileNo}-${crypto.randomBytes(3).toString('hex')}.csv`);
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
  return file;
}

const envWith = (extra: Record<string, string> = {}) => ({ ...process.env, RECONCILE_EVIDENCE_DIR: path.join(tmp, 'evidence'), ...extra });
const run = (filePath: string, over: Partial<Parameters<typeof importStatement>[0]> = {}) =>
  importStatement({ filePath, operator: adminPhone, db: db.pool, env: envWith(), ...over });
/** Two-way reconciliation runs only when the statement's Account is pinned. */
const TWO_WAY = { RECONCILE_EXPECTED_ACCOUNT: 'Utility Account' };

function c2bBody(rcpt: string, ag: string, t: Date, over: Record<string, unknown> = {}) {
  return { TransactionType: 'Pay Bill', TransID: rcpt, TransTime: formatDarajaTime(t), TransAmount: '100.00', BusinessShortCode: SHORTCODE, BillRefNumber: ag, MSISDN: CUSTOMER, ...over };
}
async function intakeCallback(body: any, channel: 'C2B' | 'DARAJA_STK' = 'C2B') {
  const rcpt = channel === 'C2B' ? body.TransID : body.Body.stkCallback.CallbackMetadata.Item[1].Value;
  await insertIntake(db.pool, { receipt: rcpt, hash: idempotencyService.hashPayload(Buffer.from(JSON.stringify(body))), channel, payload: redactPayload(body) });
}
const escrowOf = async (r: string) =>
  (await db.pool.query(`SELECT e.escrow_status, e.security_hold FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = $1`, [r])).rows[0];
const events = async () => (await db.pool.query(`SELECT event_type, mpesa_receipt_id FROM security_events ORDER BY event_type, mpesa_receipt_id`)).rows;

const receipt = (p = 'RC') => `${p}${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 10);
const code = () => `R${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const worker = () =>
  new SettlementWorker({ pool: db.pool, riskClient: new ResilientRiskClient(), spool: null, config: { unresolvedBaseDelayMs: 0, unresolvedWindowMs: 0 } });
async function drain() {
  const w = worker();
  while ((await w.runOnce()) > 0) {
    /* keep going */
  }
}

async function stkRequest(
  pool: Pool,
  agentId: string,
  agentCode: string,
  o: { status: string; amount: number; ageMin: number; checkout?: string | null; phone?: string | null; mask?: boolean }
): Promise<{ id: string; createdAt: Date; checkout: string | null }> {
  const checkout = o.checkout === undefined ? (['ACCEPTED', 'PAID_UNCONFIRMED', 'FAILED'].includes(o.status) ? `ws_CO_${crypto.randomBytes(6).toString('hex')}` : null) : o.checkout;
  const phone = o.phone === undefined ? CUSTOMER : o.phone;
  const { rows: [r] } = await pool.query(
    `INSERT INTO stk_requests (agent_id, amount, status, checkout_request_id, phone_hash, phone_mask_hash, account_reference, idempotency_key, created_at, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - make_interval(mins => $9), NOW() - make_interval(mins => $9))
     RETURNING stk_request_id, created_at`,
    [agentId, o.amount, o.status, checkout, phone ? normalisedMsisdnHash(phone) : null, phone && o.mask !== false ? msisdnMaskHash(phone) : null, agentCode, crypto.randomUUID(), o.ageMin]
  );
  return { id: r.stk_request_id, createdAt: new Date(r.created_at), checkout };
}

function stkCallbackBody(rcpt: string, checkout: string, amount: number, paidAt: Date, phone: unknown = Number(CUSTOMER)) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-1',
        CheckoutRequestID: checkout,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: rcpt },
            { Name: 'TransactionDate', Value: Number(formatDarajaTime(paidAt)) },
            { Name: 'PhoneNumber', Value: phone },
          ],
        },
      },
    },
  };
}

/** Delivers a genuine Daraja callback through the real hot-path controller (hotPool = test DB). */
async function deliver(body: unknown): Promise<{ status: number; body: any }> {
  const raw = Buffer.from(JSON.stringify(body));
  const res: any = {
    headersSent: false,
    code: 0,
    payload: null,
    status(c: number) {
      this.code = c;
      return this;
    },
    json(b: unknown) {
      this.payload = b;
      this.headersSent = true;
      return this;
    },
  };
  await controller.handleMpesaCallback({ body, rawBody: raw } as any, res);
  return { status: res.code, body: res.payload };
}

describeDb('Daraja reconciliation (real Postgres)', () => {
  beforeAll(async () => {
    db = await createTestDb('sm_recon');
    await db.pool.query(INIT_SQL);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-recon-'));
    process.env.DARAJA_BUSINESS_SHORTCODE = SHORTCODE;
    delete process.env.DARAJA_PARTY_B;
    delete process.env.RECONCILE_EXPECTED_ACCOUNT;
    adminPhone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    await db.pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Ops', $1, 'MERCHANT_ADMIN')`, [adminPhone]);

    // The hot-path controller's pools are bound to the test database (config/db reads DB_* at load).
    const u = new URL(TEST_DATABASE_URL!);
    Object.assign(process.env, {
      DB_HOST: u.hostname,
      DB_PORT: u.port || '5432',
      DB_USER: decodeURIComponent(u.username),
      DB_PASSWORD: decodeURIComponent(u.password),
      DB_NAME: db.name,
      HOT_PATH_DEADLINE_MS: '5000',
      REDIS_COMMAND_TIMEOUT_MS: '5000',
    });
    // Real Redis when available (the fast path); otherwise the claim degrades and Postgres decides.
    const r = process.env.TEST_REDIS_URL ? new URL(process.env.TEST_REDIS_URL) : null;
    process.env.REDIS_HOST = r?.hostname ?? '127.0.0.1';
    process.env.REDIS_PORT = r ? r.port || '6379' : '1';
    if (r?.password) process.env.REDIS_PASSWORD = decodeURIComponent(r.password);
    jest.isolateModules(() => {
      controller = require('../../src/controllers/webhook.controller').webhookController;
      hotRedis = require('../../src/config/redis').redisClient;
    });
    if (r) await hotRedis.connect();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    let shutdownDb: any;
    jest.isolateModules(() => {
      shutdownDb = require('../../src/config/db').shutdownDb;
    });
    await shutdownDb?.().catch(() => undefined);
    hotRedis?.disconnect();
    await db?.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    quiet();
    await db.pool.query(
      `TRUNCATE reconciliation_exceptions, security_events, escrow_accounts, verification_events, transactions,
                stk_requests, stk_failed_callbacks, mpesa_callbacks, reconciliation_runs CASCADE`
    );
    mlStub(() => ({ decision: 'CLEAR' }));
  });

  it('AC: lost STK — sweep → PAID_UNCONFIRMED → import → settled once via ML to escrow; request consumed; intake RECONCILED', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const req = await stkRequest(db.pool, agentId, ag, { status: 'ACCEPTED', amount: 1500, ageMin: 20 });

    const sweep = new ReconcileWorker({ pool: db.pool, daraja: { stkQuery: async () => ({ kind: 'PAID', resultCode: '0', resultDesc: 'ok' }) }, sleep: async () => undefined });
    expect(await sweep.runOnce()).toEqual(['paid']);
    const { rows: [after] } = await db.pool.query(`SELECT status, last_query_result, reconcile_claim_token FROM stk_requests WHERE stk_request_id = $1`, [req.id]);
    expect(after).toMatchObject({ status: 'PAID_UNCONFIRMED', reconcile_claim_token: null });
    expect(JSON.parse(after.last_query_result)).toMatchObject({ kind: 'PAID', resultCode: '0' });

    const rcpt = receipt('LS');
    const completion = new Date(req.createdAt.getTime() + 30_000);
    const file = statement([{ receipt: rcpt, completion, initiation: new Date(req.createdAt.getTime() + 5_000), paidIn: '1,500.00', party: `${CUSTOMER} - JANE DOE`, ac: ag }]);
    const report = await run(file);
    expect(report).toMatchObject({ outcome: 'COMPLETED', rowsNew: 1, counts: expect.objectContaining({ boundStk: 1, newPayments: 1 }) });
    expect(fs.existsSync(report.evidencePath!)).toBe(true);
    expect(report.evidencePath).toContain(report.sha256);

    const { rows: [cb] } = await db.pool.query(`SELECT * FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [rcpt]);
    expect(cb).toMatchObject({ origin: 'RECONCILED', reconciliation_run_id: report.runId, source_channel: 'DARAJA_STK', checkout_request_id: req.checkout, stk_request_id: req.id });
    expect(new Date(cb.received_at).toISOString()).toBe(new Date(Math.floor(completion.getTime() / 1000) * 1000).toISOString());
    expect(cb.payload.Reconciliation).toMatchObject({ fileSha256: report.sha256, line: 7, corroborated: true, stkRequestId: req.id });
    expect(JSON.stringify(cb.payload)).not.toMatch(/JANE|712345678/);

    await drain();
    expect((await db.pool.query(`SELECT status FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [rcpt])).rows[0].status).toBe('SETTLED');
    const { rows: [tx] } = await db.pool.query(`SELECT agent_id, timestamp, source_channel FROM transactions WHERE mpesa_receipt_id = $1`, [rcpt]);
    expect(tx).toMatchObject({ agent_id: agentId, source_channel: 'DARAJA_STK' });
    expect(new Date(tx.timestamp).getTime()).toBe(Math.floor(completion.getTime() / 1000) * 1000); // statement time, not import time
    expect(await count(db.pool, `SELECT count(*) AS n FROM verification_events`)).toBe(1);
    expect((await db.pool.query(`SELECT escrow_status, security_hold FROM escrow_accounts`)).rows).toEqual([{ escrow_status: 'HELD', security_hold: false }]);
    expect((await db.pool.query(`SELECT consumed_receipt FROM stk_requests WHERE stk_request_id = $1`, [req.id])).rows[0].consumed_receipt).toBe(rcpt);

    // AC: re-importing the same statement changes nothing; the run is recorded with 0 new rows.
    const snapshot = async () =>
      JSON.stringify((await db.pool.query(
        `SELECT (SELECT json_agg(t ORDER BY transaction_id) FROM transactions t) AS t, (SELECT json_agg(v ORDER BY verification_id) FROM verification_events v) AS v,
                (SELECT json_agg(e ORDER BY escrow_id) FROM escrow_accounts e) AS e, (SELECT json_agg(m ORDER BY callback_id) FROM mpesa_callbacks m) AS m`
      )).rows[0]);
    const before = await snapshot();
    const again = await run(file);
    expect(again).toMatchObject({ outcome: 'NOOP', rowsNew: 0, noopOfRunId: report.runId });
    await drain();
    expect(await snapshot()).toBe(before);
    const { rows: runs } = await db.pool.query(`SELECT status, rows_new, noop_of_run_id, operator_user_id IS NOT NULL AS op FROM reconciliation_runs ORDER BY started_at`);
    expect(runs).toEqual([
      { status: 'COMPLETED', rows_new: 1, noop_of_run_id: null, op: true },
      { status: 'COMPLETED', rows_new: 0, noop_of_run_id: report.runId, op: true },
    ]);

    // AC: the genuine callback arrives late → 200, RECONCILED_CALLBACK_LATE, no hold, never a mutation.
    const genuine = stkCallbackBody(rcpt, req.checkout!, 1500, completion);
    expect(await deliver(genuine)).toEqual({ status: 200, body: { ResultCode: 0, ResultDesc: 'Accepted' } });
    expect((await db.pool.query(`SELECT event_type FROM security_events`)).rows).toEqual([{ event_type: 'RECONCILED_CALLBACK_LATE' }]);
    const { rows: [conf] } = await db.pool.query(`SELECT confirmed_by_callback_at, confirmed_hash FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [rcpt]);
    expect(conf.confirmed_by_callback_at).not.toBeNull();
    expect(conf.confirmed_hash).toMatch(/^k1:/);
    expect((await db.pool.query(`SELECT escrow_status, security_hold FROM escrow_accounts`)).rows).toEqual([{ escrow_status: 'HELD', security_hold: false }]);
    // Redelivery: still 200, nothing new.
    expect((await deliver(genuine)).status).toBe(200);
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events`)).toBe(1);
    // A different amount IS a mutation (alarm + security hold).
    expect((await deliver(stkCallbackBody(rcpt, req.checkout!, 1600, completion))).status).toBe(200);
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'PAYLOAD_MUTATION'`)).toBe(1);
    expect((await db.pool.query(`SELECT escrow_status, security_hold FROM escrow_accounts`)).rows).toEqual([{ escrow_status: 'QUARANTINED', security_hold: true }]);
  });

  it('late callback with a different amount on an unconfirmed recovered row → PAYLOAD_MUTATION; other CheckoutRequestID → attribution conflict', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const a = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 700, ageMin: 30 });
    const b = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 800, ageMin: 30, phone: '254798765432' });
    const [ra, rb] = [receipt('MA'), receipt('MB')];
    const at = (r: typeof a) => new Date(r.createdAt.getTime() + 20_000);
    await run(statement([
      { receipt: ra, completion: at(a), initiation: at(a), paidIn: '700', party: `${CUSTOMER} - X`, ac: ag },
      { receipt: rb, completion: at(b), initiation: at(b), paidIn: '800', party: '254798765432 - Y', ac: ag },
    ]));
    await drain();
    expect((await deliver(stkCallbackBody(ra, a.checkout!, 701, at(a)))).status).toBe(200);
    expect((await deliver(stkCallbackBody(rb, 'ws_CO_SOMEONE_ELSE', 800, at(b), 254798765432))).status).toBe(200);
    const { rows } = await db.pool.query(`SELECT event_type, mpesa_receipt_id FROM security_events ORDER BY event_type`);
    expect(rows).toEqual([
      { event_type: 'PAYLOAD_MUTATION', mpesa_receipt_id: ra },
      { event_type: 'RECONCILE_ATTRIBUTION_CONFLICT', mpesa_receipt_id: rb },
    ]);
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks WHERE confirmed_by_callback_at IS NOT NULL`)).toBe(0);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts WHERE security_hold`)).toBe(2);
  });

  it('new C2B: unknown receipt, A/C No. = agent code, masked phone → RECONCILED C2B row (corroborated=false) → settled; unknown code → UNRESOLVED', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const [r1, r2] = [receipt('CB'), receipt('CU')];
    const t = new Date(Date.now() - 3_600_000);
    const report = await run(statement([
      { receipt: r1, completion: t, paidIn: '2,000.00', party: '2547****321 - JOHN DOE', ac: ag.toLowerCase(), details: 'Pay Bill from 2547****321 - JOHN DOE Acc. x', reason: 'Pay Bill' },
      { receipt: r2, completion: t, paidIn: '50.00', ac: 'NOSUCH1' },
      { receipt: receipt('XX'), completion: t, withdrawn: '-30.00', details: 'Business Charge', reason: 'Pay Bill Charge' },
      { receipt: receipt('XY'), completion: t, paidIn: '9,000.00', details: 'Funds Transfer', reason: 'Business Transfer from' },
    ]));
    expect(report.counts).toMatchObject({ newPayments: 2, unbound: 2, nonCredit: expect.objectContaining({ charge: 1, not_whitelisted: 1 }) });
    const { rows: [cb] } = await db.pool.query(`SELECT source_channel, payload FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [r1]);
    expect(cb.source_channel).toBe('C2B');
    expect(cb.payload).toMatchObject({ BillRefNumber: ag.toLowerCase(), Reconciliation: { corroborated: false } });
    expect(cb.payload.MSISDN).toBeUndefined(); // masked → absent
    expect(JSON.stringify(cb.payload)).not.toMatch(/JOHN|DOE/);
    await drain();
    expect((await db.pool.query(`SELECT agent_id FROM transactions WHERE mpesa_receipt_id = $1`, [r1])).rows[0].agent_id).toBe(agentId);
    const { rows: [u] } = await db.pool.query(`SELECT status, last_error FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [r2]);
    expect(u.status).toBe('UNRESOLVED');
    expect(u.last_error).toContain('c2b_unknown_agent_code');
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks`)).toBe(2); // non-credits ignored
  });

  it('dry run prints the would-be actions and writes only the run record; a bad file writes nothing', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const file = statement([{ receipt: receipt('DR'), completion: new Date(Date.now() - 60_000), paidIn: '10', ac: ag }]);
    const dry = await run(file, { dryRun: true });
    expect(dry).toMatchObject({ outcome: 'DRY_RUN', rowsNew: 0, counts: expect.objectContaining({ newPayments: 1 }) });
    expect(dry.actions.join('\n')).toMatch(/new payment, no STK request → RECONCILED C2B intake/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks`)).toBe(0);
    expect((await db.pool.query(`SELECT dry_run, status FROM reconciliation_runs`)).rows).toEqual([{ dry_run: true, status: 'COMPLETED' }]);

    const bad = statement([{ receipt: receipt('BF'), completion: new Date(), paidIn: '10', ac: ag }]).replace(/\.csv$/, '-bad.csv');
    fs.writeFileSync(bad, fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'statements', 'malformed.csv')));
    await expect(run(bad)).rejects.toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/^line 4: completion time/)]) });
    await expect(run(file.replace(/\.csv$/, '.xlsx'))).rejects.toBeInstanceOf(ImportRejected);
    expect(await count(db.pool, `SELECT count(*) AS n FROM reconciliation_runs`)).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks`)).toBe(0);
  });

  it('refuses a wrong Short Code, a non-admin operator, and (without --confirm) more than the caps', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const rows = [{ receipt: receipt('CP'), completion: new Date(Date.now() - 60_000), paidIn: '10', ac: ag }];
    await expect(run(statement(rows, { shortCode: '600000' }))).rejects.toMatchObject({ problems: [expect.stringMatching(/not the Daraja shortcode/)] });
    const agentPhone = (await db.pool.query(`SELECT phone_number FROM users WHERE role = 'SALES_AGENT' LIMIT 1`)).rows[0].phone_number;
    await expect(run(statement(rows), { operator: agentPhone })).rejects.toMatchObject({ problems: [expect.stringMatching(/not an active MERCHANT_ADMIN/)] });
    const capped = { ...process.env, RECONCILE_CONFIRM_MAX_ROWS: '0', RECONCILE_EVIDENCE_DIR: path.join(tmp, 'evidence') };
    const file = statement(rows);
    await expect(run(file, { env: capped })).rejects.toMatchObject({
      problems: [expect.stringMatching(/RECONCILE_CONFIRM_MAX_ROWS \(0\)/), expect.stringMatching(/--confirm/)],
    });
    expect(await count(db.pool, `SELECT count(*) AS n FROM reconciliation_runs`)).toBe(0);
    expect((await run(file, { env: capped, confirm: true })).rowsNew).toBe(1);
  });

  it('known receipt: same amount verified (no new row); different amount → RECONCILE_AMOUNT_MISMATCH + hold; other agent code → attribution conflict', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 600_000);
    const [ok, bad, other] = [receipt('KA'), receipt('KB'), receipt('KC')];
    for (const r of [ok, bad, other]) {
      const body = { TransactionType: 'Pay Bill', TransID: r, TransTime: formatDarajaTime(t), TransAmount: '500.00', BusinessShortCode: SHORTCODE, BillRefNumber: ag, MSISDN: CUSTOMER };
      await insertIntake(db.pool, { receipt: r, hash: idempotencyService.hashPayload(Buffer.from(JSON.stringify(body))), channel: 'C2B', payload: redactPayload(body) });
    }
    await drain();
    // A dry run verifies but never moves trust.
    const dry = await run(statement([{ receipt: ok, completion: t, paidIn: '500.00', ac: ag }], { from: new Date(Date.now() - 4 * 86_400_000) }), { dryRun: true });
    expect(dry.counts.verified).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM agent_trust_events WHERE agent_id = $1`, [agentId])).toBe(0);
    expect((await db.pool.query(`SELECT agent_trust_rating::text AS r FROM sales_agents WHERE agent_id = $1`, [agentId])).rows[0].r).toBe('0.500000');
    const report = await run(statement([
      { receipt: ok, completion: t, paidIn: '500.00', ac: ag },
      { receipt: bad, completion: t, paidIn: '5,000.00', ac: ag },
      { receipt: other, completion: t, paidIn: '500.00', ac: 'ZZOTHER' },
    ]));
    expect(report.counts).toMatchObject({ verified: 1, amountMismatches: 1, attributionConflicts: 1, newPayments: 0 });
    expect((await db.pool.query(`SELECT event_type, mpesa_receipt_id FROM security_events ORDER BY event_type`)).rows).toEqual([
      { event_type: 'RECONCILE_AMOUNT_MISMATCH', mpesa_receipt_id: bad },
      { event_type: 'RECONCILE_ATTRIBUTION_CONFLICT', mpesa_receipt_id: other },
    ]);
    const { rows } = await db.pool.query(
      `SELECT t.mpesa_receipt_id AS r, e.escrow_status, e.security_hold FROM escrow_accounts e JOIN transactions t USING (transaction_id) ORDER BY 1`
    );
    expect(rows.find((x) => x.r === ok)).toMatchObject({ escrow_status: 'HELD', security_hold: false });
    expect(rows.find((x) => x.r === bad)).toMatchObject({ escrow_status: 'QUARANTINED', security_hold: true });
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks`)).toBe(3);

    // Spec gh-23: the verified receipt credits its agent (+β), each alarm penalises (−0.15), once each —
    // also when another statement (different file) lists the same rows again.
    const trust = async () => ({
      rating: (await db.pool.query(`SELECT agent_trust_rating::text AS r FROM sales_agents WHERE agent_id = $1`, [agentId])).rows[0].r,
      events: (await db.pool.query(`SELECT cause, ref FROM agent_trust_events WHERE agent_id = $1 ORDER BY cause, ref`, [agentId])).rows,
    });
    const expected = {
      rating: '0.225000', // 0.5 → 0.525 → 0.375 → 0.225
      events: [
        { cause: 'SECURITY_PENALTY', ref: `RECONCILE_AMOUNT_MISMATCH:${bad}` },
        { cause: 'SECURITY_PENALTY', ref: `RECONCILE_ATTRIBUTION_CONFLICT:${other}` },
        { cause: 'STATEMENT_CONFIRMED', ref: ok },
      ],
    };
    expect(await trust()).toEqual(expected);
    const reimport = await run(statement([
      { receipt: ok, completion: t, paidIn: '500.00', ac: ag },
      { receipt: bad, completion: t, paidIn: '5,000.00', ac: ag },
      { receipt: other, completion: t, paidIn: '500.00', ac: 'ZZOTHER' },
    ], { from: new Date(Date.now() - 3 * 86_400_000) }));
    expect(reimport.outcome).toBe('COMPLETED');
    expect(await trust()).toEqual(expected);
  });

  it('reversals: known HELD → PAYMENT_REVERSED + security-held QUARANTINED; RELEASED → CLAWBACK_DUE; unknown → event only', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 7_200_000);
    const [held, released] = [receipt('VH'), receipt('VR')];
    await run(statement([
      { receipt: held, completion: t, paidIn: '1,000.00', ac: ag },
      { receipt: released, completion: t, paidIn: '300.00', ac: ag },
    ]));
    await drain();
    await db.pool.query(`UPDATE escrow_accounts e SET escrow_status = 'RELEASED' FROM transactions t WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1`, [released]);
    const later = new Date(Date.now() - 3_600_000);
    const report = await run(statement([
      { receipt: receipt('RV'), completion: later, withdrawn: '-400.00', details: `Reversal of ${held}`, reason: 'Reversal', linked: held, ac: ag },
      { receipt: receipt('RW'), completion: later, withdrawn: '-300.00', details: 'Reversal', reason: 'Reversal', linked: released, ac: ag },
      { receipt: receipt('RX'), completion: later, withdrawn: '-10.00', details: 'Reversal', reason: 'Reversal', linked: 'NOSUCH0001', ac: ag },
    ], { from: new Date(Date.now() - 5_400_000) }));
    expect(report.counts).toMatchObject({ reversals: 3, reversalsOfKnown: 2, reversalsOfUnknown: 1, clawbacksDue: 1 });
    expect(report.actions.join('\n')).toMatch(/partial/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'PAYMENT_REVERSED'`)).toBe(3);
    const esc = async (r: string) => (await db.pool.query(`SELECT e.escrow_status, e.security_hold FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = $1`, [r])).rows[0];
    expect(await esc(held)).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });
    expect(await esc(released)).toEqual({ escrow_status: 'RELEASED', security_hold: false }); // never clawed back automatically
    expect((await db.pool.query(`SELECT kind, mpesa_receipt_id FROM reconciliation_exceptions`)).rows).toEqual([{ kind: 'CLAWBACK_DUE', mpesa_receipt_id: released }]);
  });

  it('reversal of a REMITTED escrow (with UFAA): stays REMITTED, no security hold, return kept; one CLAWBACK_DUE naming UFAA', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 7_200_000);
    const remitted = receipt('VU');
    await run(statement([{ receipt: remitted, completion: t, paidIn: '300.00', ac: ag }]));
    await drain();
    const { rows: [ret] } = await db.pool.query(`INSERT INTO ufaa_returns (period_end, status) VALUES ('2026-06-30', 'REMITTED') RETURNING return_id`);
    await db.pool.query(
      `UPDATE escrow_accounts e SET escrow_status = 'REMITTED', ufaa_return_id = $2 FROM transactions t WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1`,
      [remitted, ret.return_id]
    );
    const report = await run(statement([
      { receipt: receipt('RU'), completion: new Date(Date.now() - 3_600_000), withdrawn: '-300.00', details: 'Reversal', reason: 'Reversal', linked: remitted, ac: ag },
    ], { from: new Date(Date.now() - 5_400_000) }));
    expect(report.counts).toMatchObject({ reversalsOfKnown: 1, clawbacksDue: 1 });
    const { rows: [e] } = await db.pool.query(
      `SELECT e.escrow_status, e.security_hold, e.ufaa_return_id FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = $1`,
      [remitted]
    );
    expect(e).toEqual({ escrow_status: 'REMITTED', security_hold: false, ufaa_return_id: ret.return_id });
    const { rows: ex } = await db.pool.query(`SELECT kind, mpesa_receipt_id, detail FROM reconciliation_exceptions`);
    expect(ex).toEqual([{ kind: 'CLAWBACK_DUE', mpesa_receipt_id: remitted, detail: expect.stringMatching(/REMITTED \(with UFAA\)/) }]);
  });

  it('binding: ambiguous (2 candidates) never binds; a single FAILED match → STK_STATUS_CONFLICT, held UNRESOLVED; masked phone matches only its fingerprint', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const u1 = await stkRequest(db.pool, agentId, ag, { status: 'UNKNOWN', amount: 444, ageMin: 40 });
    const u2 = await stkRequest(db.pool, agentId, ag, { status: 'EXPIRED', amount: 444, ageMin: 40 });
    const f = await stkRequest(db.pool, agentId, ag, { status: 'FAILED', amount: 555, ageMin: 40 });
    const m = await stkRequest(db.pool, agentId, ag, { status: 'UNKNOWN', amount: 666, ageMin: 40 });
    const at = (r: { createdAt: Date }) => new Date(r.createdAt.getTime() + 10_000);
    const [ra, rf, rm, rn] = [receipt('BA'), receipt('BF'), receipt('BM'), receipt('BN')];
    const report = await run(statement([
      { receipt: ra, completion: at(u1), paidIn: '444', party: `${CUSTOMER} - A`, ac: ag },
      { receipt: rf, completion: at(f), paidIn: '555', party: `${CUSTOMER} - A`, ac: ag },
      { receipt: rm, completion: at(m), paidIn: '666', party: '2547****678 - A', ac: ag },
      { receipt: rn, completion: at(m), paidIn: '666', party: '2547****679 - A', ac: ag }, // wrong suffix
    ]));
    expect(report.counts).toMatchObject({ boundStk: 1, statusConflicts: 1, unbound: 2 });
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'STK_STATUS_CONFLICT' AND stk_request_id = $1`, [f.id])).toBe(1);
    await drain();
    const st = async (r: string) => (await db.pool.query(`SELECT source_channel, status, last_error FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [r])).rows[0];
    expect(await st(ra)).toMatchObject({ source_channel: 'C2B', status: 'SETTLED' }); // agent code still attributes it
    expect(await st(rf)).toMatchObject({ source_channel: 'DARAJA_STK', status: 'UNRESOLVED' });
    expect((await st(rf)).last_error).toContain('stk_status_conflict_failed');
    expect(await st(rm)).toMatchObject({ source_channel: 'DARAJA_STK', status: 'SETTLED' });
    const consumed = (await db.pool.query(`SELECT stk_request_id, consumed_receipt FROM stk_requests WHERE consumed_receipt IS NOT NULL`)).rows;
    expect(consumed).toEqual([{ stk_request_id: m.id, consumed_receipt: rm }]);
    expect(u2.checkout).toBeNull();
    // Never a fabricated CheckoutRequestID on UNKNOWN / EXPIRED requests.
    expect((await db.pool.query(`SELECT checkout_request_id FROM stk_requests WHERE stk_request_id = $1`, [m.id])).rows[0].checkout_request_id).toBeNull();
  });

  it('two-way: a callback receipt inside the Time Period missing from the statement → RECONCILE_NOT_ON_STATEMENT + hold; RELEASED → exception', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 3_600_000);
    const [missing, rel, listed] = [receipt('NA'), receipt('NB'), receipt('NC')];
    for (const r of [missing, rel, listed]) {
      const body = { TransactionType: 'Pay Bill', TransID: r, TransTime: formatDarajaTime(t), TransAmount: '100.00', BusinessShortCode: SHORTCODE, BillRefNumber: ag, MSISDN: CUSTOMER };
      await insertIntake(db.pool, { receipt: r, hash: idempotencyService.hashPayload(Buffer.from(JSON.stringify(body))), channel: 'C2B', payload: redactPayload(body) });
    }
    await drain();
    await db.pool.query(`UPDATE escrow_accounts e SET escrow_status = 'RELEASED' FROM transactions t WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1`, [rel]);
    const report = await run(statement([{ receipt: listed, completion: t, paidIn: '100.00', ac: ag }]), { env: envWith(TWO_WAY) });
    expect(report.counts).toMatchObject({ verified: 1, notOnStatement: 2, notOnStatementReleased: 1 });
    expect((await db.pool.query(`SELECT mpesa_receipt_id FROM security_events WHERE event_type = 'RECONCILE_NOT_ON_STATEMENT' ORDER BY 1`)).rows.map((r) => r.mpesa_receipt_id)).toEqual([missing, rel].sort());
    expect((await db.pool.query(`SELECT kind, mpesa_receipt_id FROM reconciliation_exceptions`)).rows).toEqual([{ kind: 'RELEASED_NOT_ON_STATEMENT', mpesa_receipt_id: rel }]);
    const { rows: [h] } = await db.pool.query(`SELECT e.escrow_status, e.security_hold FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = $1`, [missing]);
    expect(h).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });
  });

  it('two concurrent sweeps never double-query a row; a callback that won the race is skipped; RECONCILE_MAX_AGE bounds the backlog', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const reqs = [];
    for (let i = 0; i < 12; i++) reqs.push(await stkRequest(db.pool, agentId, ag, { status: 'ACCEPTED', amount: 100 + i, ageMin: 30 }));
    const old = await stkRequest(db.pool, agentId, ag, { status: 'ACCEPTED', amount: 99, ageMin: 8 * 24 * 60 }); // beyond 7 d
    const fresh = await stkRequest(db.pool, agentId, ag, { status: 'ACCEPTED', amount: 98, ageMin: 2 }); // not overdue yet
    // The callback for reqs[0] arrived: it must never be queried.
    const body = stkCallbackBody(receipt('WR'), reqs[0].checkout!, 100, new Date());
    await insertIntake(db.pool, { receipt: (body.Body.stkCallback.CallbackMetadata.Item[1].Value as string), hash: 'k1:' + 'c'.repeat(64), channel: 'DARAJA_STK', payload: redactPayload(body) });

    const queried: string[] = [];
    const daraja = {
      stkQuery: async (id: string): Promise<StkQueryOutcome> => {
        queried.push(id);
        await new Promise((r) => setTimeout(r, 20));
        return { kind: 'FAILED', resultCode: '1032', resultDesc: 'Request cancelled by user' };
      },
    };
    const mk = () => new ReconcileWorker({ pool: db.pool, daraja, sleep: async () => undefined, config: { batchSize: 7, qps: 20 } });
    const [a, b] = await Promise.all([mk().runOnce(), mk().runOnce()]);
    expect(a.length + b.length).toBe(11);
    expect(queried).toHaveLength(11);
    expect(new Set(queried).size).toBe(11);
    expect(queried).not.toContain(reqs[0].checkout);
    expect(queried).not.toContain(old.checkout);
    expect(queried).not.toContain(fresh.checkout);
    expect(await count(db.pool, `SELECT count(*) AS n FROM stk_requests WHERE status = 'FAILED' AND result_code = '1032'`)).toBe(11);
    expect((await db.pool.query(`SELECT status FROM stk_requests WHERE stk_request_id = $1`, [reqs[0].id])).rows[0].status).toBe('ACCEPTED');
  });

  it('attempt cap → RECONCILE_EXHAUSTED; a failure callback for a PAID_UNCONFIRMED request → STK_STATUS_CONFLICT, nothing parked', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const r = await stkRequest(db.pool, agentId, ag, { status: 'ACCEPTED', amount: 10, ageMin: 30 });
    const w = new ReconcileWorker({
      pool: db.pool,
      daraja: { stkQuery: async () => ({ kind: 'PENDING', code: 'result_4999', message: 'still processing' }) },
      sleep: async () => undefined,
      config: { maxAttempts: 2, backoffBaseMs: 0, backoffMaxMs: 0 },
    });
    expect(await w.runOnce()).toEqual(['retry']);
    expect(await w.runOnce()).toEqual(['exhausted']);
    expect((await db.pool.query(`SELECT status, reconcile_attempts FROM stk_requests WHERE stk_request_id = $1`, [r.id])).rows[0]).toEqual({ status: 'RECONCILE_EXHAUSTED', reconcile_attempts: 2 });

    const p = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 11, ageMin: 30 });
    expect(await markStkFailed(db.pool, p.checkout!, '1032', 'Request cancelled by user')).toBe(1);
    expect((await db.pool.query(`SELECT status FROM stk_requests WHERE stk_request_id = $1`, [p.id])).rows[0].status).toBe('PAID_UNCONFIRMED');
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'STK_STATUS_CONFLICT' AND stk_request_id = $1`, [p.id])).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM stk_failed_callbacks`)).toBe(0);
    // A RECONCILE_EXHAUSTED request still takes a late failure callback.
    expect(await markStkFailed(db.pool, r.checkout!, '1037', 'timeout')).toBe(1);
    expect((await db.pool.query(`SELECT status FROM stk_requests WHERE stk_request_id = $1`, [r.id])).rows[0].status).toBe('FAILED');
  });

  it('one importer at a time (session advisory lock)', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const holder = await db.pool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended('salesmesh:reconcile-import', 0))`);
      await expect(run(statement([{ receipt: receipt('LK'), completion: new Date(Date.now() - 60_000), paidIn: '1', ac: ag }]))).rejects.toMatchObject({
        problems: [expect.stringMatching(/another reconciliation import is running/)],
      });
    } finally {
      await holder.query(`SELECT pg_advisory_unlock_all()`);
      holder.release();
    }
  });

  // ── review fixes ────────────────────────────────────────────────────────────

  it('(a) an UNSETTLED callback omitted from the statement, or reversed by it, is QUARANTINED + security-held when it settles', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 3_600_000);
    const [omitted, reversed, listed] = [receipt('UO'), receipt('UR'), receipt('UL')];
    for (const r of [omitted, reversed, listed]) await intakeCallback(c2bBody(r, ag, t));
    // Omitted (two-way, account pinned).
    await run(statement([
      { receipt: listed, completion: t, paidIn: '100.00', ac: ag },
      { receipt: reversed, completion: t, paidIn: '100.00', ac: ag },
    ]), { env: envWith(TWO_WAY) });
    // Reversed by a later statement (two-way off).
    await run(statement([{ receipt: receipt('RV'), completion: new Date(Date.now() - 1_800_000), withdrawn: '-100.00', details: 'Reversal', reason: 'Reversal', linked: reversed, ac: ag }]));
    expect(await events()).toEqual(
      [
        { event_type: 'PAYMENT_REVERSED', mpesa_receipt_id: reversed },
        { event_type: 'RECONCILE_NOT_ON_STATEMENT', mpesa_receipt_id: omitted },
      ]
    );
    // `listed` settles strictly after the two others (a claimed batch has no guaranteed order).
    await db.pool.query(`UPDATE mpesa_callbacks SET next_attempt_at = NOW() + interval '1 hour' WHERE mpesa_receipt_id = $1`, [listed]);
    await drain();
    await db.pool.query(`UPDATE mpesa_callbacks SET next_attempt_at = NOW() WHERE mpesa_receipt_id = $1`, [listed]);
    await drain();
    expect(await escrowOf(omitted)).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });
    expect(await escrowOf(reversed)).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });
    // The listed payment is clean: never security-held. It settles after the two others, whose
    // settlement penalised its agent twice (0.5 → 0.2, spec gh-23): its CLEAR is frozen.
    const { rows } = await db.pool.query(
      `SELECT e.escrow_status, e.security_hold, e.quarantine_reason, a.agent_trust_rating::float8 AS rating
         FROM escrow_accounts e JOIN transactions t USING (transaction_id)
         JOIN sales_agents a ON a.agent_id = t.agent_id
        WHERE t.mpesa_receipt_id = $1`,
      [listed]
    );
    expect(rows[0]).toEqual({ escrow_status: 'QUARANTINED', security_hold: false, quarantine_reason: 'trust_below_threshold', rating: 0.2 });
  });

  it('(b1) a C2B confirmation with a different BillRefNumber for a RECONCILED C2B row → attribution conflict + hold', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 600_000);
    const r = receipt('LC');
    await run(statement([{ receipt: r, completion: t, paidIn: '100.00', ac: ag }]));
    await drain();
    expect((await deliver(c2bBody(r, 'OTHERCODE', t))).status).toBe(200);
    expect(await events()).toEqual([{ event_type: 'RECONCILE_ATTRIBUTION_CONFLICT', mpesa_receipt_id: r }]);
    expect(await escrowOf(r)).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });
    // The matching account confirms (on a fresh row).
    const r2 = receipt('LD');
    await run(statement([{ receipt: r2, completion: t, paidIn: '100.00', ac: ag }]));
    await drain();
    expect((await deliver(c2bBody(r2, ` ${ag.toLowerCase()} `, t))).status).toBe(200);
    expect((await events()).filter((e) => e.mpesa_receipt_id === r2)).toEqual([{ event_type: 'RECONCILED_CALLBACK_LATE', mpesa_receipt_id: r2 }]);
    expect(await escrowOf(r2)).toEqual({ escrow_status: 'HELD', security_hold: false });
  });

  it('(b2) same CheckoutRequestID and amount but a different payer phone → attribution conflict', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const req = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 300, ageMin: 30 });
    const at = new Date(req.createdAt.getTime() + 20_000);
    const r = receipt('LP');
    await run(statement([{ receipt: r, completion: at, initiation: at, paidIn: '300', party: `${CUSTOMER} - X`, ac: ag }]));
    await drain();
    expect((await deliver(stkCallbackBody(r, req.checkout!, 300, at, 254798765432))).status).toBe(200);
    expect(await events()).toEqual([{ event_type: 'RECONCILE_ATTRIBUTION_CONFLICT', mpesa_receipt_id: r }]);
    // A masked phone cannot be compared: never a mismatch.
    const req2 = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 301, ageMin: 30 });
    const at2 = new Date(req2.createdAt.getTime() + 20_000);
    const r2 = receipt('LQ');
    await run(statement([{ receipt: r2, completion: at2, initiation: at2, paidIn: '301', party: `${CUSTOMER} - X`, ac: ag }]));
    await drain();
    expect((await deliver(stkCallbackBody(r2, req2.checkout!, 301, at2, '2547****678'))).status).toBe(200);
    expect((await events()).filter((e) => e.mpesa_receipt_id === r2)).toEqual([{ event_type: 'RECONCILED_CALLBACK_LATE', mpesa_receipt_id: r2 }]);
  });

  it('(b3) row bound to an UNKNOWN request; the callback\'s CheckoutRequestID belongs to ANOTHER request → conflict', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const unknown = await stkRequest(db.pool, agentId, ag, { status: 'UNKNOWN', amount: 410, ageMin: 30 });
    const other = await stkRequest(db.pool, agentId, ag, { status: 'ACCEPTED', amount: 999, ageMin: 30, phone: '254798765432' });
    const at = new Date(unknown.createdAt.getTime() + 20_000);
    const r = receipt('LU');
    await run(statement([{ receipt: r, completion: at, initiation: at, paidIn: '410', party: `${CUSTOMER} - X`, ac: ag }]));
    expect((await db.pool.query(`SELECT stk_request_id FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [r])).rows[0].stk_request_id).toBe(unknown.id);
    await drain();
    expect((await deliver(stkCallbackBody(r, other.checkout!, 410, at))).status).toBe(200);
    expect(await events()).toEqual([{ event_type: 'RECONCILE_ATTRIBUTION_CONFLICT', mpesa_receipt_id: r }]);
    // The lost-answer case: an id never seen + the bound request's phone positively matches → confirmed.
    const unknown2 = await stkRequest(db.pool, agentId, ag, { status: 'UNKNOWN', amount: 411, ageMin: 30 });
    const at2 = new Date(unknown2.createdAt.getTime() + 20_000);
    const r2 = receipt('LV');
    await run(statement([{ receipt: r2, completion: at2, initiation: at2, paidIn: '411', party: '2547****678 - X', ac: ag }]));
    await drain();
    expect((await deliver(stkCallbackBody(r2, 'ws_CO_NEVER_SEEN_2', 411, at2))).status).toBe(200);
    expect((await events()).filter((e) => e.mpesa_receipt_id === r2)).toEqual([{ event_type: 'RECONCILED_CALLBACK_LATE', mpesa_receipt_id: r2 }]);
  });

  it('(b4) ambiguous import → C2B-shaped row; the genuine STK callback of a request of the same agent → confirmed (no hold), request consumed and bound', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const a = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 520, ageMin: 30 });
    await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 520, ageMin: 30 });
    const at = new Date(a.createdAt.getTime() + 20_000);
    const r = receipt('LA');
    const rep = await run(statement([{ receipt: r, completion: at, initiation: at, paidIn: '520', party: `${CUSTOMER} - X`, ac: ag }]));
    expect(rep.counts).toMatchObject({ unbound: 1, boundStk: 0 });
    await drain();
    expect((await deliver(stkCallbackBody(r, a.checkout!, 520, at))).status).toBe(200);
    expect(await events()).toEqual([{ event_type: 'RECONCILED_CALLBACK_LATE', mpesa_receipt_id: r }]);
    expect(await escrowOf(r)).toEqual({ escrow_status: 'HELD', security_hold: false });
    expect((await db.pool.query(`SELECT consumed_receipt FROM stk_requests WHERE stk_request_id = $1`, [a.id])).rows[0].consumed_receipt).toBe(r);
    expect((await db.pool.query(`SELECT stk_request_id FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [r])).rows[0].stk_request_id).toBe(a.id);
  });

  it('(b5) two concurrent DIFFERENT genuine late callbacks → exactly one confirmed, the other a mutation', async () => {
    const ag = code();
    const agentId = await seedAgent(db.pool, ag);
    const req = await stkRequest(db.pool, agentId, ag, { status: 'PAID_UNCONFIRMED', amount: 610, ageMin: 30 });
    const at = new Date(req.createdAt.getTime() + 20_000);
    const r = receipt('LX');
    await run(statement([{ receipt: r, completion: at, initiation: at, paidIn: '610', party: `${CUSTOMER} - X`, ac: ag }]));
    await drain();
    const one = stkCallbackBody(r, req.checkout!, 610, at);
    const two = { ...one, Body: { stkCallback: { ...one.Body.stkCallback, MerchantRequestID: 'm-2' } } };
    const [x, y] = await Promise.all([deliver(one), deliver(two)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(await events()).toEqual([
      { event_type: 'PAYLOAD_MUTATION', mpesa_receipt_id: r },
      { event_type: 'RECONCILED_CALLBACK_LATE', mpesa_receipt_id: r },
    ]);
    const { rows: [cb] } = await db.pool.query(`SELECT confirmed_hash FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`, [r]);
    const late = (await db.pool.query(`SELECT incoming_hash FROM security_events WHERE event_type = 'RECONCILED_CALLBACK_LATE'`)).rows[0];
    expect(cb.confirmed_hash).toBe(late.incoming_hash);
  });

  it('(c) resume after a crash: a stale RUNNING run (any file) becomes FAILED; re-run → COMPLETED, no duplicate rows, evidence reused', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 600_000);
    const file = statement([{ receipt: receipt('CR'), completion: t, paidIn: '10', ac: ag }, { receipt: receipt('CS'), completion: t, paidIn: '20', ac: ag }]);
    const first = await run(file);
    // Simulate a crash mid-run: the run is left RUNNING (its rows are written), plus another file's stale run.
    await db.pool.query(`UPDATE reconciliation_runs SET status = 'RUNNING', finished_at = NULL WHERE run_id = $1`, [first.runId]);
    const opId = (await db.pool.query(`SELECT user_id FROM users WHERE phone_number = $1`, [adminPhone])).rows[0].user_id;
    const { rows: [otherRun] } = await db.pool.query(
      `INSERT INTO reconciliation_runs (file_sha256, operator_user_id, status) VALUES ($1, $2, 'RUNNING') RETURNING run_id`, ['f'.repeat(64), opId]
    );
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(fs.existsSync(path.join(tmp, 'evidence', sha, path.basename(file)))).toBe(true);
    const again = await run(file);
    expect(again).toMatchObject({ outcome: 'COMPLETED', rowsNew: 0, counts: expect.objectContaining({ verified: 2 }) });
    const status = async (id: string) => (await db.pool.query(`SELECT status FROM reconciliation_runs WHERE run_id = $1`, [id])).rows[0].status;
    expect(await status(first.runId)).toBe('FAILED');
    expect(await status(otherRun.run_id)).toBe('FAILED');
    expect(await count(db.pool, `SELECT count(*) AS n FROM mpesa_callbacks`)).toBe(2);
  });

  it('(d) two-way only for callbacks paid to the statement\'s shortcode; skipped (warning) without RECONCILE_EXPECTED_ACCOUNT; above RECONCILE_TWO_WAY_MAX_HOLDS needs --confirm', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 3_600_000);
    const [paybillC2b, stkCb] = [receipt('DP'), receipt('DS')];
    await intakeCallback(c2bBody(paybillC2b, ag, t)); // paid to 174379
    await intakeCallback(stkCallbackBody(stkCb, 'ws_CO_TILL_1', 100, t), 'DARAJA_STK');
    // STK payments go to the till (DARAJA_PARTY_B): a till statement covers them, not the paybill C2B.
    const till = { ...TWO_WAY, DARAJA_PARTY_B: '600100' };
    const tillRep = await run(statement([{ receipt: receipt('DT'), completion: t, paidIn: '5', ac: ag }], { shortCode: '600100' }), { env: envWith(till) });
    expect(tillRep.counts.notOnStatement).toBe(1);
    expect((await events()).map((e) => e.mpesa_receipt_id)).toEqual([stkCb]);
    // The paybill statement covers the C2B callback but not the till's STK callbacks.
    const pbRep = await run(statement([{ receipt: receipt('DU'), completion: t, paidIn: '5', ac: ag }]), { env: envWith(till) });
    expect(pbRep.counts.notOnStatement).toBe(1);
    expect((await events()).map((e) => e.mpesa_receipt_id).sort()).toEqual([paybillC2b, stkCb].sort());

    // Not pinned → skipped with a warning.
    const skipped = await run(statement([{ receipt: receipt('DV'), completion: t, paidIn: '5', ac: ag }]));
    expect(skipped.counts.notOnStatement).toBe(0);
    expect(skipped.warnings).toEqual([expect.stringMatching(/two-way reconciliation skipped.*RECONCILE_EXPECTED_ACCOUNT/)]);

    // Above the cap (6 more + the 2 above; without DARAJA_PARTY_B the STK callback is the paybill's too):
    // the dry run says --confirm is needed; the real run refuses without it.
    for (let i = 0; i < 6; i++) await intakeCallback(c2bBody(receipt('DM'), ag, t));
    const file = statement([{ receipt: receipt('DW'), completion: t, paidIn: '5', ac: ag }]);
    const dry = await run(file, { env: envWith(TWO_WAY), dryRun: true });
    expect(dry.confirmRequired).toEqual([expect.stringMatching(/8 callback receipt\(s\) missing.*RECONCILE_TWO_WAY_MAX_HOLDS \(5\)/)]);
    await expect(run(file, { env: envWith(TWO_WAY) })).rejects.toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/RECONCILE_TWO_WAY_MAX_HOLDS/)]) });
    expect((await run(file, { env: envWith(TWO_WAY), confirm: true })).counts.notOnStatement).toBe(8);
  });

  it('a known callback receipt listed as NOT a completed sale → attribution conflict + hold; a dry run reports every --confirm cap', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const t = new Date(Date.now() - 600_000);
    const r = receipt('NS');
    await intakeCallback(c2bBody(r, ag, t));
    await drain();
    const capped = envWith({ RECONCILE_CONFIRM_MAX_ROWS: '0', RECONCILE_CONFIRM_MAX_AMOUNT: '0' });
    const file = statement([
      { receipt: r, completion: t, paidIn: '100.00', status: 'Failed', ac: ag },
      { receipt: receipt('NT'), completion: t, paidIn: '50.00', ac: ag },
    ]);
    const dry = await run(file, { env: capped, dryRun: true });
    expect(dry.confirmRequired).toEqual([
      expect.stringMatching(/RECONCILE_CONFIRM_MAX_ROWS/),
      expect.stringMatching(/RECONCILE_CONFIRM_MAX_AMOUNT/),
    ]);
    expect(dry.counts.attributionConflicts).toBe(1);
    expect(await events()).toEqual([]); // dry run writes nothing
    await run(file, { env: capped, confirm: true });
    expect(await events()).toEqual([{ event_type: 'RECONCILE_ATTRIBUTION_CONFLICT', mpesa_receipt_id: r }]);
    expect(await escrowOf(r)).toEqual({ escrow_status: 'QUARANTINED', security_hold: true });
  });

  it('(e) real CSV content saved as .txt is refused (only .csv)', async () => {
    const ag = code();
    await seedAgent(db.pool, ag);
    const csv = statement([{ receipt: receipt('TX'), completion: new Date(Date.now() - 60_000), paidIn: '1', ac: ag }]);
    const txt = csv.replace(/\.csv$/, '.txt');
    fs.copyFileSync(csv, txt);
    await expect(run(txt)).rejects.toMatchObject({ problems: [expect.stringMatching(/only \.csv statements/)] });
    expect(await count(db.pool, `SELECT count(*) AS n FROM reconciliation_runs`)).toBe(0);
  });
});
