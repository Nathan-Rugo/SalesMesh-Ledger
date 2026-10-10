/**
 * Auth against real Postgres (and real Redis when TEST_REDIS_URL is set), spec gh-5:
 *  - user:create provisioning is atomic (no partial rows) with clear errors;
 *  - one-time PIN → forced PIN change → normal login;
 *  - refresh-family reuse revocation: a stolen token used after its legitimate rotation revokes
 *    the whole family (both holders lose access) and records a security event;
 *  - concurrent refreshes of one token: no false revocation, only the newest token stays live;
 *  - the Redis login throttle (reserve Lua script) locks out after 5 failures, atomically;
 *  - admin CLI disable / PIN reset revoke every family and leave security_events rows;
 *  - family absolute expiry carried forward; retention purge.
 */

import crypto from 'crypto';
import Redis from 'ioredis';
import { AuthService, type ClientInfo } from '../../src/auth/auth.service';
import { LoginThrottle, RedisThrottleStore, type ThrottleStore } from '../../src/auth/throttle';
import { verifyAccessToken } from '../../src/auth/tokens';
import { CliError, createUser, parseArgs } from '../../src/scripts/user-create';
import { disableUser, parseAdminArgs, resetPin } from '../../src/scripts/user-admin';
import { purgeAuthData } from '../../src/repositories/auth.repository';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { MemoryThrottleStore } from '../support/memory-store';
import { count, createTestDb, describeDb, INIT_SQL, type TestDb } from './helpers';

jest.setTimeout(60_000);

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const CLIENT: ClientInfo = { ip: '10.9.8.7', userAgent: 'jest', deviceCookie: undefined };
const phone = () => `07${crypto.randomInt(10_000_000, 99_999_999)}`;

