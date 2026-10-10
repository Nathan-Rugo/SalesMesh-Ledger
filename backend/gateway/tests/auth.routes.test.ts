/**
 * @file auth.routes.test.ts
 * @description spec gh-5 I/O matrix — login, lockout, refresh rotation and reuse, logout, first
 * login / PIN change, wrong role — over HTTP, with an in-memory auth repository and mocked Redis.
 */

 

jest.mock('../src/repositories/auth.repository', () => require('./support/memory-auth-repo'));
const mockSecurityEvents: any[] = [];
jest.mock('../src/repositories/security.repository', () => ({
  insertSubjectSecurityEvent: jest.fn(async (_db: unknown, e: unknown) => {
    mockSecurityEvents.push(e);
  }),
}));

import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/credentials';
import { requireAuth } from '../src/auth/middleware';
import { LoginThrottle } from '../src/auth/throttle';
import { verifyAccessToken } from '../src/auth/tokens';
import { createAuthRouter } from '../src/routes/auth.routes';
import { GatewayMetrics } from '../src/services/metrics.service';
import { memAuth } from './support/memory-auth-repo';
import { MemoryThrottleStore } from './support/memory-store';
import { cookieValue, listen, type TestServer } from './support/http';

const RT = '__Secure-sm_rt';
const DEV = '__Secure-sm_dev';
const fakeDb: any = {
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
};

let store: MemoryThrottleStore;
let metrics: GatewayMetrics;
let srv: TestServer;

async function seedUser(o: {
  phone?: string;
  pin?: string;
  role?: 'SALES_AGENT' | 'MERCHANT_ADMIN';
  mustChange?: boolean;
  disabled?: boolean;
  oneTimeExpiresAt?: Date | null;
} = {}) {
  const userId = crypto.randomUUID();
  memAuth.users.set(userId, {
    userId,
    role: o.role ?? 'SALES_AGENT',
    phoneNumber: o.phone ?? '254712345678',
    disabled: o.disabled ?? false,
    credential: await hashPin(o.pin ?? '4826'),
    mustChange: o.mustChange ?? false,
    oneTimeExpiresAt: o.oneTimeExpiresAt ?? null,
  });
  return userId;
}

const login = (phone: string, pin: string, headers: Record<string, string> = {}) =>
  srv.request('POST', '/api/v1/auth/login', { body: { phone, pin }, headers });
const withCookie = (name: string, value: string | undefined, extra: Record<string, string> = {}) =>
  value ? { Cookie: `${name}=${encodeURIComponent(value)}`, ...extra } : extra;
const refresh = (rt: string | undefined, extra: Record<string, string> = {}) =>
  srv.request('POST', '/api/v1/auth/refresh', { headers: withCookie(RT, rt, extra) });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const app = express();
  store = new MemoryThrottleStore();
  metrics = new GatewayMetrics();
  const service = new AuthService({ db: fakeDb, throttle: new LoginThrottle(store), metrics });
  app.use('/api/v1/auth', createAuthRouter(service));
  app.get('/api/v1/agent-only', requireAuth(['SALES_AGENT']), (req, res) => {
    res.json({ user: req.auth!.userId });
  });
  app.get('/api/v1/admin-only', requireAuth(['MERCHANT_ADMIN']), (_req, res) => {
    res.json({ ok: true });
  });
  srv = await listen(app);
});
afterAll(() => srv.close());
beforeEach(() => {
  memAuth.reset();
  mockSecurityEvents.length = 0;
  store.down = false;
  store.offsetMs = 0;
  for (const k of store.keys()) void store.del(k);
  delete process.env.CORS_ORIGINS;
});

