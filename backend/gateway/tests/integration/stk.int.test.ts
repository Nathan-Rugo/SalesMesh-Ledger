/**
 * STK initiation against real Postgres (spec gh-5 acceptance criteria):
 *  - 10 concurrent requests with one Idempotency-Key → Daraja called exactly once, 10 equal outcomes;
 *  - initiation → callback → settlement worker attributes the payment to the agent;
 *  - an initiation whose Daraja response timed out (UNKNOWN) → its callback is attributed by the
 *    fallback match (phone HMAC, amount, window) and settled;
 *  - ambiguous fallback fails closed; a failed callback marks the request FAILED.
 */

import crypto from 'crypto';
import express from 'express';
import Redis from 'ioredis';
import { RedisThrottleStore, StkRateLimiter, type ThrottleStore } from '../../src/auth/throttle';
import { signAccessToken } from '../../src/auth/tokens';
import { PaymentsController } from '../../src/controllers/payments.controller';
import { DarajaClient } from '../../src/daraja/client';
import { formatDarajaTime, msisdnMaskHash, redactPayload } from '../../src/domain/callback';
import { insertIntake } from '../../src/repositories/intake.repository';
import { markStkFailed } from '../../src/repositories/stk.repository';
import { createPaymentsRouter } from '../../src/routes/payments.routes';
import { createUser, parseArgs } from '../../src/scripts/user-create';
import { idempotencyService } from '../../src/services/idempotency.service';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { ResilientRiskClient } from '../../src/services/risk_client.service';
import { SettlementWorker } from '../../src/workers/settlement.worker';
import { accepted, darajaFetch, TEST_DARAJA_CONFIG, type StkHandler } from '../support/daraja-fetch';
import { listen, type TestServer } from '../support/http';
import { MemoryThrottleStore } from '../support/memory-store';
import { count, createTestDb, describeDb, INIT_SQL, mlStub, type TestDb } from './helpers';

jest.setTimeout(120_000);

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const CUSTOMER = '254712345678';

