/**
 * @file payout_destinations.test.ts
 * @description Verified payout destinations (spec gh-11): one test per I/O-matrix row over HTTP,
 * the name-match table, B2C config / request / response / result mapping, the notifier (Africa's Talking
 * request shape, failure isolation), the webhook routes and the worker sweep hook. Daraja and
 * Africa's Talking are mocked via fetch, Redis via an in-memory store, the repositories in memory.
 */

jest.mock('../src/repositories/payout_destination.repository', () => require('./support/memory-payout-repo'));
jest.mock('../src/repositories/auth.repository', () => require('./support/memory-auth-repo'));
jest.mock('../src/repositories/security.repository', () => ({ insertSubjectSecurityEvent: jest.fn(async () => undefined) }));
const mockAgents = new Map<string, { agentId: string; agentCode: string | null; userDisabled: boolean }>();
jest.mock('../src/repositories/agent.repository', () => ({
  findAgentForUser: jest.fn(async (_db: unknown, userId: string) => mockAgents.get(userId) ?? null),
}));

import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/credentials';
import { LoginThrottle, PayoutVerificationLimiter } from '../src/auth/throttle';
import { signAccessToken } from '../src/auth/tokens';
import { PayoutDestinationController } from '../src/controllers/payout_destination.controller';
import { B2cClient, b2cConfig, DarajaConfigError, mapB2cResponse, parseB2cResult } from '../src/daraja/client';
import { maskMsisdn, namesMatch, nameTokens } from '../src/domain/payout_destination';
import { preflight, redactPath } from '../src/index';
import { createPayoutDestinationRouter } from '../src/routes/payout_destination.routes';
import webhookRoutes from '../src/routes/webhook.routes';
import { GatewayMetrics } from '../src/services/metrics.service';
import { LogNotifier, notifierFromEnv, notifySafely, AfricasTalkingSmsNotifier, type Notifier } from '../src/services/notifier.service';
import { PayoutDestinationService, payoutDestinationService, verificationAmount } from '../src/services/payout_destination.service';
import { SettlementWorker } from '../src/workers/settlement.worker';
import { b2cAccepted, b2cResultBody, darajaFetch, TEST_B2C_CONFIG, type StkHandler } from './support/daraja-fetch';
import { listen, type TestServer } from './support/http';
import { memAuth } from './support/memory-auth-repo';
import * as memRepo from './support/memory-payout-repo';
import { memPayout } from './support/memory-payout-repo';
import { payoutCancel } from '../src/scripts/payout-cancel';
import { MemoryThrottleStore } from './support/memory-store';

const PHONE = '254712345678';
const NEW_PHONE = '254798765432';
const PIN = '4826';
const H24 = 24 * 3600_000;

const USER = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const fakeClient = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() };
const fakeDb: any = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: jest.fn(async () => fakeClient) };

let srv: TestServer;
let authStore: MemoryThrottleStore;
let limitStore: MemoryThrottleStore;
let b2cHandler: StkHandler;
let fetchMock: ReturnType<typeof darajaFetch>;
let metrics: GatewayMetrics;
let service: PayoutDestinationService;
let sent: Array<{ to: string; message: string }>;
let notifyFails: boolean;

const notifier: Notifier = {
  send: async (to, message) => {
    if (notifyFails) throw new Error("Africa's Talking HTTP 500");
    sent.push({ to, message });
  },
};

const token = async (role: 'SALES_AGENT' | 'MERCHANT_ADMIN' = 'SALES_AGENT') =>
  (await signAccessToken({ userId: USER, role, pinChangeRequired: false })).token;
async function call(method: string, path: string, body?: unknown, role?: 'SALES_AGENT' | 'MERCHANT_ADMIN') {
  return srv.request(method, `/api/v1/payout-destinations${path}`, { headers: { Authorization: `Bearer ${await token(role)}` }, body });
}
const register = (pin = PIN) => call('POST', '/', { pin });
const resultFor = async (id: string, o: Parameters<typeof b2cResultBody>[1] = {}) => service.applyResult(parseB2cResult(b2cResultBody(id, o))!);
const row = (id: string) => memPayout.rows.find((r) => r.destinationId === id)!;

async function seedUser(phone = PHONE) {
  memAuth.users.set(USER, {
    userId: USER,
    role: 'SALES_AGENT',
    phoneNumber: phone,
    disabled: false,
    credential: await hashPin(PIN),
    mustChange: false,
    oneTimeExpiresAt: null,
  });
}

