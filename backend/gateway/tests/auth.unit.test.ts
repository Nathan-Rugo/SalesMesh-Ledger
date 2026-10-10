/**
 * @file auth.unit.test.ts
 * @description spec gh-5 building blocks: RS256 tokens (tampering matrix row), key ring,
 * scrypt PIN credentials and policy, Redis login throttle (mocked store), trusted-device
 * cookies and the per-agent STK rate limiter.
 */

import crypto from 'crypto';
import { SignJWT } from 'jose';
import { ACCESS_TOKEN_TTL_S, loadJwtKeyring, JwtKeyError } from '../src/config/jwt';
import { AuthTokenError, signAccessToken, verifyAccessToken } from '../src/auth/tokens';
import { generateOneTimePin, hashPin, pinPolicyViolation, verifyPin, currentParams } from '../src/auth/credentials';
import {
  deviceCookieCurrent,
  issueDeviceCookie,
  LoginThrottle,
  loginPhoneKey,
  loginPhoneKeys,
  StkRateLimiter,
  ThrottleUnavailableError,
  verifyDeviceCookie,
  type LoginSubject,
} from '../src/auth/throttle';
import { MemoryThrottleStore } from './support/memory-store';

const USER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ISS = 'salesmesh-gateway';
const AUD = 'salesmesh-api';
const ownKey = () => crypto.createPrivateKey(process.env.JWT_PRIVATE_KEY!);

function forge(opts: {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  key?: crypto.KeyObject | Uint8Array;
  alg?: string;
  exp?: number;
  nbf?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ user_id: USER, role: 'SALES_AGENT', ...(opts.claims ?? {}) })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', typ: 'at+jwt', kid: 'test-k1', ...(opts.header ?? {}) } as any)
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(USER)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setNotBefore(opts.nbf ?? now)
    .setExpirationTime(opts.exp ?? now + 900);
  return jwt.sign(opts.key ?? ownKey());
}

describe('RS256 access tokens', () => {
  it('signs a 15-minute token carrying user_id and role, verified without a DB', async () => {
    const { token, expiresIn } = await signAccessToken({ userId: USER, role: 'SALES_AGENT', pinChangeRequired: false });
    expect(expiresIn).toBe(900);
    const [h] = token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'test-k1' });
    const claims = await verifyAccessToken(token);
    expect(claims).toMatchObject({ userId: USER, role: 'SALES_AGENT', pinChangeRequired: false });
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(890);
  });

  it('JWT_ACCESS_TTL_SECONDS is clamped to 15 minutes', () => {
    jest.isolateModules(() => {
      const saved = process.env.JWT_ACCESS_TTL_SECONDS;
      process.env.JWT_ACCESS_TTL_SECONDS = '86400';
      try {
        expect(require('../src/config/jwt').ACCESS_TOKEN_TTL_S).toBe(900);
      } finally {
        if (saved === undefined) delete process.env.JWT_ACCESS_TTL_SECONDS;
        else process.env.JWT_ACCESS_TTL_SECONDS = saved;
      }
    });
    expect(ACCESS_TOKEN_TTL_S).toBe(900);
  });

  it('carries pin_change_required while the one-time PIN is unchanged', async () => {
    const { token } = await signAccessToken({ userId: USER, role: 'SALES_AGENT', pinChangeRequired: true });
    expect((await verifyAccessToken(token)).pinChangeRequired).toBe(true);
  });

  describe('JWT tampering → AuthTokenError (401), never a crash', () => {
    const reject = async (token: string | Promise<string>, now?: Date) =>
      expect(verifyAccessToken(await token, now)).rejects.toBeInstanceOf(AuthTokenError);

    it('bad signature (payload edited)', async () => {
      const { token } = await signAccessToken({ userId: USER, role: 'SALES_AGENT', pinChangeRequired: false });
      const [h, p, s] = token.split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      claims.role = 'MERCHANT_ADMIN';
      await reject(`${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`);
    });

    it('alg none', async () => {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payload = { user_id: USER, role: 'MERCHANT_ADMIN', sub: USER, jti: 'x', iss: ISS, aud: AUD, iat: now, nbf: now, exp: now + 900 };
      await reject(`${enc({ alg: 'none', typ: 'at+jwt', kid: 'test-k1' })}.${enc(payload)}.`);
    });

    it('HS256 signed with the public key as the HMAC secret (algorithm confusion)', async () => {
      const pub = crypto.createPublicKey(ownKey()).export({ type: 'spki', format: 'pem' });
      await reject(forge({ alg: 'HS256', key: new Uint8Array(Buffer.from(pub)) }));
    });

    it('wrong iss / wrong aud', async () => {
      const now = Math.floor(Date.now() / 1000);
      const base = () =>
        new SignJWT({ user_id: USER, role: 'SALES_AGENT' })
          .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test-k1' })
          .setSubject(USER)
          .setJti('j')
          .setIssuedAt(now)
          .setNotBefore(now)
          .setExpirationTime(now + 900);
      await reject(base().setIssuer('evil').setAudience(AUD).sign(ownKey()));
      await reject(base().setIssuer(ISS).setAudience('other-api').sign(ownKey()));
    });

    it('expired beyond the 30 s tolerance (within it still accepted); nbf in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(verifyAccessToken(await forge({ exp: now - 20 }))).resolves.toMatchObject({ userId: USER });
      await reject(forge({ exp: now - 40 }));
      await reject(forge({ nbf: now + 120 }));
    });

    it('unknown kid, missing kid, and a jku/jwk header pointing at an attacker key', async () => {
      const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      await reject(forge({ header: { kid: 'attacker' } }));
      await reject(forge({ header: { kid: undefined } }));
      await reject(forge({ key: attacker.privateKey, header: { kid: 'attacker', jku: 'https://evil.example/jwks.json' } }));
      const jwk = attacker.publicKey.export({ format: 'jwk' });
      await reject(forge({ key: attacker.privateKey, header: { jwk } })); // our kid, their key: bad signature
      await reject(forge({ key: attacker.privateKey, header: { x5u: 'https://evil.example/cert.pem' } }));
    });

    it('wrong typ, missing jti/sub, user_id ≠ sub, unknown role, garbage', async () => {
      await reject(forge({ header: { typ: 'JWT' } }));
      await reject(forge({ claims: { user_id: crypto.randomUUID() } }));
      await reject(forge({ claims: { role: 'ROOT' } }));
      const now = Math.floor(Date.now() / 1000);
      await reject(
        new SignJWT({ user_id: USER, role: 'SALES_AGENT' })
          .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test-k1' })
          .setIssuer(ISS).setAudience(AUD).setSubject(USER).setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 900)
          .sign(ownKey())
      );
      await reject('not.a.jwt');
      await reject('');
    });
  });
});