describeDb('STK initiation → callback → settlement (real Postgres)', () => {
  let db: TestDb;
  let redis: Redis | null = null;
  let store: ThrottleStore;
  let srv: TestServer;
  let stkHandler: StkHandler;
  let daraja: ReturnType<typeof darajaFetch>;

  beforeAll(async () => {
    process.env.STK_ENABLED = 'true';
    db = await createTestDb('sm_stk');
    await db.pool.query(INIT_SQL);
    await db.pool.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('OUT-1', 'Nairobi', 100000)`);
    if (TEST_REDIS_URL) {
      redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
      store = new RedisThrottleStore(redis);
    } else store = new MemoryThrottleStore();
    daraja = darajaFetch((b, n) => stkHandler(b, n));
    const controller = new PaymentsController({
      db: db.pool,
      // Well above the fake Daraja's 100 ms latency (CPU-starved runs); 'timeout' cases wait this long.
      daraja: new DarajaClient({ ...TEST_DARAJA_CONFIG, timeoutMs: 2000 }, daraja.fn as any, new GatewayMetrics()),
      rateLimiter: new StkRateLimiter(store, 1000),
      metrics: new GatewayMetrics(),
      config: { darajaTotalTimeoutMs: 10_000, waiterTimeoutMs: 12_000, stalePendingMs: 20_000, pollIntervalMs: 25 },
    });
    const app = express();
    app.use('/api/v1/payments', createPaymentsRouter(controller));
    srv = await listen(app);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await srv?.close();
    await redis?.quit();
    await db?.drop();
  });
  beforeEach(() => {
    for (const level of ['info', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
    daraja.calls.stk = 0;
    stkHandler = () => accepted();
  });

  async function agent() {
    const code = `A${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 12);
    const r = await createUser(
      db.pool,
      parseArgs(['--role', 'SALES_AGENT', '--name', 'Agent', '--phone', `07${crypto.randomInt(10_000_000, 99_999_999)}`, '--agent-code', code, '--outlet', 'OUT-1'])
    );
    const token = (await signAccessToken({ userId: r.userId, role: 'SALES_AGENT', pinChangeRequired: false })).token;
    return { ...r, code, token };
  }

  const initiate = (token: string, key: string, body: Record<string, unknown> = { amount: 1500, phone: '0712345678' }) =>
    srv.request('POST', '/api/v1/payments/stk', { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body });

  async function stkCallback(receipt: string, checkoutRequestId: string, amount: number, paidAt: Date, phone: unknown = Number(CUSTOMER)) {
    const body = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'm-1',
          CheckoutRequestID: checkoutRequestId,
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: amount },
              { Name: 'MpesaReceiptNumber', Value: receipt },
              { Name: 'TransactionDate', Value: Number(formatDarajaTime(paidAt)) },
              { Name: 'PhoneNumber', Value: phone },
            ],
          },
        },
      },
    };
    await insertIntake(db.pool, {
      receipt,
      hash: idempotencyService.hashPayload(Buffer.from(JSON.stringify(body))),
      channel: 'DARAJA_STK',
      payload: redactPayload(body),
    });
  }

  // unresolvedWindowMs 0: a retryable UNRESOLVED goes straight to review, so drain() terminates.
  const worker = () =>
    new SettlementWorker({
      pool: db.pool,
      riskClient: new ResilientRiskClient(),
      spool: null,
      config: { unresolvedBaseDelayMs: 0, unresolvedWindowMs: 0 },
    });
  async function drain(w: SettlementWorker) {
    while ((await w.runOnce()) > 0) {
      /* keep going */
    }
  }

  it('10 concurrent requests with one Idempotency-Key → Daraja called exactly once; all 10 get the same outcome', async () => {
    const a = await agent();
    stkHandler = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return accepted({ CheckoutRequestID: 'ws_CO_CONCURRENT' });
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => initiate(a.token, 'same-key-1')));
    expect(daraja.calls.stk).toBe(1);
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM stk_requests WHERE agent_id = $1`, [a.agentId])).toBe(1);
  });

  it('initiation → callback → the settlement worker resolves the agent and consumes the request', async () => {
    const a = await agent();
    mlStub(() => ({ decision: 'CLEAR' }));
    stkHandler = () => accepted({ CheckoutRequestID: 'ws_CO_E2E_1' });
    const res = await initiate(a.token, 'e2e-1');
    expect(res.status).toBe(201);
    const { rows: [row] } = await db.pool.query(`SELECT * FROM stk_requests WHERE stk_request_id = $1`, [res.body.stk_request_id]);
    expect(row).toMatchObject({ status: 'ACCEPTED', checkout_request_id: 'ws_CO_E2E_1', account_reference: a.code, idempotency_key: 'e2e-1' });
    expect(row.phone_hash).toMatch(/^k1:/);
    // spec gh-6-recon: the masked-phone fingerprint a masked statement phone is matched against
    expect(row.phone_mask_hash).toBe(msisdnMaskHash('254712345678'));
    expect(JSON.stringify(row)).not.toContain('712345678');

    // gh-60: GET status reads consumed_receipt through the real SELECT.
    const status = () => srv.request('GET', `/api/v1/payments/stk/${res.body.stk_request_id}`, { headers: { Authorization: `Bearer ${a.token}` } });
    expect((await status()).body).toMatchObject({ status: 'ACCEPTED', paid: false, receipt: null });

    await stkCallback('E2EA000001', 'ws_CO_E2E_1', 1500, new Date(Date.now() + 2000));
    await drain(worker());
    expect((await status()).body).toMatchObject({ paid: true, receipt: 'E2EA000001' });
    const { rows: [tx] } = await db.pool.query(`SELECT agent_id, source_channel FROM transactions WHERE mpesa_receipt_id = 'E2EA000001'`);
    expect(tx).toEqual({ agent_id: a.agentId, source_channel: 'DARAJA_STK' });
    const { rows: [after] } = await db.pool.query(`SELECT consumed_receipt, fallback_bound_at FROM stk_requests WHERE stk_request_id = $1`, [row.stk_request_id]);
    expect(after).toEqual({ consumed_receipt: 'E2EA000001', fallback_bound_at: null });
  });

  it('Daraja response lost (UNKNOWN) → its callback is attributed by the fallback match and settled', async () => {
    const a = await agent();
    mlStub(() => ({ decision: 'CLEAR' }));
    stkHandler = () => 'timeout';
    const res = await initiate(a.token, 'lost-1', { amount: 2300, phone: '0712345678' });
    expect(res).toMatchObject({ status: 202, body: { status: 'UNKNOWN' } });

    // Daraja did prompt the customer; the callback carries a CheckoutRequestID we never saw.
    await stkCallback('LOST000001', 'ws_CO_NEVER_SEEN', 2300, new Date(Date.now() + 3000));
    await drain(worker());

    const { rows: [cb] } = await db.pool.query(`SELECT status, last_error FROM mpesa_callbacks WHERE mpesa_receipt_id = 'LOST000001'`);
    expect(cb.status).toBe('SETTLED');
    const { rows: [tx] } = await db.pool.query(`SELECT agent_id FROM transactions WHERE mpesa_receipt_id = 'LOST000001'`);
    expect(tx.agent_id).toBe(a.agentId);
    const { rows: [stk] } = await db.pool.query(`SELECT * FROM stk_requests WHERE stk_request_id = $1`, [res.body.stk_request_id]);
    expect(stk).toMatchObject({ status: 'ACCEPTED', checkout_request_id: 'ws_CO_NEVER_SEEN', consumed_receipt: 'LOST000001' });
    expect(stk.fallback_bound_at).not.toBeNull();
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.mpesa_receipt_id = 'LOST000001'`)).toBe(1);

    // The same receipt delivered again settles nothing new; a second receipt for that request is a replay.
    await stkCallback('LOST000002', 'ws_CO_NEVER_SEEN', 2300, new Date(Date.now() + 4000));
    await drain(worker());
    const { rows: [second] } = await db.pool.query(`SELECT status, last_error FROM mpesa_callbacks WHERE mpesa_receipt_id = 'LOST000002'`);
    expect(second.status).toBe('UNRESOLVED');
    expect(second.last_error).toContain('stk_receipt_replay');
  });

  it('fallback outside the window, with a masked phone, or ambiguous → never binds (UNRESOLVED)', async () => {
    const a = await agent();
    const b = await agent();
    mlStub(() => ({ decision: 'CLEAR' }));
    stkHandler = () => 'timeout';
    await initiate(a.token, 'amb-a', { amount: 777, phone: '0712345678' });
    await initiate(b.token, 'amb-b', { amount: 777, phone: '0712345678' });
    await stkCallback('AMBG000001', 'ws_CO_AMB', 777, new Date(Date.now() + 1000));
    await stkCallback('MASK000001', 'ws_CO_MASK', 777, new Date(Date.now() + 1000), '2547****678');
    await stkCallback('LATE000001', 'ws_CO_LATE', 777, new Date(Date.now() + 200_000)); // beyond STK_TTL (180 s)
    await drain(worker());

    const { rows } = await db.pool.query(
      `SELECT mpesa_receipt_id, status, last_error, next_attempt_at = 'infinity' AS terminal FROM mpesa_callbacks
        WHERE mpesa_receipt_id IN ('AMBG000001', 'MASK000001', 'LATE000001') ORDER BY 1`
    );
    expect(rows.map((r) => r.status)).toEqual(['UNRESOLVED', 'UNRESOLVED', 'UNRESOLVED']);
    expect(rows[0]).toMatchObject({ mpesa_receipt_id: 'AMBG000001', terminal: true });
    expect(rows[0].last_error).toContain('stk_fallback_ambiguous');
    expect(rows[1].last_error).toContain('stk_unknown_checkout_request_id');
    expect(rows[2].last_error).toContain('stk_unknown_checkout_request_id');
    expect(await count(db.pool, `SELECT count(*) AS n FROM stk_requests WHERE amount = 777 AND checkout_request_id IS NOT NULL`)).toBe(0);
  });

  it('a failed STK callback marks the request FAILED; replays reflect it', async () => {
    const a = await agent();
    stkHandler = () => accepted({ CheckoutRequestID: 'ws_CO_CANCELLED' });
    expect((await initiate(a.token, 'fail-1', { amount: 50, phone: '0712345678' })).status).toBe(201);
    expect(await markStkFailed(db.pool, 'ws_CO_CANCELLED', '1032', 'Request cancelled by user')).toBe(1);
    const replay = await initiate(a.token, 'fail-1', { amount: 50, phone: '0712345678' });
    expect(replay).toMatchObject({ status: 201, body: { status: 'FAILED', result_code: '1032' } });
    expect(daraja.calls.stk).toBe(1);
    expect(await markStkFailed(db.pool, 'ws_CO_UNKNOWN', '1037', 'timeout')).toBe(0);
  });

  it('PENDING left by a crash is moved to UNKNOWN by a later replay (202), and becomes a fallback candidate', async () => {
    const a = await agent();
    stkHandler = () => accepted();
    // Simulate a process that claimed the key and died before recording Daraja's answer.
    const fp = (await import('../../src/config/pii')).keyedHash('stk_fingerprint', 'msisdn:254712345678|amount:60');
    await db.pool.query(
      `INSERT INTO stk_requests (agent_id, idempotency_key, request_fingerprint, phone_hash, amount, account_reference, status, claimed_at, created_at)
       VALUES ($1, 'crash-1', $2, 'k1:x', 60, $3, 'PENDING', NOW() - interval '30 seconds', NOW() - interval '30 seconds')`,
      [a.agentId, fp, a.code]
    );
    const res = await initiate(a.token, 'crash-1', { amount: 60, phone: '0712345678' });
    expect(res).toMatchObject({ status: 202, body: { status: 'UNKNOWN' } });
    expect(daraja.calls.stk).toBe(0);
    expect((await db.pool.query(`SELECT status FROM stk_requests WHERE idempotency_key = 'crash-1'`)).rows[0].status).toBe('UNKNOWN');
  });

  it('duplicate guard (Postgres): same agent/phone/amount under a new key within 60 s → 409; confirm_duplicate → 201', async () => {
    const a = await agent();
    stkHandler = () => accepted();
    expect((await initiate(a.token, 'dup-1', { amount: 321, phone: '0712345678' })).status).toBe(201);
    expect(await initiate(a.token, 'dup-2', { amount: 321, phone: '0712345678' })).toMatchObject({ status: 409, body: { error: 'possible_duplicate' } });
    expect((await initiate(a.token, 'dup-3', { amount: 321, phone: '0712345678', confirm_duplicate: true })).status).toBe(201);
    expect(daraja.calls.stk).toBe(2);
  });

  it('duplicate guard is serialised: two concurrent requests with different keys → one prompt, one 409', async () => {
    const a = await agent();
    stkHandler = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return accepted();
    };
    const [x, y] = await Promise.all([
      initiate(a.token, 'race-1', { amount: 654, phone: '0712345678' }),
      initiate(a.token, 'race-2', { amount: 654, phone: '0712345678' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error).toBe('possible_duplicate');
    expect(daraja.calls.stk).toBe(1);
  });

  it('a failure callback that races ahead of recording Daraja\'s answer is kept and applied (FAILED, not ACCEPTED forever)', async () => {
    const a = await agent();
    stkHandler = async () => {
      // The customer cancels and Safaricom's callback lands before our Daraja response is recorded.
      expect(await markStkFailed(db.pool, 'ws_CO_RACE_1', '1032', 'Request cancelled by user')).toBe(0);
      return accepted({ CheckoutRequestID: 'ws_CO_RACE_1' });
    };
    const res = await initiate(a.token, 'race-fail-1', { amount: 70, phone: '0712345678' });
    expect(res).toMatchObject({ status: 201, body: { status: 'FAILED', result_code: '1032' } });
    const { rows: [row] } = await db.pool.query(`SELECT status, checkout_request_id, result_code FROM stk_requests WHERE stk_request_id = $1`, [res.body.stk_request_id]);
    expect(row).toEqual({ status: 'FAILED', checkout_request_id: 'ws_CO_RACE_1', result_code: '1032' });
    expect(await count(db.pool, `SELECT count(*) AS n FROM stk_failed_callbacks WHERE checkout_request_id = 'ws_CO_RACE_1'`)).toBe(0);
    const status = await srv.request('GET', `/api/v1/payments/stk/${res.body.stk_request_id}`, { headers: { Authorization: `Bearer ${a.token}` } });
    expect(status).toMatchObject({ status: 200, body: { status: 'FAILED', result_code: '1032' } });
  });

  it('UNKNOWN requests no callback can match any more → EXPIRED by housekeeping; out of the guard and the fallback', async () => {
    const a = await agent();
    mlStub(() => ({ decision: 'CLEAR' }));
    stkHandler = () => 'timeout';
    const res = await initiate(a.token, 'exp-1', { amount: 88, phone: '0712345678' });
    expect(res.body.status).toBe('UNKNOWN');
    await db.pool.query(`UPDATE stk_requests SET created_at = NOW() - interval '14 minutes', claimed_at = NOW() - interval '14 minutes' WHERE stk_request_id = $1`, [res.body.stk_request_id]);
    await worker().stkAndAuthHousekeeping();
    expect((await db.pool.query(`SELECT status FROM stk_requests WHERE stk_request_id = $1`, [res.body.stk_request_id])).rows[0].status).toBe('EXPIRED');
    expect(await initiate(a.token, 'exp-1', { amount: 88, phone: '0712345678' })).toMatchObject({ status: 200, body: { status: 'EXPIRED' } });
    // A late callback inside its old window cannot bind to an EXPIRED request.
    await stkCallback('EXPD000001', 'ws_CO_EXPD', 88, new Date(Date.now() - 13 * 60_000));
    await drain(worker());
    expect((await db.pool.query(`SELECT status FROM mpesa_callbacks WHERE mpesa_receipt_id = 'EXPD000001'`)).rows[0].status).toBe('UNRESOLVED');
  });

  it('clock skew: Safaricom TransactionDate up to STK_CLOCK_SKEW_MS before our created_at still matches', async () => {
    const a = await agent();
    mlStub(() => ({ decision: 'CLEAR' }));
    stkHandler = () => 'timeout';
    const res = await initiate(a.token, 'skew-1', { amount: 99, phone: '0712345678' });
    expect(res.body.status).toBe('UNKNOWN');
    await stkCallback('SKEW000001', 'ws_CO_SKEW', 99, new Date(Date.now() - 30_000)); // their clock 30 s behind ours
    await drain(worker());
    expect((await db.pool.query(`SELECT status FROM mpesa_callbacks WHERE mpesa_receipt_id = 'SKEW000001'`)).rows[0].status).toBe('SETTLED');
    expect((await db.pool.query(`SELECT checkout_request_id FROM stk_requests WHERE stk_request_id = $1`, [res.body.stk_request_id])).rows[0].checkout_request_id).toBe('ws_CO_SKEW');
  });
});