describe('login', () => {
  it('OK → 200 with the access token in JSON; refresh token in an HttpOnly/Secure/SameSite=Strict cookie on /api/v1/auth', async () => {
    const userId = await seedUser();
    const res = await login('0712 345 678', '4826', { 'User-Agent': 'jest-agent' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, pin_change_required: false, user: { user_id: userId, role: 'SALES_AGENT' } });
    expect(await verifyAccessToken(res.body.access_token)).toMatchObject({ userId, role: 'SALES_AGENT' });

    const rt = res.cookies.find((c) => c.startsWith(`${RT}=`))!;
    expect(rt).toMatch(/; Path=\/api\/v1\/auth/);
    expect(rt).toMatch(/; HttpOnly/);
    expect(rt).toMatch(/; Secure/);
    expect(rt).toMatch(/; SameSite=Strict/);
    expect(rt).toMatch(/Max-Age=604800/);
    expect(res.cookies.some((c) => c.startsWith(`${DEV}=`))).toBe(true);
    // The access token never travels in a cookie; only the refresh token's hash is stored.
    expect(res.cookies.join(';')).not.toContain(res.body.access_token);
    expect(memAuth.tokens).toHaveLength(1);
    expect(memAuth.tokens[0].tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(memAuth.tokens[0].tokenHash).not.toContain(cookieValue(res.cookies, RT)!);
    expect(memAuth.events.at(-1)).toMatchObject({ type: 'LOGIN_SUCCESS', userId });
    expect(memAuth.events.at(-1)!.userAgentHash).toMatch(/^k1:/);
  });

  it('bad PIN and unknown phone → the same 401 body, similar latency, and both are counted', async () => {
    await seedUser();
    process.env.AUTH_FAILURE_MIN_MS = '150';
    try {
      const t0 = Date.now();
      const wrong = await login('0712345678', '9999');
      const t1 = Date.now();
      const unknown = await login('0799999999', '9999');
      const t2 = Date.now();
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body).toEqual({ error: 'invalid_credentials' });
      expect(t1 - t0).toBeGreaterThanOrEqual(140);
      expect(t2 - t1).toBeGreaterThanOrEqual(140);
    } finally {
      process.env.AUTH_FAILURE_MIN_MS = '0';
    }
    expect(store.keys().filter((k) => k.startsWith('auth:pf:'))).toHaveLength(2);
    expect(memAuth.events.filter((e) => e.type === 'LOGIN_FAILURE')).toHaveLength(2);
  });

  it('missing / malformed body → 400', async () => {
    expect((await srv.request('POST', '/api/v1/auth/login', { body: { phone: '0712345678' } })).status).toBe(400);
    expect((await srv.request('POST', '/api/v1/auth/login', { raw: '{"phone":' })).status).toBe(400);
  });

  it('lockout: ≥5 failures in 15 min → 429 with Retry-After, even with the right PIN', async () => {
    await seedUser();
    for (let i = 0; i < 5; i++) expect((await login('0712345678', '0000')).status).toBe(401);
    const locked = await login('0712345678', '4826');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(59);
    expect(memAuth.events.at(-1)).toMatchObject({ type: 'LOGIN_THROTTLED', reason: 'phone' });
  });

  it('a trusted device (earlier successful login) is exempt from the anonymous lockout', async () => {
    await seedUser();
    const ok = await login('0712345678', '4826');
    const device = cookieValue(ok.cookies, DEV)!;
    for (let i = 0; i < 5; i++) await login('0712345678', '0000'); // attacker, no device cookie
    expect((await login('0712345678', '4826')).status).toBe(429);
    const legit = await login('0712345678', '4826', withCookie(DEV, device));
    expect(legit.status).toBe(200);
  });

  it('24 h cap (20 failures) → hard lock, LOGIN_LOCKOUT security event; admin unlock lifts it', async () => {
    const userId = await seedUser();
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < 20; i++) {
      store.advance(16 * 60_000); // let each 15-minute lock lapse
      await login('0712345678', '0000');
    }
    err.mockRestore();
    expect(mockSecurityEvents).toEqual([expect.objectContaining({ type: 'LOGIN_LOCKOUT', userId })]);
    store.advance(2 * 3600_000);
    const res = await login('0712345678', '4826');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeUndefined();
    const { LoginThrottle: T, loginPhoneKey } = await import('../src/auth/throttle');
    await new T(store).unlock(loginPhoneKey('254712345678'));
    expect((await login('0712345678', '4826')).status).toBe(200);
  });

  it('Redis down → 503 (fail closed), never an unthrottled guess', async () => {
    await seedUser();
    store.down = true;
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await login('0712345678', '4826');
    err.mockRestore();
    expect(res.status).toBe(503);
    expect(res.cookies).toEqual([]);
  });

  it('a disabled user, or an expired one-time PIN → 401 (generic)', async () => {
    await seedUser({ disabled: true });
    expect((await login('0712345678', '4826')).status).toBe(401);
    memAuth.reset();
    await seedUser({ mustChange: true, oneTimeExpiresAt: new Date(Date.now() - 1000) });
    const res = await login('0712345678', '4826');
    expect(res).toMatchObject({ status: 401, body: { error: 'invalid_credentials' } });
    expect(memAuth.events.at(-1)).toMatchObject({ reason: 'one_time_pin_expired' });
  });
});