describe('JWT key ring', () => {
  const pem = (k: crypto.KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('refuses RSA keys under 2048 bits, non-RSA keys, a missing key or kid', () => {
    const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(() => loadJwtKeyring({ JWT_PRIVATE_KEY: pem(small), JWT_KEY_ID: 'k' })).toThrow(/at least 2048 bits/);
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(() => loadJwtKeyring({ JWT_PRIVATE_KEY: pem(ec), JWT_KEY_ID: 'k' })).toThrow(/RSA/);
    expect(() => loadJwtKeyring({})).toThrow(JwtKeyError);
    expect(() => loadJwtKeyring({ JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY })).toThrow(/JWT_KEY_ID/);
    expect(() => loadJwtKeyring({ JWT_PRIVATE_KEY: 'not a pem', JWT_KEY_ID: 'k' })).toThrow(/PEM/);
  });

  it('accepts a single-line PEM ("\\n") and a previous public key for rotation', async () => {
    const saved = { ...process.env };
    try {
      const oldToken = (await signAccessToken({ userId: USER, role: 'MERCHANT_ADMIN', pinChangeRequired: false })).token;
      const next = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      process.env.JWT_PREVIOUS_PUBLIC_KEY = crypto.createPublicKey(ownKey()).export({ type: 'spki', format: 'pem' }).toString();
      process.env.JWT_PREVIOUS_KEY_ID = 'test-k1';
      process.env.JWT_PRIVATE_KEY = pem(next.privateKey).replace(/\n/g, '\\n');
      process.env.JWT_KEY_ID = 'test-k2';
      await expect(verifyAccessToken(oldToken)).resolves.toMatchObject({ role: 'MERCHANT_ADMIN' }); // still valid
      const newToken = (await signAccessToken({ userId: USER, role: 'SALES_AGENT', pinChangeRequired: false })).token;
      expect(JSON.parse(Buffer.from(newToken.split('.')[0], 'base64url').toString()).kid).toBe('test-k2');
      delete process.env.JWT_PREVIOUS_PUBLIC_KEY;
      await expect(verifyAccessToken(oldToken)).rejects.toBeInstanceOf(AuthTokenError); // retired
    } finally {
      process.env = saved;
    }
  });
});

describe('PIN credentials (scrypt)', () => {
  it('hashes with a per-user salt and versioned params; verifies in constant time', async () => {
    const a = await hashPin('4826');
    const b = await hashPin('4826');
    expect(a.algorithm).toBe('scrypt');
    expect(a.params).toEqual({ v: 1, logN: 10, r: 8, p: 1, keylen: 32 });
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
    expect(await verifyPin('4826', a)).toBe(true);
    expect(await verifyPin('4827', a)).toBe(false);
    expect(await verifyPin('4826', null)).toBe(false); // unknown user: dummy hash, still false
    expect(await verifyPin('4826', { ...a, params: { ...a.params, logN: 99 } as any })).toBe(false);
  });

  it('production never goes below logN 14; default 15', () => {
    expect(currentParams({ NODE_ENV: 'production', AUTH_SCRYPT_LOG_N: '8' }).logN).toBe(14);
    expect(currentParams({ NODE_ENV: 'production' }).logN).toBe(15);
  });

  it('unknown-user verification costs about as much as a real one', async () => {
    const cred = await hashPin('4826');
    await verifyPin('0000', null); // warm the dummy
    // Median of several runs: robust to scheduler jitter when jest runs suites in parallel.
    const time = async (fn: () => Promise<unknown>) => {
      const samples: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t = process.hrtime.bigint();
        await fn();
        samples.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      return samples.sort((a, b) => a - b)[4];
    };
    const known = await time(() => verifyPin('1111', cred));
    const unknown = await time(() => verifyPin('1111', null));
    expect(unknown).toBeGreaterThan(known * 0.2);
    expect(unknown).toBeLessThan(known * 5 + 10);
  });

  it.each([
    ['123', 'pin_format'],
    ['1234567', 'pin_format'],
    ['12a4', 'pin_format'],
    [' 4826', 'pin_format'],
    ['1111', 'pin_repeated'],
    ['000000', 'pin_repeated'],
    ['1234', 'pin_sequence'],
    ['0123', 'pin_sequence'],
    ['4321', 'pin_sequence'],
    ['987654', 'pin_sequence'],
    ['1212', 'pin_common'],
    ['2580', 'pin_common'],
    ['112233', 'pin_common'],
    ['4826', null],
    ['590317', null],
  ])('policy: %s → %s', (pin, expected) => {
    expect(pinPolicyViolation(pin)).toBe(expected);
  });

  it('one-time PINs are 6 digits and pass the policy', () => {
    for (let i = 0; i < 200; i++) {
      const pin = generateOneTimePin();
      expect(pin).toMatch(/^\d{6}$/);
      expect(pinPolicyViolation(pin)).toBeNull();
    }
  });
});

describe('login throttle (mocked Redis)', () => {
  const subject = (phone = '254712345678', ip = '10.0.0.1', deviceId: string | null = null) => ({
    phoneKey: loginPhoneKey(phone),
    ip,
    deviceId,
  });
  let store: MemoryThrottleStore;
  let throttle: LoginThrottle;
  beforeEach(() => {
    store = new MemoryThrottleStore();
    throttle = new LoginThrottle(store, { globalAlarmPerMinute: 1000 });
  });
  /** One wrong-PIN attempt: reserve, then confirm the failure. */
  const fail = async (s: LoginSubject) => {
    const v = await throttle.reserve(s);
    if (!v.allowed) return v;
    return { allowed: true as const, ...(await throttle.confirmFailure(v.reservation)) };
  };

  it('≥5 failures in 15 min for a phone → locked with Retry-After; progressive (1 min, 2 min, …)', async () => {
    const s = subject();
    for (let i = 0; i < 4; i++) expect(await fail(s)).toMatchObject({ allowed: true, lockedForMs: null });
    expect(await fail(s)).toMatchObject({ allowed: true, lockedForMs: 60_000 });
    expect(await throttle.reserve(s)).toEqual({ allowed: false, reason: 'phone', retryAfterS: 60 });
    store.advance(61_000);
    expect(await fail(s)).toMatchObject({ allowed: true, lockedForMs: 120_000 });
  });

  it('reserve is atomic: 20 parallel guesses for one phone → only the lockout threshold may verify', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => throttle.reserve(subject())));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed && r.reason === 'phone')).toHaveLength(15);
  });

  it('a correct PIN releases its reservation: counts undone, lockout cleared', async () => {
    const s = subject();
    for (let i = 0; i < 3; i++) await fail(s);
    const v = await throttle.reserve(s);
    if (!v.allowed) throw new Error('expected allowed');
    await throttle.release(v.reservation);
    expect(store.keys().filter((k) => k.startsWith('auth:pf:'))).toEqual([]);
    expect(await store.count(`auth:pday:${s.phoneKey.slice(3, 35)}`)).toBe(3); // earlier failures still count
    expect(await store.count(`auth:ipf:${s.ip}`)).toBe(3);
  });

  it('unknown phones are counted exactly like known ones (no enumeration)', async () => {
    const unknown = subject('254799999999');
    for (let i = 0; i < 5; i++) await fail(unknown);
    expect(await throttle.reserve(unknown)).toMatchObject({ allowed: false, reason: 'phone' });
  });

  it('a trusted device is exempt from the anonymous lockout AND the IP limit; its own failures revoke the trust', async () => {
    const anon = subject();
    for (let i = 0; i < 5; i++) await fail(anon);
    for (let i = 0; i < 20; i++) await fail(subject(`2547120000${String(i).padStart(2, '0')}`)); // outlet IP saturated
    const trusted = subject('254712345678', '10.0.0.1', 'device-abcdefghijklmnop');
    const v = await throttle.reserve(trusted);
    expect(v).toMatchObject({ allowed: true, reservation: { deviceTrusted: true } });
    if (v.allowed) await throttle.confirmFailure(v.reservation);
    for (let i = 0; i < 4; i++) await fail(trusted);
    expect(await throttle.reserve(trusted)).toMatchObject({ allowed: false }); // anonymous again: IP / phone limits apply
  });

  it('20 failures in 24 h → hard lock until an admin unlocks it (trusted devices included)', async () => {
    const s = subject();
    let hard = 0;
    for (let i = 0; i < 20; i++) {
      store.advance(2 * 3600_000); // spread out: the 15-minute lock never binds
      const r = await fail(s);
      if ('hardLocked' in r && r.hardLocked) hard++;
    }
    expect(hard).toBe(0); // 24 h window rolled over
    for (let i = 0; i < 20; i++) {
      store.advance(16 * 60_000);
      const r = await fail(s);
      if ('hardLocked' in r && r.hardLocked) hard++;
    }
    expect(hard).toBe(1);
    expect(await throttle.reserve(s)).toEqual({ allowed: false, reason: 'locked', retryAfterS: null });
    expect(await throttle.reserve({ ...s, deviceId: 'device-abcdefghijklmnop' })).toMatchObject({ reason: 'locked' });
    store.advance(48 * 3600_000);
    expect(await throttle.reserve(s)).toMatchObject({ reason: 'locked' }); // never expires
    await throttle.unlock(s.phoneKey);
    expect((await throttle.reserve(s)).allowed).toBe(true);
  });

  it('PII key rotation: locks written under the previous key are still honoured', async () => {
    const saved = { ...process.env };
    try {
      const old = subject();
      for (let i = 0; i < 5; i++) await fail(old); // locked under k1
      process.env.PII_HMAC_KEY_PREVIOUS = process.env.PII_HMAC_KEY;
      process.env.PII_HMAC_KEY_PREVIOUS_ID = 'k1';
      process.env.PII_HMAC_KEY = 'rotated-key-for-tests-0123456789abcdef!!';
      process.env.PII_HMAC_KEY_ID = 'k2';
      const [phoneKey, ...prevPhoneKeys] = loginPhoneKeys('254712345678');
      expect(phoneKey).toMatch(/^k2:/);
      expect(await throttle.reserve({ phoneKey, ip: '10.0.0.1', deviceId: null })).toMatchObject({ allowed: true }); // without prev: lifted
      expect(await throttle.reserve({ phoneKey, prevPhoneKeys, ip: '10.0.0.3', deviceId: null })).toMatchObject({
        allowed: false,
        reason: 'phone',
      });
      await throttle.unlock([phoneKey, ...prevPhoneKeys]);
      expect((await throttle.reserve({ phoneKey, prevPhoneKeys, ip: '10.0.0.4', deviceId: null })).allowed).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it('per-IP threshold across many phones (distributed guessing from one source)', async () => {
    for (let i = 0; i < 20; i++) await fail(subject(`2547120000${String(i).padStart(2, '0')}`));
    expect(await throttle.reserve(subject('254711111111'))).toMatchObject({ allowed: false, reason: 'ip' });
    expect((await throttle.reserve(subject('254711111111', '10.0.0.2'))).allowed).toBe(true);
  });

  it('global failure-rate alarm', async () => {
    const t = new LoginThrottle(store, { globalAlarmPerMinute: 3 });
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < 3; i++) {
      const v = await t.reserve(subject(`25471000000${i}`, `10.1.0.${i}`));
      if (v.allowed) await t.confirmFailure(v.reservation);
    }
    expect(t.globalAlarm).toBe(true);
    expect(err.mock.calls.flat().join(' ')).toMatch(/SECURITY ALARM.*login failure rate/);
    err.mockRestore();
  });

  it('Redis down → ThrottleUnavailableError (callers fail closed)', async () => {
    store.down = true;
    await expect(throttle.reserve(subject())).rejects.toBeInstanceOf(ThrottleUnavailableError);
  });
});