/** Registers, verifies and returns the ACTIVE destination's id. */
async function activeDestination(): Promise<string> {
  const res = await register();
  expect(res.status).toBe(202);
  await resultFor(res.body.destination.destination_id);
  expect(row(res.body.destination.destination_id).status).toBe('ACTIVE');
  return res.body.destination.destination_id;
}

beforeAll(async () => {
  authStore = new MemoryThrottleStore();
  limitStore = new MemoryThrottleStore();
  metrics = new GatewayMetrics();
  fetchMock = darajaFetch(() => ({ status: 500 }), undefined, (b, n) => b2cHandler(b, n));
  service = new PayoutDestinationService({
    db: fakeDb,
    b2c: new B2cClient({ ...TEST_B2C_CONFIG, timeoutMs: 300 }, fetchMock.fn as any, metrics),
    auth: new AuthService({ db: fakeDb, throttle: new LoginThrottle(authStore), metrics }),
    limiter: new PayoutVerificationLimiter(limitStore, 3),
    notifier,
    metrics,
  });
  const app = express();
  app.use('/api/v1/payout-destinations', createPayoutDestinationRouter(new PayoutDestinationController(service)));
  srv = await listen(app);
});
afterAll(() => srv.close());

let logs: jest.SpyInstance[];
beforeEach(async () => {
  process.env.PAYOUTS_ENABLED = 'true';
  memPayout.reset();
  memAuth.reset();
  mockAgents.clear();
  mockAgents.set(USER, { agentId: AGENT, agentCode: 'AG042', userDisabled: false });
  memPayout.agents.set(AGENT, { userId: USER, fullName: 'John Kamau Mwangi' });
  await seedUser();
  for (const s of [authStore, limitStore]) {
    s.down = false;
    for (const k of s.keys()) await s.del(k);
  }
  fetchMock.calls.b2c = 0;
  fetchMock.calls.b2cBodies.length = 0;
  b2cHandler = () => b2cAccepted({ ConversationID: 'AG_20261012_1' });
  sent = [];
  notifyFails = false;
  logs = (['info', 'warn', 'error', 'log'] as const).map((l) => jest.spyOn(console, l).mockImplementation(() => undefined));
});
afterEach(async () => {
  await service.settled();
  const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
  // No full MSISDN, registered name, initiator credential or token in any log line.
  expect(logged).not.toMatch(/712345678|798765432|kamau|mwangi|SECURITY-CREDENTIAL|cs-secret|tok-1/i);
  logs.forEach((s) => s.mockRestore());
  delete process.env.PAYOUTS_ENABLED;
});