describeDb('auth (real Postgres)', () => {
  let db: TestDb;
  let redis: Redis | null = null;
  let store: ThrottleStore;
  let service: AuthService;

  beforeAll(async () => {
    db = await createTestDb('sm_auth');
    await db.pool.query(INIT_SQL);
    await db.pool.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('OUT-1', 'Nairobi', 100000)`);
    if (TEST_REDIS_URL) {
      redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
      store = new RedisThrottleStore(redis);
    } else store = new MemoryThrottleStore();
    service = new AuthService({ db: db.pool, throttle: new LoginThrottle(store), metrics: new GatewayMetrics() });
  });
  afterAll(async () => {
    await redis?.quit();
    await db?.drop();
  });

  const agentArgs = (p: string, code: string) =>
    parseArgs(['--role', 'SALES_AGENT', '--name', 'Jane Wanjiku', '--phone', p, '--agent-code', code, '--outlet', 'OUT-1']);

  async function activeUser(code = `A${crypto.randomBytes(3).toString('hex').toUpperCase()}`) {
    const p = phone();
    const created = await createUser(db.pool, agentArgs(p, code));
    const first = await service.login(p, created.oneTimePin, CLIENT);
    if (first.kind !== 'ok') throw new Error(`login failed: ${first.kind}`);
    const changed = await service.changePin(created.userId, created.oneTimePin, '4826', CLIENT);
    if (changed.kind !== 'ok') throw new Error(`pin change failed: ${changed.kind}`);
    return { phone: p, ...created };
  }

  it('user:create provisions user + credential + agent atomically; one-time PIN forces a change', async () => {
    const p = phone();
    const r = await createUser(db.pool, agentArgs(p, ' ag042 '));
    expect(r.oneTimePin).toMatch(/^\d{6}$/);
    const { rows: [u] } = await db.pool.query(
      `SELECT u.phone_number, u.role, c.must_change, c.one_time_expires_at, a.agent_code
         FROM users u JOIN user_credentials c USING (user_id) JOIN sales_agents a USING (user_id) WHERE u.user_id = $1`,
      [r.userId]
    );
    expect(u).toMatchObject({ phone_number: `254${p.slice(1)}`, role: 'SALES_AGENT', must_change: true, agent_code: 'AG042' });
    const hours = (new Date(u.one_time_expires_at).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    expect(JSON.stringify((await db.pool.query(`SELECT * FROM user_credentials`)).rows)).not.toContain(r.oneTimePin);

    const first = await service.login(p, r.oneTimePin, CLIENT);
    expect(first).toMatchObject({ kind: 'ok', session: { pinChangeRequired: true } });
    const ok = await service.changePin(r.userId, r.oneTimePin, '4826', CLIENT);
    expect(ok).toMatchObject({ kind: 'ok', session: { pinChangeRequired: false } });
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'PIN_CHANGED' AND subject_user_id = $1`, [r.userId])).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [r.userId])).toBe(1);
    expect((await service.login(p, '4826', CLIENT)).kind).toBe('ok');
  });

  it('user:create errors are clear and leave no partial rows', async () => {
    const p = phone();
    await createUser(db.pool, agentArgs(p, 'DUP001'));
    const users = await count(db.pool, `SELECT count(*) AS n FROM users`);
    await expect(createUser(db.pool, agentArgs(p, 'DUP002'))).rejects.toThrow(new CliError('a user with this phone number already exists'));
    await expect(createUser(db.pool, agentArgs(phone(), 'DUP001'))).rejects.toThrow(/agent code is already in use/);
    await expect(
      createUser(db.pool, parseArgs(['--role', 'SALES_AGENT', '--name', 'X', '--phone', phone(), '--agent-code', 'NEW1', '--outlet', 'NOPE']))
    ).rejects.toThrow(/outlet NOPE does not exist/);
    expect(await count(db.pool, `SELECT count(*) AS n FROM users`)).toBe(users);
    expect(await count(db.pool, `SELECT count(*) AS n FROM user_credentials`)).toBe(users);

    expect(() => parseArgs(['--role', 'SALES_AGENT', '--name', 'X', '--phone', '12345', '--agent-code', 'A1', '--outlet', 'O'])).toThrow(/--phone/);
    expect(() => parseArgs(['--role', 'SALES_AGENT', '--name', 'X', '--phone', phone(), '--agent-code', 'ABCDEFGHIJKLM', '--outlet', 'O'])).toThrow(/1-12/);
    expect(() => parseArgs(['--role', 'SALES_AGENT', '--name', 'X', '--phone', phone(), '--agent-code', '0712345678', '--outlet', 'O'])).toThrow(/phone number/);
    expect(() => parseArgs(['--role', 'ROOT', '--name', 'X', '--phone', phone()])).toThrow(/--role/);
    const admin = await createUser(db.pool, parseArgs(['--role', 'MERCHANT_ADMIN', '--name', 'Ops', '--phone', phone()]));
    expect(admin.agentId).toBeNull();
  });

  it('a stolen refresh token used after its legitimate rotation revokes the family: both holders lose access; security event', async () => {
    const u = await activeUser();
    const login = await service.login(u.phone, '4826', CLIENT);
    if (login.kind !== 'ok') throw new Error('login');
    const stolen = login.session.refreshToken!;

    const legit = await service.refresh(stolen, CLIENT);
    if (legit.kind !== 'ok') throw new Error('refresh');
    const successor = legit.session.refreshToken!;
    expect(successor).not.toBe(stolen);

    // Past the 20 s concurrency grace window.
    await db.pool.query(`UPDATE refresh_tokens SET rotated_at = rotated_at - interval '21 seconds' WHERE rotated_at IS NOT NULL`);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await service.refresh(stolen, CLIENT)).toEqual({ kind: 'invalid', reason: 'reuse' });
    err.mockRestore();
    expect(await service.refresh(successor, CLIENT)).toMatchObject({ kind: 'invalid' }); // the legitimate holder too

    const { rows: [fam] } = await db.pool.query(`SELECT family_id FROM refresh_tokens WHERE token_hash = $1`, [
      `sha256:${crypto.createHash('sha256').update(stolen).digest('hex')}`,
    ]);
    expect(await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL`, [fam.family_id])).toBe(0);
    const { rows: events } = await db.pool.query(`SELECT * FROM security_events WHERE event_type = 'REFRESH_TOKEN_REUSE'`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subject_user_id: u.userId, family_id: fam.family_id, mpesa_receipt_id: null });
    // A second reuse attempt does not duplicate the event (partial unique index).
    expect((await service.refresh(stolen, CLIENT)).kind).toBe('invalid');
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'REFRESH_TOKEN_REUSE'`)).toBe(1);
    // Other sessions (families) of the same user are untouched.
    expect(await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.userId])).toBeGreaterThan(0);
  });

  it('concurrent refreshes of one token: all succeed, one rotation, exactly one live token left, no reuse alarm', async () => {
    const u = await activeUser();
    const login = await service.login(u.phone, '4826', CLIENT);
    if (login.kind !== 'ok') throw new Error('login');
    const { rows: [fam] } = await db.pool.query(`SELECT family_id FROM refresh_tokens WHERE token_hash = $1`, [
      `sha256:${crypto.createHash('sha256').update(login.session.refreshToken).digest('hex')}`,
    ]);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.refresh(login.session.refreshToken!, CLIENT)));
    expect(results.map((r) => (r.kind === 'ok' ? 'ok' : r.reason))).toEqual(Array(8).fill('ok'));
    for (const r of results) if (r.kind === 'ok') expect((await verifyAccessToken(r.session.accessToken)).userId).toBe(u.userId);
    // Grace refreshes issue fresh same-family tokens and supersede the unused ones (advisory-locked).
    const live = await count(
      db.pool,
      `SELECT count(*) AS n FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL`,
      [fam.family_id]
    );
    expect(live).toBe(1);
    // Every token of the family carries the same absolute expiry (carried forward exactly).
    expect(await count(db.pool, `SELECT count(DISTINCT family_expires_at) AS n FROM refresh_tokens WHERE family_id = $1`, [fam.family_id])).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM security_events WHERE event_type = 'REFRESH_TOKEN_REUSE' AND subject_user_id = $1`, [u.userId])).toBe(0);
    // The token whose response "arrived last" in DB order is the live one and keeps working past the grace window.
    const { rows: [liveRow] } = await db.pool.query(
      `SELECT token_hash FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL`,
      [fam.family_id]
    );
    const winner = results.find(
      (r) => r.kind === 'ok' && `sha256:${crypto.createHash('sha256').update(r.session.refreshToken).digest('hex')}` === liveRow.token_hash
    );
    expect(winner).toBeDefined();
    await db.pool.query(`UPDATE refresh_tokens SET rotated_at = rotated_at - interval '25 seconds' WHERE family_id = $1 AND rotated_at IS NOT NULL`, [fam.family_id]);
    if (winner?.kind === 'ok') expect((await service.refresh(winner.session.refreshToken, CLIENT)).kind).toBe('ok');
  });

  it('a family past REFRESH_FAMILY_MAX_DAYS cannot be refreshed, however recently it was rotated', async () => {
    const u = await activeUser();
    const login = await service.login(u.phone, '4826', CLIENT);
    if (login.kind !== 'ok') throw new Error('login');
    const { rows: [t] } = await db.pool.query(
      `SELECT expires_at, family_expires_at FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
      [u.userId]
    );
    const days = (new Date(t.family_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(new Date(t.expires_at).getTime()).toBeLessThanOrEqual(new Date(t.family_expires_at).getTime());
    await db.pool.query(`UPDATE refresh_tokens SET family_expires_at = NOW() - interval '1 second' WHERE user_id = $1`, [u.userId]);
    expect(await service.refresh(login.session.refreshToken!, CLIENT)).toEqual({ kind: 'invalid', reason: 'expired' });
  });

  it('login reserve is atomic in real Redis: 20 parallel wrong PINs → at most 5 reach verification', async () => {
    const u = await activeUser();
    const client = { ...CLIENT, ip: `10.66.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}` };
    const credentials = require('../../src/auth/credentials');
    const spy = jest.spyOn(credentials, 'verifyPin');
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => service.login(u.phone, '0000', client)));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
      expect(results.filter((r) => r.kind === 'invalid')).toHaveLength(spy.mock.calls.length);
      expect(results.filter((r) => r.kind === 'throttled').length).toBeGreaterThanOrEqual(15);
    } finally {
      spy.mockRestore();
      await new LoginThrottle(store).unlock((await import('../../src/auth/throttle')).loginPhoneKey(`254${u.phone.slice(1)}`));
    }
  });

  it('admin CLI: disable and PIN reset revoke every family and are audited in security_events', async () => {
    const u = await activeUser();
    const login = await service.login(u.phone, '4826', CLIENT);
    if (login.kind !== 'ok') throw new Error('login');
    expect(() => parseAdminArgs(['disable', '--phone', '12'])).toThrow(/--phone/);
    expect(parseAdminArgs(['reset-pin', '--phone', u.phone])).toEqual({ command: 'reset-pin', phone: `254${u.phone.slice(1)}` });

    const reset = await resetPin(db.pool, `254${u.phone.slice(1)}`);
    expect(reset.oneTimePin).toMatch(/^\d{6}$/);
    expect(await service.refresh(login.session.refreshToken!, CLIENT)).toMatchObject({ kind: 'invalid' });
    expect(await service.login(u.phone, '4826', CLIENT)).toEqual({ kind: 'invalid' });
    const relog = await service.login(u.phone, reset.oneTimePin, CLIENT);
    expect(relog).toMatchObject({ kind: 'ok', session: { pinChangeRequired: true } }); // an expired one-time PIN is no dead end

    await disableUser(db.pool, `254${u.phone.slice(1)}`);
    expect(await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.userId])).toBe(0);
    expect((await service.login(u.phone, reset.oneTimePin, CLIENT)).kind).toBe('invalid');
    const { rows } = await db.pool.query(
      `SELECT event_type, detail FROM security_events WHERE subject_user_id = $1 AND event_type LIKE 'ADMIN_%' ORDER BY detected_at`,
      [u.userId]
    );
    expect(rows.map((r) => r.event_type)).toEqual(['ADMIN_PIN_RESET', 'ADMIN_DISABLE']);
    expect(rows[0].detail).toMatch(/via CLI by/);
    await expect(disableUser(db.pool, '254799999990')).rejects.toThrow(/no user/);
  });

  it('retention purge: refresh tokens expired/revoked > 30 days and auth_events past retention are deleted', async () => {
    const u = await activeUser();
    await db.pool.query(`UPDATE refresh_tokens SET revoked_at = NOW() - interval '31 days' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [u.userId]);
    await db.pool.query(`INSERT INTO auth_events (event_type, ip, occurred_at) VALUES ('LOGIN_FAILURE', '10.0.0.1', NOW() - interval '91 days')`);
    const before = await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1`, [u.userId]);
    const r = await purgeAuthData(db.pool, 30, 90);
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.events).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1`, [u.userId])).toBe(before - r.tokens);
    expect(await count(db.pool, `SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.userId])).toBe(1);
  });

  it('disabled users get 401 at login and at refresh', async () => {
    const u = await activeUser();
    const login = await service.login(u.phone, '4826', CLIENT);
    if (login.kind !== 'ok') throw new Error('login');
    await db.pool.query(`UPDATE users SET disabled_at = NOW() WHERE user_id = $1`, [u.userId]);
    expect((await service.login(u.phone, '4826', CLIENT)).kind).toBe('invalid');
    expect(await service.refresh(login.session.refreshToken!, CLIENT)).toEqual({ kind: 'invalid', reason: 'disabled' });
  });

  it('login throttle in Redis: 5 failures → throttled with Retry-After; audit rows carry hashes only', async () => {
    const u = await activeUser();
    const client = { ...CLIENT, ip: `10.77.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}` };
    for (let i = 0; i < 5; i++) expect((await service.login(u.phone, '0000', client)).kind).toBe('invalid');
    const locked = await service.login(u.phone, '4826', client);
    expect(locked.kind).toBe('throttled');
    if (locked.kind === 'throttled') expect(locked.retryAfterS).toBeGreaterThanOrEqual(59);
    await new Promise((r) => setTimeout(r, 50)); // audit inserts are fire-and-forget
    const { rows } = await db.pool.query(`SELECT * FROM auth_events WHERE ip = $1 ORDER BY occurred_at`, [client.ip]);
    expect(rows.map((r) => r.event_type)).toEqual([...Array(5).fill('LOGIN_FAILURE'), 'LOGIN_THROTTLED']);
    expect(JSON.stringify(rows)).not.toContain(u.phone.slice(1));
    expect(rows[0].phone_hash).toMatch(/^k1:[0-9a-f]{64}$/);
    await new LoginThrottle(store).unlock((await import('../../src/auth/throttle')).loginPhoneKey(`254${u.phone.slice(1)}`));
  });
});