describe('trusted-device cookie', () => {
  const phoneKey = loginPhoneKey('254712345678');
  it('round-trips for the same phone only; tampered or expired cookies are untrusted', () => {
    const { value, deviceId } = issueDeviceCookie(undefined, phoneKey, 60_000);
    expect(verifyDeviceCookie(value, phoneKey)).toBe(deviceId);
    expect(verifyDeviceCookie(value, loginPhoneKey('254700000000'))).toBeNull();
    const [p, mac] = value.split('.');
    const entries = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify(entries.map((e: any) => ({ ...e, e: Date.now() + 1e12 })))).toString('base64url');
    expect(verifyDeviceCookie(`${forged}.${mac}`, phoneKey)).toBeNull();
    expect(verifyDeviceCookie(value, phoneKey, Date.now() + 120_000)).toBeNull();
    expect(verifyDeviceCookie(undefined, phoneKey)).toBeNull();
    expect(verifyDeviceCookie('garbage', phoneKey)).toBeNull();
  });

  it('a shared outlet device holds up to 5 phone-bound entries, newest first; a second agent does not evict the first', () => {
    const a = loginPhoneKey('254711111111');
    const b = loginPhoneKey('254722222222');
    const first = issueDeviceCookie(undefined, a, 60_000);
    const second = issueDeviceCookie(first.value, b, 60_000);
    expect(verifyDeviceCookie(second.value, a)).toBe(first.deviceId);
    expect(verifyDeviceCookie(second.value, b)).toBe(second.deviceId);
    expect(deviceCookieCurrent(second.value, a)).toBe(true);
    let v = second.value;
    for (let i = 0; i < 5; i++) v = issueDeviceCookie(v, loginPhoneKey(`25473333333${i}`), 60_000).value;
    expect(verifyDeviceCookie(v, a)).toBeNull(); // oldest evicted at 5
    expect(verifyDeviceCookie(v, loginPhoneKey('254733333334'))).not.toBeNull();
    // Re-login renews (replaces) the phone's own entry instead of duplicating it.
    const renewed = issueDeviceCookie(second.value, a, 60_000);
    const list = JSON.parse(Buffer.from(renewed.value.split('.')[0], 'base64url').toString());
    expect(list).toHaveLength(2);
    expect(verifyDeviceCookie(renewed.value, a)).toBe(renewed.deviceId);
  });

  it('PII key rotation: an entry bound (and MAC\'d) under the previous key still verifies', () => {
    const saved = { ...process.env };
    try {
      const { value, deviceId } = issueDeviceCookie(undefined, loginPhoneKey('254712345678'), 60_000);
      process.env.PII_HMAC_KEY_PREVIOUS = process.env.PII_HMAC_KEY;
      process.env.PII_HMAC_KEY_PREVIOUS_ID = 'k1';
      process.env.PII_HMAC_KEY = 'rotated-key-for-tests-0123456789abcdef!!';
      process.env.PII_HMAC_KEY_ID = 'k2';
      const keys = loginPhoneKeys('254712345678');
      expect(verifyDeviceCookie(value, keys[0])).toBeNull(); // current key only: not found
      expect(verifyDeviceCookie(value, keys)).toBe(deviceId);
      expect(deviceCookieCurrent(value, keys[0])).toBe(false); // re-issued under k2 at the next login
    } finally {
      process.env = saved;
    }
  });
});

describe('per-agent STK rate limit', () => {
  it('counts distinct Idempotency-Keys per minute: concurrent retries of one key count once', async () => {
    const store = new MemoryThrottleStore();
    const rl = new StkRateLimiter(store, 3);
    for (let i = 0; i < 10; i++) expect((await rl.hit('agent-1', 'same-key')).allowed).toBe(true);
    expect((await rl.hit('agent-1', 'k2')).allowed).toBe(true);
    expect((await rl.hit('agent-1', 'k3')).allowed).toBe(true);
    const over = await rl.hit('agent-1', 'k4');
    expect(over.allowed).toBe(false);
    expect(over.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(over.retryAfterS).toBeLessThanOrEqual(60);
    expect((await rl.hit('agent-2', 'k1')).allowed).toBe(true);
  });
});