describe('I/O matrix', () => {
  it('first registration: 202 PENDING_VERIFICATION, one KES 1 B2C to the login phone; a matching result → ACTIVE + SMS alert', async () => {
    const res = await register();
    expect(res.status).toBe(202);
    const id = res.body.destination.destination_id;
    expect(res.body.destination).toMatchObject({ status: 'PENDING_VERIFICATION', msisdn: '2547******78', type: 'PERSONAL_MPESA' });
    expect(fetchMock.calls.b2c).toBe(1);
    expect(fetchMock.calls.b2cBodies[0]).toMatchObject({
      OriginatorConversationID: id, // recorded before the call
      CommandID: 'BusinessPayment',
      Amount: 10, // PAYOUT_VERIFICATION_AMOUNT default
      PartyA: 600000,
      PartyB: Number(PHONE),
      ResultURL: TEST_B2C_CONFIG.resultUrl,
      QueueTimeOutURL: TEST_B2C_CONFIG.timeoutUrl,
    });
    expect(row(id).conversationId).toBe('AG_20261012_1');

    const out = await resultFor(id);
    expect(out.kind).toBe('applied');
    expect(row(id)).toMatchObject({ status: 'ACTIVE', resultCode: '0' });
    expect(row(id).verifiedAt).toBeInstanceOf(Date);
    await service.settled();
    expect(sent.map((s) => s.to)).toEqual([PHONE, PHONE]); // registered, then active
    expect(sent[1].message).toMatch(/2547\*{6}78 is now your active/);
    expect(memPayout.events.map((e) => e.detail)).toEqual([expect.stringMatching(/registered/), expect.stringMatching(/verified; active/)]);
    expect(JSON.stringify(memPayout.events)).not.toMatch(/712345678/);
  });

  it('the phone is the login phone, never the body', async () => {
    const res = await call('POST', '/', { pin: PIN, phone: '0700000001', msisdn: '254700000001' });
    expect(res.status).toBe(202);
    expect(fetchMock.calls.b2cBodies[0].PartyB).toBe(Number(PHONE));
  });

  it('replacement: COOLING_OFF for 24 h, cancellable with the PIN; else the sweep promotes it and supersedes the old one', async () => {
    const oldId = await activeDestination();
    await seedUser(NEW_PHONE); // an admin changed the login phone
    const res = await register();
    expect(res.status).toBe(202);
    const newId = res.body.destination.destination_id;
    await resultFor(newId, { name: '254798765432 - JOHN KAMAU' });
    expect(row(newId).status).toBe('COOLING_OFF');
    expect(row(newId).coolingOffUntil!.getTime() - Date.now()).toBeGreaterThan(H24 - 60_000);
    await service.settled();
    // The owner of the current ACTIVE phone hears about the replacement too.
    expect(sent.filter((s) => /NEW payout destination/.test(s.message)).map((s) => s.to).sort()).toEqual([PHONE, NEW_PHONE].sort());

    // Not due yet: nothing changes.
    expect(await service.sweep()).toEqual({ promoted: 0, expired: 0 });
    memPayout.advance(H24 + 1000);
    expect(await service.sweep()).toEqual({ promoted: 1, expired: 0 });
    expect(row(newId).status).toBe('ACTIVE');
    expect(row(oldId).status).toBe('SUPERSEDED');
    await service.settled();
    // The superseded (old) phone is told where payouts now go.
    expect(sent.filter((x) => /payouts now go to 2547\*{6}32/.test(x.message)).map((x) => x.to)).toEqual([PHONE]);
  });

  it('admin cancel (npm run payout:cancel <id>): only COOLING_OFF; event "cancelled by admin"; CANCELLED alerts', async () => {
    const oldId = await activeDestination();
    await seedUser(NEW_PHONE);
    const newId = (await register()).body.destination.destination_id;
    await resultFor(newId, { name: '254798765432 - JOHN KAMAU' });
    await service.settled();
    sent = [];
    expect(await payoutCancel(service, [newId])).toMatch(/Cancelled payout destination .*2547\*{6}32/);
    expect(row(newId)).toMatchObject({ status: 'CANCELLED', rejectReason: 'cancelled_by_admin' });
    expect(row(oldId).status).toBe('ACTIVE');
    expect(memPayout.events.at(-1)!.detail).toMatch(/cancelled by admin/);
    expect(sent.filter((x) => /was cancelled/.test(x.message)).map((x) => x.to).sort()).toEqual([PHONE, NEW_PHONE].sort());
    await expect(payoutCancel(service, [oldId])).rejects.toThrow(/only a COOLING_OFF/);
    await expect(payoutCancel(service, [crypto.randomUUID()])).rejects.toThrow(/no payout destination/);
    await expect(payoutCancel(service, ['nope'])).rejects.toThrow(/usage/);
  });

  it('our own not-sent failure (network): 503, the row REJECTED so the agent can retry, no "not verified" alert', async () => {
    b2cHandler = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const res = await register();
    expect(res).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    expect(memPayout.rows[0]).toMatchObject({ status: 'REJECTED', rejectReason: 'b2c_network_ECONNREFUSED' });
    await service.settled();
    expect(sent.some((x) => /not verified/.test(x.message))).toBe(false);
    b2cHandler = () => b2cAccepted();
    expect((await register()).status).toBe(202);
  });

  it('a missing PIN (bodiless DELETE / POST) is 401 but never counts toward the lockout', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await srv.request('DELETE', `/api/v1/payout-destinations/${crypto.randomUUID()}`, { headers: { Authorization: `Bearer ${await token()}` } })).status).toBe(401);
      expect((await call('POST', '/', {})).status).toBe(401);
    }
    expect((await register()).status).toBe(202);
  });

  it('a failed promotion does not stop the expiry sweep', async () => {
    b2cHandler = () => 'timeout';
    const id = (await register()).body.destination.destination_id;
    memPayout.advance(31 * 60_000);
    const spy = jest.spyOn(memRepo, 'promoteDue').mockRejectedValueOnce(new Error('deadlock detected'));
    expect(await service.sweep()).toEqual({ promoted: 0, expired: 1 });
    spy.mockRestore();
    expect(row(id).status).toBe('EXPIRED');
  });

  it('replacement cancelled during cooling-off (DELETE /:id with the PIN) → CANCELLED; the old destination stays ACTIVE', async () => {
    const oldId = await activeDestination();
    await seedUser(NEW_PHONE);
    const newId = (await register()).body.destination.destination_id;
    await resultFor(newId, { name: '254798765432 - JOHN KAMAU' });

    expect((await call('DELETE', `/${newId}`, { pin: '9999' })).status).toBe(401);
    const res = await call('DELETE', `/${newId}`, { pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.destination).toMatchObject({ status: 'CANCELLED', msisdn: '2547******32' });
    expect(row(oldId).status).toBe('ACTIVE');
    memPayout.advance(H24 + 1000);
    expect((await service.sweep()).promoted).toBe(0);
    expect((await call('DELETE', `/${newId}`, { pin: PIN })).status).toBe(409); // not cancellable any more
    expect((await call('DELETE', `/${oldId}`, { pin: PIN })).body).toEqual({ error: 'not_cancellable' });
    expect((await call('DELETE', `/${crypto.randomUUID()}`, { pin: PIN })).status).toBe(404);
  });

  it('already registered: 409 already_active, nothing sent', async () => {
    await activeDestination();
    fetchMock.calls.b2c = 0;
    const res = await register();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already_active' });
    expect(fetchMock.calls.b2c).toBe(0);
  });

  it('in flight (including concurrent requests): 409 destination_pending; exactly one B2C is ever sent', async () => {
    const results = await Promise.all([register(), register(), register()]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error === 'destination_pending')).toBe(true);
    expect(fetchMock.calls.b2c).toBe(1);
    expect((await register()).body).toEqual({ error: 'destination_pending' });
    expect(fetchMock.calls.b2c).toBe(1);
  });

  it('wrong PIN: 401, counts toward the lockout, nothing sent; throttle down → 503', async () => {
    const res = await register('1357');
    expect(res.status).toBe(401);
    expect(fetchMock.calls.b2c).toBe(0);
    expect(memPayout.rows).toHaveLength(0);
    let last = res;
    for (let i = 0; i < 6 && last.status === 401; i++) last = await register('1357');
    expect(last.status).toBe(429); // the login lockout
    expect(last.headers['retry-after']).toBeDefined();
    expect((await register(PIN)).status).toBe(429); // locked even with the right PIN
    expect(fetchMock.calls.b2c).toBe(0);

    for (const k of authStore.keys()) await authStore.del(k);
    authStore.down = true;
    expect((await register()).status).toBe(503);
    expect(fetchMock.calls.b2c).toBe(0);
  });

  it('name mismatch → REJECTED name_mismatch (final), with an alert; a new registration is allowed', async () => {
    const id = (await register()).body.destination.destination_id;
    await resultFor(id, { name: '254712345678 - PETER OTIENO' });
    expect(row(id)).toMatchObject({ status: 'REJECTED', rejectReason: 'name_mismatch' });
    await service.settled();
    expect(sent.at(-1)!.message).toMatch(/does not match/);
    expect((await register()).status).toBe(202);
  });

  it('B2C failed: ResultCode != 0 → REJECTED b2c_<code>; Daraja REJECTED synchronously → 502 REJECTED', async () => {
    const id = (await register()).body.destination.destination_id;
    await resultFor(id, { code: 2001 });
    expect(row(id)).toMatchObject({ status: 'REJECTED', rejectReason: 'b2c_2001' });

    b2cHandler = () => ({ status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PartyB' } });
    const res = await register();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'verification_failed', destination: { status: 'REJECTED', reject_reason: 'b2c_400.002.02' } });
  });

  it('B2C unknown (timeout): stays PENDING_VERIFICATION, never resent; the late result decides', async () => {
    b2cHandler = () => 'timeout';
    const res = await register();
    expect(res.status).toBe(202);
    const id = res.body.destination.destination_id;
    expect(row(id).status).toBe('PENDING_VERIFICATION');
    expect(fetchMock.calls.b2c).toBe(1);
    await resultFor(id);
    expect(row(id).status).toBe('ACTIVE');
    expect(fetchMock.calls.b2c).toBe(1);
  });

  it('no result: 30 min after sending the sweep sets EXPIRED; the agent may register again', async () => {
    b2cHandler = () => 'timeout';
    const id = (await register()).body.destination.destination_id;
    memPayout.advance(29 * 60_000);
    expect((await service.sweep()).expired).toBe(0);
    memPayout.advance(2 * 60_000);
    expect((await service.sweep()).expired).toBe(1);
    expect(row(id)).toMatchObject({ status: 'EXPIRED', rejectReason: 'no_result' });
    // A result after expiry is recorded once (event), the row stays EXPIRED.
    expect((await resultFor(id)).kind).toBe('late');
    expect((await resultFor(id)).kind).toBe('duplicate');
    expect(row(id)).toMatchObject({ status: 'EXPIRED', resultCode: '0' });
    expect(memPayout.events.at(-1)!.detail).toMatch(/late B2C result after expiry, ResultCode 0/);
    b2cHandler = () => b2cAccepted();
    expect((await register()).status).toBe(202);
  });

  it('rate limit: a 4th verification within 24 h → 429 with Retry-After; limiter down → 503', async () => {
    b2cHandler = () => ({ status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request' } });
    for (let i = 0; i < 3; i++) expect((await register()).status).toBe(502);
    const res = await register();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(23 * 3600);
    expect(fetchMock.calls.b2c).toBe(3);

    for (const k of limitStore.keys()) await limitStore.del(k);
    limitStore.down = true;
    expect((await register()).status).toBe(503);
    expect(fetchMock.calls.b2c).toBe(3);
  });

  it('duplicate or unknown result: applied at most once', async () => {
    const id = (await register()).body.destination.destination_id;
    expect((await resultFor(id)).kind).toBe('applied');
    const events = memPayout.events.length;
    expect((await resultFor(id, { code: 2001 })).kind).toBe('duplicate');
    expect(row(id).status).toBe('ACTIVE');
    expect((await resultFor(crypto.randomUUID())).kind).toBe('unknown');
    expect((await resultFor('not-a-uuid')).kind).toBe('unknown');
    expect(memPayout.events).toHaveLength(events);
  });

  it('a result whose ConversationID contradicts the recorded one is ignored', async () => {
    const id = (await register()).body.destination.destination_id;
    expect((await resultFor(id, { conversationId: 'AG_FORGED' })).kind).toBe('unknown');
    expect(row(id).status).toBe('PENDING_VERIFICATION');
  });

  it('payouts off: every route → 503 payouts_disabled', async () => {
    process.env.PAYOUTS_ENABLED = 'false';
    expect((await register()).body).toEqual({ error: 'payouts_disabled' });
    expect((await call('GET', '/')).status).toBe(503);
    expect((await call('DELETE', `/${crypto.randomUUID()}`, { pin: PIN })).status).toBe(503);
    expect(fetchMock.calls.b2c).toBe(0);
  });

  it('payouts off: startup does not require the B2C or SMS settings; on: B2C is required', async () => {
    const db: any = { query: jest.fn(async () => ({ rows: [{}], rowCount: 1 })) };
    const base = { NODE_ENV: 'development', PII_HMAC_KEY: process.env.PII_HMAC_KEY, JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY, JWT_KEY_ID: 'test-k1', MPESA_CALLBACK_TOKEN: 'cbtok123' };
    expect(await preflight(base, db)).toEqual({ fatal: [], warnings: [] });
    expect((await preflight({ ...base, PAYOUTS_ENABLED: 'true' }, db)).fatal).toEqual([expect.stringMatching(/missing DARAJA_CONSUMER_KEY.*DARAJA_B2C_SHORTCODE/)]);
    expect((await preflight({ ...base, AFRICASTALKING_USERNAME: 'sandbox' }, db)).warnings).toEqual([expect.stringMatching(/AFRICASTALKING_\* is only partly set/)]);
  });
});