describe('refresh / logout', () => {
  async function session() {
    const userId = await seedUser();
    const res = await login('0712345678', '4826');
    return { userId, rt: cookieValue(res.cookies, RT)! };
  }

  it('valid cookie → new access token + rotated cookie; the old token is spent', async () => {
    const { userId, rt } = await session();
    const res = await refresh(rt);
    expect(res.status).toBe(200);
    expect(await verifyAccessToken(res.body.access_token)).toMatchObject({ userId });
    const next = cookieValue(res.cookies, RT)!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(rt);
    expect(memAuth.tokens.find((t) => t.rotatedAt !== null)).toBeTruthy();
    expect((await refresh(next)).status).toBe(200);
  });

  it('a token rotated < 20 s ago (concurrent tabs / lost response) → fresh token in the same family, unused successor superseded, no revocation', async () => {
    const { rt } = await session();
    const first = await refresh(rt);
    const lostSuccessor = cookieValue(first.cookies, RT)!; // the client never received this
    const again = await refresh(rt);
    expect(again.status).toBe(200);
    expect(again.body.access_token).toBeTruthy();
    const fresh = cookieValue(again.cookies, RT)!;
    expect(fresh).toBeTruthy();
    expect(new Set(memAuth.tokens.map((t) => t.familyId)).size).toBe(1); // same family
    const live = memAuth.tokens.filter((t) => t.revokedAt === null && t.rotatedAt === null);
    expect(live).toHaveLength(1); // only the newest token is live
    expect((await refresh(lostSuccessor)).status).toBe(401); // superseded: refused, but no alarm
    expect(mockSecurityEvents).toEqual([]);
    expect((await refresh(fresh)).status).toBe(200);
  });

  it('lost refresh response: after a grace refresh the client is not treated as a thief once the window passes', async () => {
    const { rt } = await session();
    await refresh(rt); // response lost: the client keeps rt
    const grace = await refresh(rt); // retry within 20 s → fresh token set as the cookie
    const cookie = cookieValue(grace.cookies, RT)!;
    for (const t of memAuth.tokens) if (t.rotatedAt) t.rotatedAt -= 25_000; // well past the grace window
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = await refresh(cookie);
    err.mockRestore();
    expect(later.status).toBe(200);
    expect(mockSecurityEvents).toEqual([]); // no false REFRESH_TOKEN_REUSE
    expect(memAuth.tokens.filter((t) => t.revokedAt === null && t.rotatedAt === null)).toHaveLength(1);
  });

  it('a family past its absolute lifetime (REFRESH_FAMILY_MAX_DAYS) → 401, however recently refreshed', async () => {
    const { rt } = await session();
    const res = await refresh(rt);
    for (const t of memAuth.tokens) t.familyExpiresAt = Date.now() - 1;
    expect(await refresh(cookieValue(res.cookies, RT))).toMatchObject({ status: 401 });
    const fresh = memAuth.tokens.at(-1)!;
    expect(fresh.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 24 * 3600_000);
  });

  it('refresh reuse: an already-rotated token → 401, the whole family revoked, security event', async () => {
    const { userId, rt } = await session();
    const legit = await refresh(rt);
    const successor = cookieValue(legit.cookies, RT)!;
    for (const t of memAuth.tokens) if (t.rotatedAt) t.rotatedAt -= 21_000; // past the grace window
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const stolen = await refresh(rt);
    err.mockRestore();
    expect(stolen.status).toBe(401);
    expect(stolen.cookies.some((c) => c.startsWith(`${RT}=;`))).toBe(true);
    expect(memAuth.tokens.every((t) => t.revokedAt !== null)).toBe(true);
    expect((await refresh(successor)).status).toBe(401); // the legitimate holder loses access too
    expect(mockSecurityEvents).toEqual([expect.objectContaining({ type: 'REFRESH_TOKEN_REUSE', userId, familyId: memAuth.tokens[0].familyId })]);
  });

  it('expired, unknown or missing refresh token → 401', async () => {
    const { rt } = await session();
    memAuth.tokens[0].expiresAt = Date.now() - 1;
    expect((await refresh(rt)).status).toBe(401);
    expect((await refresh('nope')).status).toBe(401);
    expect((await refresh(undefined)).status).toBe(401);
  });

  it('every refresh re-derives role, must_change and status from the DB; disabled → 401', async () => {
    const { userId, rt } = await session();
    memAuth.users.get(userId)!.role = 'MERCHANT_ADMIN';
    const res = await refresh(rt);
    expect((await verifyAccessToken(res.body.access_token)).role).toBe('MERCHANT_ADMIN');
    memAuth.users.get(userId)!.disabled = true;
    expect((await refresh(cookieValue(res.cookies, RT))).status).toBe(401);
    expect(memAuth.tokens.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('logout → 204, family revoked, cookie cleared', async () => {
    const { rt } = await session();
    const res = await srv.request('POST', '/api/v1/auth/logout', { headers: withCookie(RT, rt) });
    expect(res.status).toBe(204);
    expect(res.cookies.find((c) => c.startsWith(`${RT}=`))).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(memAuth.tokens.every((t) => t.revokedAt !== null)).toBe(true);
    expect((await refresh(rt)).status).toBe(401);
    expect((await srv.request('POST', '/api/v1/auth/logout')).status).toBe(204); // idempotent
  });

  it('refresh and logout check Origin (CORS_ORIGINS allowlist; foreign or "null" → 403)', async () => {
    const { rt } = await session();
    process.env.CORS_ORIGINS = 'https://pwa.salesmesh.example';
    expect((await refresh(rt, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await refresh(rt, { Origin: 'null' })).status).toBe(403);
    expect((await srv.request('POST', '/api/v1/auth/logout', { headers: withCookie(RT, rt, { Origin: 'https://evil.example' }) })).status).toBe(403);
    expect(memAuth.tokens.every((t) => t.revokedAt === null && t.rotatedAt === null)).toBe(true);
    expect((await refresh(rt, { Origin: 'https://pwa.salesmesh.example' })).status).toBe(200);
  });
});

describe('first login and PIN change', () => {
  it('must_change: the token may only call POST /api/v1/auth/pin; then a fresh session without the flag', async () => {
    const userId = await seedUser({ pin: '590317', mustChange: true, oneTimeExpiresAt: new Date(Date.now() + 3600_000) });
    const first = await login('0712345678', '590317');
    expect(first.status).toBe(200);
    expect(first.body.pin_change_required).toBe(true);
    const oneTime = first.body.access_token;
    const oldRt = cookieValue(first.cookies, RT)!;
    expect(await srv.request('GET', '/api/v1/agent-only', { headers: bearer(oneTime) })).toMatchObject({
      status: 403,
      body: { error: 'pin_change_required' },
    });

    const changed = await srv.request('POST', '/api/v1/auth/pin', { headers: bearer(oneTime), body: { current_pin: '590317', new_pin: '4826' } });
    expect(changed.status).toBe(200);
    expect(changed.body.pin_change_required).toBe(false);
    expect(memAuth.users.get(userId)!.mustChange).toBe(false);
    expect(mockSecurityEvents).toEqual([expect.objectContaining({ type: 'PIN_CHANGED', userId })]);
    // Every earlier family is revoked; the current session continues in a fresh one.
    expect((await refresh(oldRt)).status).toBe(401);
    expect((await refresh(cookieValue(changed.cookies, RT))).status).toBe(200);
    expect((await srv.request('GET', '/api/v1/agent-only', { headers: bearer(changed.body.access_token) })).status).toBe(200);
    expect((await login('0712345678', '590317')).status).toBe(401);
    expect((await login('0712345678', '4826')).status).toBe(200);
  });

  it.each([
    [{ current_pin: '4826', new_pin: '1234' }, 'pin_sequence'],
    [{ current_pin: '4826', new_pin: '7777' }, 'pin_repeated'],
    [{ current_pin: '4826', new_pin: '12ab' }, 'pin_format'],
    [{ current_pin: '4826', new_pin: '123' }, 'pin_format'],
    [{ current_pin: '4826', new_pin: '1234567' }, 'pin_format'],
    [{ current_pin: '4826', new_pin: '1212' }, 'pin_common'],
    [{ current_pin: '4826', new_pin: '4826' }, 'pin_unchanged'],
    [{ new_pin: '5903' }, 'current_pin_missing'],
  ])('weak / invalid new PIN %j → 400 %s', async (body, reason) => {
    await seedUser();
    const s = await login('0712345678', '4826');
    const res = await srv.request('POST', '/api/v1/auth/pin', { headers: bearer(s.body.access_token), body });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_pin', reason });
  });

  it('a wrong current PIN → 401 and counts toward the login lockout', async () => {
    await seedUser();
    const s = await login('0712345678', '4826');
    for (let i = 0; i < 5; i++) {
      const res = await srv.request('POST', '/api/v1/auth/pin', { headers: bearer(s.body.access_token), body: { current_pin: '0000', new_pin: '5903' } });
      expect(res.status).toBe(401);
    }
    expect((await login('0712345678', '4826')).status).toBe(429);
  });
});

describe('access-token middleware', () => {
  it('JWT tampering → 401; wrong role → 403', async () => {
    await seedUser();
    const s = await login('0712345678', '4826');
    const [h, p, sig] = s.body.access_token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'MERCHANT_ADMIN' })).toString('base64url')}.${sig}`;
    expect((await srv.request('GET', '/api/v1/admin-only', { headers: bearer(forged) })).status).toBe(401);
    expect((await srv.request('GET', '/api/v1/admin-only')).status).toBe(401);
    expect((await srv.request('GET', '/api/v1/admin-only', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    expect(await srv.request('GET', '/api/v1/admin-only', { headers: bearer(s.body.access_token) })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await srv.request('GET', '/api/v1/agent-only', { headers: bearer(s.body.access_token) })).status).toBe(200);
  });

  it('no raw phone, PIN or token reaches the logs', async () => {
    const logs = (['info', 'warn', 'error', 'log'] as const).map((l) => jest.spyOn(console, l));
    try {
      await seedUser();
      const s = await login('0712345678', '4826');
      await login('0712345678', '9999');
      await refresh(cookieValue(s.cookies, RT));
      const logged = logs.flatMap((sp) => sp.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).not.toMatch(/712345678|4826|9999/);
      expect(logged).not.toContain(s.body.access_token);
    } finally {
      logs.forEach((sp) => sp.mockRestore());
    }
  });
});

describe('spec gh-5 review fixes — login throttle and device trust', () => {
  it('20 parallel wrong PINs for one phone → at most the lockout threshold (5) reach scrypt verification', async () => {
    await seedUser();
    const credentials = require('../src/auth/credentials');
    const spy = jest.spyOn(credentials, 'verifyPin');
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => login('0712345678', '0000')));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
      expect(results.filter((r) => r.status === 401)).toHaveLength(spy.mock.calls.length);
      expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
    } finally {
      spy.mockRestore();
    }
  });

  it('a second agent on a shared outlet device does not evict the first agent\'s trust', async () => {
    await seedUser({ phone: '254711111111' });
    await seedUser({ phone: '254722222222' });
    const a = await login('0711111111', '4826');
    const b = await login('0722222222', '4826', withCookie(DEV, cookieValue(a.cookies, DEV)));
    const shared = cookieValue(b.cookies, DEV)!;
    for (let i = 0; i < 5; i++) await login('0711111111', '0000', { 'X-Forwarded-For': 'x' }); // anonymous attacker locks agent A
    expect((await login('0711111111', '4826')).status).toBe(429);
    expect((await login('0711111111', '4826', withCookie(DEV, shared))).status).toBe(200);
  });

  it('a trusted device is not blocked by the outlet IP limit (agents behind one CGNAT IP)', async () => {
    await seedUser();
    const ok = await login('0712345678', '4826');
    const device = cookieValue(ok.cookies, DEV)!;
    for (let i = 0; i < 20; i++) await login(`07120000${String(i).padStart(2, '0')}`, '0000'); // same IP, other phones
    expect((await login('0799999998', '0000')).status).toBe(429); // anonymous: IP limit
    expect((await login('0712345678', '4826', withCookie(DEV, device))).status).toBe(200);
  });

  it('PUBLIC_ORIGIN: refresh from the public origin is allowed exactly (TLS-terminating proxy)', async () => {
    await seedUser();
    const res = await login('0712345678', '4826');
    process.env.PUBLIC_ORIGIN = 'https://pay.salesmesh.example/';
    try {
      expect((await refresh(cookieValue(res.cookies, RT), { Origin: 'https://pay.salesmesh.example' })).status).toBe(200);
      expect((await refresh(cookieValue(res.cookies, RT), { Origin: `http://127.0.0.1:${srv.port}` })).status).toBe(403);
    } finally {
      delete process.env.PUBLIC_ORIGIN;
    }
  });
});
