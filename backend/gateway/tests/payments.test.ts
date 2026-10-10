/**
 * @file payments.test.ts
 * @description POST /api/v1/payments/stk (spec gh-5 I/O matrix): validation, RBAC, agent from the
 * token, idempotency (replay, concurrent waiters, stale PENDING), soft duplicate guard, rate
 * limit, Daraja outcomes → 201/202/502. Daraja mocked via fetch; Redis via an in-memory store.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('../src/repositories/stk.repository', () => require('./support/memory-stk-repo'));
const mockAgents = new Map<string, { agentId: string; agentCode: string | null; userDisabled: boolean }>();
jest.mock('../src/repositories/agent.repository', () => ({
  findAgentForUser: jest.fn(async (_db: unknown, userId: string) => mockAgents.get(userId) ?? null),
}));

import crypto from 'crypto';
import express from 'express';
import { StkRateLimiter } from '../src/auth/throttle';
import { signAccessToken } from '../src/auth/tokens';
import { PaymentsController } from '../src/controllers/payments.controller';
import { DarajaClient } from '../src/daraja/client';
import { msisdnHash } from '../src/domain/callback';
import { createPaymentsRouter } from '../src/routes/payments.routes';
import { GatewayMetrics } from '../src/services/metrics.service';
import { accepted, darajaFetch, TEST_DARAJA_CONFIG, type StkHandler } from './support/daraja-fetch';
import { listen, type TestServer } from './support/http';
import { MemoryThrottleStore } from './support/memory-store';
import { memStk, seedStk } from './support/memory-stk-repo';

const AGENT_USER = crypto.randomUUID();
const AGENT_ID = crypto.randomUUID();
const fakeClient = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() };
const fakeDb: any = { query: jest.fn(), connect: jest.fn(async () => fakeClient) };

let srv: TestServer;
let store: MemoryThrottleStore;
let stkHandler: StkHandler;
let fetchMock: ReturnType<typeof darajaFetch>;
let metrics: GatewayMetrics;
let controller: PaymentsController;

const token = async (role: 'SALES_AGENT' | 'MERCHANT_ADMIN' = 'SALES_AGENT', userId = AGENT_USER, pinChangeRequired = false) =>
  (await signAccessToken({ userId, role, pinChangeRequired })).token;

async function initiate(body: unknown, key: string | null = 'key-1', opts: { auth?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.auth ?? (await token())}` };
  if (key !== null) headers['Idempotency-Key'] = key;
  return srv.request('POST', '/api/v1/payments/stk', { headers, body });
}
const OK_BODY = { amount: 1500, phone: '0712345678' };

beforeAll(async () => {
  process.env.STK_ENABLED = 'true';
  store = new MemoryThrottleStore();
  metrics = new GatewayMetrics();
  fetchMock = darajaFetch((b, n) => stkHandler(b, n));
  // Margins well above the fake Daraja's latency, so a CPU-starved run cannot turn 201 into 202/409.
  const daraja = new DarajaClient({ ...TEST_DARAJA_CONFIG, timeoutMs: 1000 }, fetchMock.fn as any, metrics);
  controller = new PaymentsController({
    db: fakeDb,
    daraja,
    rateLimiter: new StkRateLimiter(store, 5),
    metrics,
    config: { darajaTotalTimeoutMs: 5000, waiterTimeoutMs: 5000, stalePendingMs: 15_000, pollIntervalMs: 20 },
  });
  const app = express();
  app.use('/api/v1/payments', createPaymentsRouter(controller));
  srv = await listen(app);
});
afterAll(() => srv.close());

let logs: jest.SpyInstance[];
beforeEach(() => {
  memStk.reset();
  mockAgents.clear();
  mockAgents.set(AGENT_USER, { agentId: AGENT_ID, agentCode: 'AG042', userDisabled: false });
  store.down = false;
  for (const k of store.keys()) void store.del(k);
  fetchMock.calls.stk = 0;
  fetchMock.calls.stkBodies.length = 0;
  stkHandler = () => accepted({ CheckoutRequestID: 'ws_CO_OK' });
  process.env.STK_ENABLED = 'true';
  logs = (['info', 'warn', 'error', 'log'] as const).map((l) => jest.spyOn(console, l).mockImplementation(() => undefined));
});
afterEach(() => {
  const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
  expect(logged).not.toMatch(/712345678|0712|tok-1/); // no raw MSISDN or token in any log line
  logs.forEach((s) => s.mockRestore());
});

describe('STK OK', () => {
  it('201 with the request id and customer message; the row is ACCEPTED with its CheckoutRequestID, phone stored only as an HMAC', async () => {
    const res = await initiate(OK_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      stk_request_id: memStk.rows[0].stkRequestId,
      status: 'ACCEPTED',
      checkout_request_id: 'ws_CO_OK',
      customer_message: 'Success. Request accepted for processing',
    });
    const row = memStk.rows[0];
    expect(row).toMatchObject({ agentId: AGENT_ID, status: 'ACCEPTED', checkoutRequestId: 'ws_CO_OK', amount: 1500, accountReference: 'AG042' });
    expect(row.phoneHash).toBe(msisdnHash('254712345678'));
    expect(JSON.stringify(memStk.rows)).not.toMatch(/712345678/);
    expect(fetchMock.calls.stkBodies[0]).toMatchObject({ Amount: 1500, PartyA: 254712345678, PhoneNumber: 254712345678, AccountReference: 'AG042' });
  });

  it('the agent comes from the token, never the body', async () => {
    await initiate({ ...OK_BODY, agent_id: crypto.randomUUID(), agent_code: 'AG999' });
    expect(memStk.rows[0]).toMatchObject({ agentId: AGENT_ID, accountReference: 'AG042' });
    expect(fetchMock.calls.stkBodies[0].AccountReference).toBe('AG042');
  });
});

describe('STK invalid → 400 with a field error; Daraja not called', () => {
  it.each([
    [{ amount: 10.5, phone: '0712345678' }, 'amount'],
    [{ amount: 0, phone: '0712345678' }, 'amount'],
    [{ amount: -5, phone: '0712345678' }, 'amount'],
    [{ amount: 250_001, phone: '0712345678' }, 'amount'],
    [{ amount: '12abc', phone: '0712345678' }, 'amount'],
    [{ phone: '0712345678' }, 'amount'],
    [{ amount: 100, phone: '0812345678' }, 'phone'],
    [{ amount: 100, phone: '2547123' }, 'phone'],
    [{ amount: 100 }, 'phone'],
    [{ amount: 100, phone: '0712345678', confirm_duplicate: 'yes' }, 'confirm_duplicate'],
  ])('%j → field %s', async (body, field) => {
    const res = await initiate(body);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
    expect(fetchMock.calls.stk).toBe(0);
    expect(memStk.rows).toHaveLength(0);
  });

  it('missing or malformed Idempotency-Key → 400', async () => {
    expect((await initiate(OK_BODY, null)).body.fields).toHaveProperty('Idempotency-Key');
    expect((await initiate(OK_BODY, 'bad key with spaces')).status).toBe(400);
    expect(fetchMock.calls.stk).toBe(0);
  });

  it('accepts 1 and 250 000, whole shillings as a digit string, 01… / +254… phones', async () => {
    expect((await initiate({ amount: 1, phone: '0112345678' }, 'k-a')).status).toBe(201);
    expect((await initiate({ amount: '250000', phone: '+254 712 345 670' }, 'k-b')).status).toBe(201);
    expect(fetchMock.calls.stkBodies.map((b) => [b.Amount, b.PhoneNumber])).toEqual([[1, 254112345678], [250000, 254712345670]]);
  });
});

describe('RBAC and provisioning', () => {
  it('no token → 401; MERCHANT_ADMIN → 403; pin_change_required → 403', async () => {
    expect((await srv.request('POST', '/api/v1/payments/stk', { body: OK_BODY, headers: { 'Idempotency-Key': 'k' } })).status).toBe(401);
    expect(await initiate(OK_BODY, 'k', { auth: await token('MERCHANT_ADMIN') })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await initiate(OK_BODY, 'k', { auth: await token('SALES_AGENT', AGENT_USER, true) })).toMatchObject({
      status: 403,
      body: { error: 'pin_change_required' },
    });
    expect(fetchMock.calls.stk).toBe(0);
  });

  it('a SALES_AGENT with no sales_agents row, or no agent_code → 409 agent_not_provisioned', async () => {
    const orphan = crypto.randomUUID();
    expect(await initiate(OK_BODY, 'k', { auth: await token('SALES_AGENT', orphan) })).toMatchObject({ status: 409, body: { error: 'agent_not_provisioned' } });
    mockAgents.set(orphan, { agentId: crypto.randomUUID(), agentCode: null, userDisabled: false });
    expect(await initiate(OK_BODY, 'k', { auth: await token('SALES_AGENT', orphan) })).toMatchObject({ status: 409, body: { error: 'agent_not_provisioned' } });
    expect(fetchMock.calls.stk).toBe(0);
  });

  it('a disabled agent with a still-valid access token → 403 account_disabled; Daraja not called', async () => {
    mockAgents.set(AGENT_USER, { agentId: AGENT_ID, agentCode: 'AG042', userDisabled: true });
    expect(await initiate(OK_BODY)).toMatchObject({ status: 403, body: { error: 'account_disabled' } });
    expect(fetchMock.calls.stk).toBe(0);
    expect(memStk.rows).toHaveLength(0);
  });

  it('STK disabled → 503 stk_disabled', async () => {
    process.env.STK_ENABLED = 'false';
    expect(await initiate(OK_BODY)).toMatchObject({ status: 503, body: { error: 'stk_disabled' } });
  });
});

describe('idempotency', () => {
  it('replay with the same key and body → the original response; Daraja is not called again', async () => {
    const first = await initiate(OK_BODY, 'key-r');
    const again = await initiate(OK_BODY, 'key-r');
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(fetchMock.calls.stk).toBe(1);
  });

  it('same key, different body → 409 idempotency_key_reused', async () => {
    await initiate(OK_BODY, 'key-d');
    expect(await initiate({ ...OK_BODY, amount: 1501 }, 'key-d')).toMatchObject({ status: 409, body: { error: 'idempotency_key_reused' } });
    expect(await initiate({ ...OK_BODY, phone: '0712345679' }, 'key-d')).toMatchObject({ status: 409 });
    expect(fetchMock.calls.stk).toBe(1);
  });

  it('10 concurrent requests with one key → Daraja called exactly once, all get the same outcome', async () => {
    stkHandler = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return accepted({ CheckoutRequestID: 'ws_CO_CONC' });
    };
    const auth = await token();
    const results = await Promise.all(Array.from({ length: 10 }, () => initiate(OK_BODY, 'key-c', { auth })));
    expect(fetchMock.calls.stk).toBe(1);
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('a waiter that outlives the Daraja timeout → 409 idempotency_in_progress with Retry-After', async () => {
    const fp = (await import('../src/config/pii')).keyedHash('stk_fingerprint', 'msisdn:254712345678|amount:1500');
    seedStk({ agentId: AGENT_ID, idempotencyKey: 'key-w', requestFingerprint: fp, amount: 1500 });
    const saved = controller.config.waiterTimeoutMs;
    controller.config.waiterTimeoutMs = 300; // the row never resolves: wait only briefly
    const res = await initiate(OK_BODY, 'key-w').finally(() => {
      controller.config.waiterTimeoutMs = saved;
    });
    expect(res).toMatchObject({ status: 409, body: { error: 'idempotency_in_progress' } });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(fetchMock.calls.stk).toBe(0);
  });

  it('a replay finding PENDING older than the Daraja timeout + 10 s → UNKNOWN and 202', async () => {
    const fp = (await import('../src/config/pii')).keyedHash('stk_fingerprint', 'msisdn:254712345678|amount:1500');
    const row = seedStk({ agentId: AGENT_ID, idempotencyKey: 'key-s', requestFingerprint: fp, amount: 1500, claimedAt: Date.now() - (controller.config.stalePendingMs + 1_000) });
    const res = await initiate(OK_BODY, 'key-s');
    expect(res).toMatchObject({ status: 202, body: { status: 'UNKNOWN', stk_request_id: row.stkRequestId } });
    expect(row.status).toBe('UNKNOWN');
    expect(fetchMock.calls.stk).toBe(0);
  });

  it('a fingerprint made under a PII key no longer configured is unverifiable → treated as a match (stored outcome, not 409)', async () => {
    await initiate(OK_BODY, 'key-k');
    memStk.rows[0].requestFingerprint = `k9:${'a'.repeat(64)}`; // a retired key id
    const replay = await initiate(OK_BODY, 'key-k');
    expect(replay).toMatchObject({ status: 201, body: { status: 'ACCEPTED', checkout_request_id: 'ws_CO_OK' } });
    memStk.rows[0].requestFingerprint = `k1:${'a'.repeat(64)}`; // configured key, provably different
    expect(await initiate(OK_BODY, 'key-k')).toMatchObject({ status: 409, body: { error: 'idempotency_key_reused' } });
    expect(fetchMock.calls.stk).toBe(1);
  });

  it('an EXPIRED request replays as EXPIRED (no confirmation; check before resending)', async () => {
    stkHandler = () => 'timeout';
    await initiate(OK_BODY, 'key-e');
    memStk.rows[0].status = 'EXPIRED';
    expect(await initiate(OK_BODY, 'key-e')).toMatchObject({ status: 200, body: { status: 'EXPIRED' } });
  });

  it('replays reflect the latest status (a failed STK callback → FAILED with its code)', async () => {
    await initiate(OK_BODY, 'key-f');
    Object.assign(memStk.rows[0], { status: 'FAILED', resultCode: '1032' });
    expect(await initiate(OK_BODY, 'key-f')).toMatchObject({ status: 201, body: { status: 'FAILED', result_code: '1032' } });
  });
});

describe('Daraja outcomes', () => {
  it('ResponseCode ≠ 0 or a 4xx errorCode → row REJECTED with the code; 502 with a safe message', async () => {
    stkHandler = () => ({ status: 200, body: { ResponseCode: '1', ResponseDescription: 'Rejected 254712345678' } });
    const a = await initiate(OK_BODY, 'key-x1');
    expect(a).toMatchObject({ status: 502, body: { status: 'REJECTED', error: 'stk_rejected', code: '1' } });
    expect(JSON.stringify(a.body)).not.toMatch(/712345678/);
    stkHandler = () => ({ status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid Amount' } });
    expect(await initiate({ ...OK_BODY, amount: 99 }, 'key-x2')).toMatchObject({ status: 502, body: { code: '400.002.02' } });
    expect(memStk.rows.map((r) => [r.status, r.responseCode])).toEqual([['REJECTED', '1'], ['REJECTED', '400.002.02']]);
    expect(await initiate(OK_BODY, 'key-x1')).toMatchObject({ status: 502 }); // replay: still 502, no new prompt
    expect(fetchMock.calls.stk).toBe(2);
  });

  it('Daraja timeout / 5xx → row UNKNOWN; 202 "pending confirmation"; never retried automatically', async () => {
    stkHandler = () => 'timeout';
    const t = await initiate(OK_BODY, 'key-u1');
    expect(t).toMatchObject({ status: 202, body: { status: 'UNKNOWN' } });
    expect(t.body.message).toMatch(/Pending confirmation/);
    stkHandler = () => ({ status: 503, raw: 'Service Unavailable' });
    expect(await initiate({ ...OK_BODY, amount: 77 }, 'key-u2')).toMatchObject({ status: 202 });
    expect(memStk.rows.map((r) => r.status)).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(fetchMock.calls.stk).toBe(2);
    expect(await initiate(OK_BODY, 'key-u1')).toMatchObject({ status: 202 });
    expect(fetchMock.calls.stk).toBe(2);
    expect(metrics.stk.UNKNOWN).toBeGreaterThanOrEqual(2);
  });
});

describe('abuse controls', () => {
  it('rate limit: > 5 initiations per agent per minute → 429 with Retry-After', async () => {
    for (let i = 0; i < 5; i++) expect((await initiate({ amount: 100 + i, phone: '0712345678' }, `rl-${i}`)).status).toBe(201);
    const res = await initiate({ amount: 200, phone: '0712345678' }, 'rl-5');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(fetchMock.calls.stk).toBe(5);
  });

  it('soft duplicate guard: same phone and amount within 60 s → 409 possible_duplicate unless confirm_duplicate', async () => {
    expect((await initiate(OK_BODY, 'dup-1')).status).toBe(201);
    expect(await initiate(OK_BODY, 'dup-2')).toMatchObject({ status: 409, body: { error: 'possible_duplicate' } });
    expect((await initiate({ ...OK_BODY, confirm_duplicate: true }, 'dup-3')).status).toBe(201);
    expect((await initiate({ ...OK_BODY, amount: 1501 }, 'dup-4')).status).toBe(201); // different amount
    expect(fetchMock.calls.stk).toBe(3);
  });

  it('a rejected earlier request is not a duplicate (the customer can be asked again)', async () => {
    stkHandler = () => ({ status: 200, body: { ResponseCode: '1' } });
    await initiate(OK_BODY, 'rej-1');
    stkHandler = () => accepted();
    expect((await initiate(OK_BODY, 'rej-2')).status).toBe(201);
  });

  it('Redis down → 503 (fail closed); nothing claimed, Daraja not called', async () => {
    store.down = true;
    expect(await initiate(OK_BODY, 'down-1')).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    expect(memStk.rows).toHaveLength(0);
    expect(fetchMock.calls.stk).toBe(0);
  });
});

describe('GET /api/v1/payments/stk/:id', () => {
  const get = async (id: string, auth?: string) =>
    srv.request('GET', `/api/v1/payments/stk/${id}`, { headers: { Authorization: `Bearer ${auth ?? (await token())}` } });

  it('the agent sees status, result code and customer message of their own request', async () => {
    const created = await initiate(OK_BODY, 'get-1');
    Object.assign(memStk.rows[0], { status: 'FAILED', resultCode: '1032' });
    expect(await get(created.body.stk_request_id)).toMatchObject({
      status: 200,
      body: { stk_request_id: created.body.stk_request_id, status: 'FAILED', result_code: '1032', customer_message: expect.any(String) },
    });
  });

  it("another agent's request, an unknown id or a malformed id → 404; MERCHANT_ADMIN → 403; no token → 401", async () => {
    const created = await initiate(OK_BODY, 'get-2');
    const other = crypto.randomUUID();
    mockAgents.set(other, { agentId: crypto.randomUUID(), agentCode: 'AG777', userDisabled: false });
    expect((await get(created.body.stk_request_id, await token('SALES_AGENT', other))).status).toBe(404);
    expect((await get(crypto.randomUUID())).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect((await get(created.body.stk_request_id, await token('MERCHANT_ADMIN'))).status).toBe(403);
    expect((await srv.request('GET', `/api/v1/payments/stk/${created.body.stk_request_id}`)).status).toBe(401);
  });
});