describe('access and listing', () => {
  it('SALES_AGENT only; an agent with no sales_agents row → 409; disabled → 403', async () => {
    expect((await call('GET', '/', undefined, 'MERCHANT_ADMIN')).status).toBe(403);
    mockAgents.set(USER, { agentId: AGENT, agentCode: 'AG042', userDisabled: true });
    expect((await register()).status).toBe(403);
    mockAgents.clear();
    expect((await register()).body).toEqual({ error: 'agent_not_provisioned' });
    expect(fetchMock.calls.b2c).toBe(0);
  });

  it('GET lists masked destinations and recent events; no full phone or name anywhere in the response', async () => {
    await activeDestination();
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.destinations).toEqual([expect.objectContaining({ status: 'ACTIVE', msisdn: '2547******78' })]);
    expect(res.body.events.map((e: any) => e.detail)).toEqual([expect.stringMatching(/verified; active/), expect.stringMatching(/registered/)]);
    expect(JSON.stringify(res.body)).not.toMatch(/712345678|kamau|john/i);
  });

  it('malformed JSON → 400', async () => {
    const res = await srv.request('POST', '/api/v1/payout-destinations/', { headers: { Authorization: `Bearer ${await token()}` }, raw: '{"pin":' });
    expect(res.status).toBe(400);
  });
});

describe('notifier failure isolation', () => {
  it('SMS failing: the activation still commits and the failure is counted', async () => {
    notifyFails = true;
    const before = metrics.payouts.alertsFailed;
    const id = (await register()).body.destination.destination_id;
    await resultFor(id);
    await service.settled();
    expect(row(id).status).toBe('ACTIVE');
    expect(metrics.payouts.alertsFailed - before).toBe(2);
  });

  it("AfricasTalkingSmsNotifier: apiKey header, form body to +2547…; HTTP error, rejected recipient or 5 s timeout throws", async () => {
    const calls: any[] = [];
    let mode: 'ok' | 'http' | 'rejected' | 'hang' = 'ok';
    const fetchImpl = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (mode === 'hang') return new Promise<never>((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      const statusCode = mode === 'rejected' ? 403 : 101;
      return { ok: mode !== 'http', status: mode === 'http' ? 401 : 201, json: async () => ({ SMSMessageData: { Recipients: [{ statusCode, status: mode === 'rejected' ? 'InvalidPhoneNumber' : 'Success' }] } }) };
    });
    const live = new AfricasTalkingSmsNotifier({ username: 'salesmesh', apiKey: 'at-secret', senderId: 'SALESMESH', timeoutMs: 50 }, fetchImpl as any);
    await live.send(PHONE, 'hello');
    expect(calls[0].url).toBe('https://api.africastalking.com/version1/messaging');
    expect(calls[0].init.headers.apiKey).toBe('at-secret');
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({ username: 'salesmesh', to: `+${PHONE}`, message: 'hello', from: 'SALESMESH' });
    await new AfricasTalkingSmsNotifier({ username: 'sandbox', apiKey: 'k', timeoutMs: 50 }, fetchImpl as any).send(PHONE, 'hi');
    expect(calls[1].url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(new URLSearchParams(calls[1].init.body).has('from')).toBe(false);
    mode = 'http';
    await expect(live.send(PHONE, 'x')).rejects.toThrow("Africa's Talking HTTP 401");
    mode = 'rejected';
    await expect(live.send(PHONE, 'x')).rejects.toThrow("Africa's Talking rejected: 403 InvalidPhoneNumber");
    mode = 'hang';
    await expect(live.send(PHONE, 'x')).rejects.toThrow("Africa's Talking timeout");
    const m = new GatewayMetrics();
    expect(await notifySafely(live, PHONE, 'x', m)).toBe(false);
    expect(m.payouts.alertsFailed).toBe(1);
  });

  it("notifierFromEnv: Africa's Talking only when the username and API key are set", () => {
    expect(notifierFromEnv({})).toBeInstanceOf(LogNotifier);
    expect(notifierFromEnv({ AFRICASTALKING_USERNAME: 'sandbox' })).toBeInstanceOf(LogNotifier);
    expect(notifierFromEnv({ AFRICASTALKING_USERNAME: 'sandbox', AFRICASTALKING_API_KEY: 'k' })).toBeInstanceOf(AfricasTalkingSmsNotifier);
  });
});

describe('name match (normalise: upper-case, letters only, split on whitespace)', () => {
  it.each([
    ['JOHN KAMAU', 'John Kamau Mwangi', true],
    ['JOHN MWANGI', 'John Kamau Mwangi', true],
    ['john   kamau', 'JOHN KAMAU', true],
    ['JOHN DOE', 'John Kamau Mwangi', false], // only one of two tokens
    ['PETER OTIENO', 'John Kamau Mwangi', false],
    ['KAMAU', 'John Kamau', true], // single token: must appear
    ['OTIENO', 'John Kamau', false],
    ['JOHN KAMAU OTIENO', 'John Kamau', true], // 2 of 3
    ["MARY O'NEIL", "Mary O'Neil", true],
    ['MARY-JANE WANJIKU', 'Mary-Jane Wanjiku', true],
    ['MARY JANE WANJIKU', 'Mary-Jane Wanjiku', true], // hyphen splits words
    ['JANE WANJIKU', 'Mary-Jane Wanjiku', true],
    ['JOSE KAMAU', 'José Kamau', true], // accents folded
    ['JOHN KAMAU', 'J.Kamau John', true], // "." splits words
    ['ANNE_MARIE OTIENO', 'Anne Marie Otieno', true],
    ['JOHN JOHN', 'John Kamau', true], // distinct tokens: one token, present
    ['', 'John Kamau', false],
    [null, 'John Kamau', false],
    ['254712345678', 'John Kamau', false], // digits only → no tokens
  ])('%j vs %j → %s', (mpesa, full, expected) => {
    expect(namesMatch(mpesa, full)).toBe(expected);
  });

  it('tokens and masking', () => {
    expect(nameTokens("  o'brien-KAMAU  wa  ")).toEqual(['OBRIEN', 'KAMAU', 'WA']);
    expect(nameTokens('Zoë Ñjeri')).toEqual(['ZOE', 'NJERI']);
    expect([undefined, '', '0', '-5', '1.5', 'ten', '25'].map((v) => verificationAmount(v === undefined ? {} : { PAYOUT_VERIFICATION_AMOUNT: v }))).toEqual([10, 10, 10, 10, 10, 10, 25]);
    expect(maskMsisdn('254712345678')).toBe('2547******78');
  });
});

describe('B2C mapping', () => {
  it.each([
    [200, { ConversationID: 'AG_1', ResponseCode: '0' }, { kind: 'ACCEPTED', conversationId: 'AG_1' }],
    [200, { ResponseCode: '0' }, { kind: 'UNKNOWN', code: 'missing_conversation_id' }],
    [200, { ResponseCode: '1', ResponseDescription: 'nope' }, { kind: 'REJECTED', code: '1' }],
    [400, { errorCode: '400.002.02', errorMessage: 'Invalid' }, { kind: 'REJECTED', code: '400.002.02' }],
    [404, { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' }, { kind: 'TOKEN_INVALID' }],
    [500, { errorCode: '500.003.1001', errorMessage: 'Internal' }, { kind: 'UNKNOWN', code: '500.003.1001' }],
    [500, { errorCode: '500.003.02', errorMessage: 'Spike arrest' }, { kind: 'REJECTED' }],
    [401, null, { kind: 'TOKEN_INVALID' }],
    [403, null, { kind: 'REJECTED', code: 'http_403' }],
    [502, null, { kind: 'UNKNOWN', code: 'http_502' }],
  ])('%s %j → %j', (status, body, expected) => {
    expect(mapB2cResponse(status, body)).toMatchObject(expected);
  });

  it('retries once after an invalid-token answer, never otherwise; the credential is sent, never logged', async () => {
    let n = 0;
    const f = darajaFetch(() => ({ status: 500 }), undefined, () => (++n === 1 ? { status: 404, body: { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' } } : b2cAccepted({ ConversationID: 'AG_2' })));
    const c = new B2cClient(TEST_B2C_CONFIG, f.fn as any, new GatewayMetrics());
    const out = await c.b2cPayment({ originatorConversationId: crypto.randomUUID(), phone: PHONE, amount: 1, remarks: 'r' });
    expect(out).toEqual({ kind: 'ACCEPTED', conversationId: 'AG_2' });
    expect(f.calls.b2c).toBe(2);
    expect(f.calls.oauth).toBe(2);
    expect(f.calls.b2cBodies[0]).toMatchObject({ InitiatorName: 'testapi', SecurityCredential: 'SECURITY-CREDENTIAL-SECRET' });

    const g = darajaFetch(() => ({ status: 500 }), undefined, () => ({ status: 503 }));
    const out2 = await new B2cClient(TEST_B2C_CONFIG, g.fn as any, new GatewayMetrics()).b2cPayment({ originatorConversationId: crypto.randomUUID(), phone: PHONE, amount: 1, remarks: 'r' });
    expect(out2).toMatchObject({ kind: 'UNKNOWN', code: 'http_503' });
    expect(g.calls.b2c).toBe(1);
  });

  it('parseB2cResult reads ResultCode, ids and the name after " - "; non-results → null', () => {
    expect(parseB2cResult(b2cResultBody('id-1'))).toEqual({ originatorConversationId: 'id-1', conversationId: 'AG_20261012_1', resultCode: '0', receiverName: 'JOHN KAMAU', receipt: 'NLJ41HAY6Q' });
    expect(parseB2cResult(b2cResultBody('id-1', { code: 2001, name: null }))).toMatchObject({ resultCode: '2001', receiverName: null });
    expect(parseB2cResult({ Result: { ResultCode: 0, OriginatorConversationID: 'x', ResultParameters: { ResultParameter: { Key: 'ReceiverPartyPublicName', Value: 'JANE' } } } })!.receiverName).toBe('JANE');
    const named = (v: string) => parseB2cResult({ Result: { ResultCode: 0, OriginatorConversationID: 'x', ResultParameters: { ResultParameter: [{ Key: 'ReceiverPartyPublicName', Value: v }] } } })!.receiverName;
    expect(named('254712345678 JOHN KAMAU')).toBe('JOHN KAMAU'); // leading phone, no " - "
    expect(named('254712345678-JANE')).toBe('JANE');
    expect(parseB2cResult({})).toBeNull();
    expect(parseB2cResult({ Result: { ResultCode: 0 } })).toBeNull();
  });

  it('b2cConfig validates the B2C settings and both callback URLs', () => {
    const env = {
      DARAJA_CONSUMER_KEY: 'k',
      DARAJA_CONSUMER_SECRET: 's',
      DARAJA_B2C_SHORTCODE: '600000',
      DARAJA_B2C_INITIATOR_NAME: 'testapi',
      DARAJA_B2C_SECURITY_CREDENTIAL: 'cred',
      DARAJA_B2C_RESULT_URL: 'https://gw.example/api/v1/mpesa/b2c/result/cbtok',
      DARAJA_B2C_TIMEOUT_URL: 'https://gw.example/api/v1/mpesa/b2c/timeout/cbtok',
      MPESA_CALLBACK_TOKEN: 'cbtok',
    };
    expect(b2cConfig(env)).toMatchObject({ shortCode: '600000', baseUrl: 'https://sandbox.safaricom.co.ke' });
    expect(() => b2cConfig({ ...env, DARAJA_B2C_RESULT_URL: 'https://gw.example/api/v1/mpesa/b2c/timeout/cbtok' })).toThrow(/DARAJA_B2C_RESULT_URL must end with/);
    expect(() => b2cConfig({ ...env, DARAJA_B2C_TIMEOUT_URL: 'http://gw.example/api/v1/mpesa/b2c/timeout/cbtok' })).toThrow(/https/);
    expect(() => b2cConfig({ ...env, DARAJA_B2C_RESULT_URL: 'https://gw.example/api/v1/mpesa/b2c/result/${MPESA_CALLBACK_TOKEN}' })).toThrow(/unexpanded/);
    expect(() => b2cConfig({ ...env, DARAJA_B2C_SHORTCODE: '12' })).toThrow(DarajaConfigError);
    expect(() => b2cConfig({ ...env, DARAJA_B2C_SECURITY_CREDENTIAL: '' })).toThrow(/missing DARAJA_B2C_SECURITY_CREDENTIAL/);
  });
});

describe('B2C callback routes', () => {
  let hook: TestServer;
  beforeAll(async () => {
    const app = express();
    app.use('/', webhookRoutes);
    hook = await listen(app);
  });
  afterAll(() => hook.close());
  beforeEach(() => {
    process.env.MPESA_CALLBACK_TOKEN = 'cbtok';
  });

  it('result: wrong token → 404 before parsing; a result → applied and ACKed; a DB failure → 503', async () => {
    const apply = jest.spyOn(payoutDestinationService, 'applyResult').mockResolvedValue({ kind: 'duplicate' });
    try {
      expect((await hook.request('POST', '/api/v1/mpesa/b2c/result/wrong', { body: b2cResultBody('x') })).status).toBe(404);
      expect(apply).not.toHaveBeenCalled();
      const res = await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { body: b2cResultBody('id-9') });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      expect(apply).toHaveBeenCalledWith(expect.objectContaining({ originatorConversationId: 'id-9', receiverName: 'JOHN KAMAU' }));
      expect((await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { body: { hello: 1 } })).body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      expect((await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { raw: '{bad' })).status).toBe(200);
      apply.mockRejectedValueOnce(new Error('connection terminated'));
      expect((await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { body: b2cResultBody('id-9') })).status).toBe(503);
    } finally {
      apply.mockRestore();
    }
  });

  it('timeout: logged and ACKed only', async () => {
    const apply = jest.spyOn(payoutDestinationService, 'applyResult');
    const res = await hook.request('POST', '/api/v1/mpesa/b2c/timeout/cbtok', { body: b2cResultBody('id-9') });
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(apply).not.toHaveBeenCalled();
    apply.mockRestore();
  });

  it('the callback token never reaches the access log', () => {
    expect(redactPath('/api/v1/mpesa/b2c/result/cbtok')).toBe('/api/v1/mpesa/b2c/result/:token');
    expect(redactPath('/api/v1/mpesa/b2c/timeout/cbtok')).toBe('/api/v1/mpesa/b2c/timeout/:token');
  });
});

describe('worker sweep hook', () => {
  it('the settlement worker housekeeping runs the payout sweep only while PAYOUTS_ENABLED=true', async () => {
    const sweep = jest.fn(async () => ({ promoted: 0, expired: 0 }));
    const w = new SettlementWorker({ pool: fakeDb, spool: null, payouts: { sweep }, payoutClaims: { sweep: jest.fn(async () => ({ queried: 0, unresolved: 0 })), remindUnclaimed: jest.fn(async () => 0) } });
    process.env.PAYOUTS_ENABLED = 'false';
    await w.housekeeping(true);
    expect(sweep).not.toHaveBeenCalled();
    process.env.PAYOUTS_ENABLED = 'true';
    await w.housekeeping(true);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
