/**
 * @file throttle.ts
 * @description Brute-force protection for PIN logins and the per-agent STK rate limit (spec gh-5).
 *
 * All state lives in Redis (config/redis.ts). If Redis cannot answer, logins are refused with
 * 503 (fail closed) rather than allowing unlimited guesses; STK initiation is refused likewise.
 *
 * Login (OWASP "device cookies"):
 *  - per phone, anonymous devices: ≥5 failures in 15 min → progressive lockout (1 min, 2, 4, …, 1 h);
 *  - a device that logged in successfully for that phone carries a trusted-device cookie and is
 *    exempt from the anonymous lockout; its own failures are counted against the cookie instead
 *    (≥5 → the cookie is no longer trusted);
 *  - per phone, every device: 20 failures in 24 h → hard lock until an admin unlocks it
 *    (`npm run user:unlock`);
 *  - per IP (anonymous devices only — agents behind one outlet / CGNAT IP keep their trusted
 *    devices): ≥20 failures in 15 min → 429;
 *  - globally: a failure-rate alarm (logged, reported on /health/details).
 * Unknown phones are counted exactly like known ones, so the throttle reveals nothing.
 *
 * Atomicity: one Lua script checks the limits AND counts the attempt before the PIN is verified
 * (reserve → confirmFailure | release), so parallel guesses cannot all slip past the check.
 * Key rotation: locks written under the previous PII key are still honoured, and trusted-device
 * entries bound under it still verify, while PII_HMAC_KEY_PREVIOUS is configured.
 */

import crypto from 'crypto';
import { isRecord } from '../domain/unknown';
import Redis from 'ioredis';
import { redisClient } from '../config/redis';
import { alternateKeyedHashes, keyedHash, keyedHashMatches } from '../config/pii';

export class ThrottleUnavailableError extends Error {}

/** Minimal store the throttles need; Redis in production, an in-memory fake in unit tests. */
export interface ThrottleStore {
  /** Fixed-window counter: increments, setting the TTL on the first hit; returns the new count. */
  incr(key: string, windowMs: number): Promise<number>;
  /** Current counter value (0 when absent). */
  count(key: string): Promise<number>;
  /** Remaining lifetime in ms: null when absent, Infinity when the key never expires. */
  ttl(key: string): Promise<number | null>;
  /** Sets a flag key; ttlMs null = no expiry. */
  set(key: string, ttlMs: number | null): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Adds a member to a windowed set (TTL set on creation); returns the set's size. */
  addToSet(key: string, member: string, windowMs: number): Promise<number>;
  /** Decrements a counter, deleting it at zero. */
  decr(key: string): Promise<void>;
  /** The atomic login check-and-count (RESERVE_SCRIPT semantics). */
  reserveLogin(keys: ReserveKeys, config: LoginThrottleConfig): Promise<ReserveResult>;
}

const INCR_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;
const DECR_SCRIPT = `
local n = redis.call('DECR', KEYS[1])
if n <= 0 then redis.call('DEL', KEYS[1]) end
return n
`;
const SADD_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return redis.call('SCARD', KEYS[1])
`;

export class RedisThrottleStore implements ThrottleStore {
  constructor(private readonly redis: Redis = redisClient) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new ThrottleUnavailableError(`throttle store unavailable: ${(error as Error).message}`);
    }
  }

  incr(key: string, windowMs: number): Promise<number> {
    return this.run(async () => Number(await this.redis.eval(INCR_SCRIPT, 1, key, String(windowMs))));
  }
  count(key: string): Promise<number> {
    return this.run(async () => Number((await this.redis.get(key)) ?? 0));
  }
  ttl(key: string): Promise<number | null> {
    return this.run(async () => {
      const t = await this.redis.pttl(key);
      if (t === -2) return null;
      return t === -1 ? Infinity : t;
    });
  }
  set(key: string, ttlMs: number | null): Promise<void> {
    return this.run(async () => {
      if (ttlMs === null) await this.redis.set(key, '1');
      else await this.redis.set(key, '1', 'PX', Math.max(1, Math.ceil(ttlMs)));
    });
  }
  del(...keys: string[]): Promise<void> {
    return this.run(async () => {
      if (keys.length) await this.redis.del(...keys);
    });
  }
  addToSet(key: string, member: string, windowMs: number): Promise<number> {
    return this.run(async () => Number(await this.redis.eval(SADD_SCRIPT, 1, key, member, String(windowMs))));
  }
  decr(key: string): Promise<void> {
    return this.run(async () => {
      await this.redis.eval(DECR_SCRIPT, 1, key);
    });
  }
  reserveLogin(keys: ReserveKeys, config: LoginThrottleConfig): Promise<ReserveResult> {
    return redisReserve(this.redis, keys, config);
  }
}


const int = (v: string | undefined, fallback: number, min = 1): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export interface LoginThrottleConfig {
  phoneMaxFailures: number;
  phoneWindowMs: number;
  lockBaseMs: number;
  lockMaxMs: number;
  dailyCap: number;
  dailyWindowMs: number;
  ipMaxFailures: number;
  ipWindowMs: number;
  deviceMaxFailures: number;
  globalAlarmPerMinute: number;
  deviceCookieTtlMs: number;
}

export function loginThrottleConfig(env: NodeJS.ProcessEnv = process.env): LoginThrottleConfig {
  return {
    phoneMaxFailures: int(env.AUTH_PHONE_MAX_FAILURES, 5),
    phoneWindowMs: 15 * 60_000,
    lockBaseMs: int(env.AUTH_LOCKOUT_BASE_MS, 60_000),
    lockMaxMs: int(env.AUTH_LOCKOUT_MAX_MS, 60 * 60_000),
    dailyCap: int(env.AUTH_DAILY_FAILURE_CAP, 20),
    dailyWindowMs: 24 * 3600_000,
    ipMaxFailures: int(env.AUTH_IP_MAX_FAILURES, 20),
    ipWindowMs: 15 * 60_000,
    deviceMaxFailures: int(env.AUTH_DEVICE_MAX_FAILURES, 5),
    globalAlarmPerMinute: int(env.AUTH_GLOBAL_FAILURE_ALARM_PER_MINUTE, 100),
    deviceCookieTtlMs: int(env.AUTH_DEVICE_COOKIE_DAYS, 90) * 24 * 3600_000,
  };
}

/** Throttle subject: who is trying (phone hash), from where (IP), and on which device (if trusted). */
export interface LoginSubject {
  /** Keyed hash of the (normalised) phone under the current PII key; unknown phones hash the same way. */
  phoneKey: string;
  /** The same phone under the previous PII key (during a rotation): its locks are honoured too. */
  prevPhoneKeys?: string[];
  ip: string;
  /** Nonce of a valid trusted-device cookie entry for this phone, else null. */
  deviceId: string | null;
}

/** Redis keys one login attempt touches. Locks are read under every configured key, written under the current one. */
export interface ReserveKeys {
  hard: string;
  hardPrev: string;
  phoneLock: string;
  phoneLockPrev: string;
  phoneFailures: string;
  daily: string;
  ip: string;
  device: string | null;
}

export type ReserveResult =
  | { allowed: false; reason: 'locked' | 'phone' | 'ip'; retryAfterMs: number | null }
  | { allowed: true; deviceTrusted: boolean; setHard: boolean; lockMs: number | null };

/**
 * One atomic step: refuse when a limit is hit, otherwise count the attempt as a failure *before*
 * the PIN is verified (a success undoes it). N parallel guesses can therefore never all pass the
 * check before any of them is counted.
 *
 * KEYS: 1 hard, 2 hardPrev, 3 phoneLock, 4 phoneLockPrev, 5 phoneFailures, 6 daily, 7 ip, 8 device
 * ARGV: 1 hasDevice, 2 deviceMax, 3 ipMax, 4 phoneMax, 5 dailyCap, 6 phoneWindowMs, 7 dailyWindowMs,
 *       8 ipWindowMs, 9 deviceTtlMs, 10 lockBaseMs, 11 lockMaxMs
 */
const RESERVE_SCRIPT = `
local function num(k) return tonumber(redis.call('GET', k) or '0') end
local function incr(k, ms)
  local n = redis.call('INCR', k)
  if n == 1 then redis.call('PEXPIRE', k, ms) end
  return n
end
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return {0, 'locked', -1} end
if num(KEYS[6]) >= tonumber(ARGV[5]) then return {0, 'locked', -1} end
local trusted = 0
if ARGV[1] == '1' and num(KEYS[8]) < tonumber(ARGV[2]) then trusted = 1 end
if trusted == 0 then
  if num(KEYS[7]) >= tonumber(ARGV[3]) then return {0, 'ip', redis.call('PTTL', KEYS[7])} end
  local t = redis.call('PTTL', KEYS[3])
  if t ~= -2 then return {0, 'phone', t} end
  t = redis.call('PTTL', KEYS[4])
  if t ~= -2 then return {0, 'phone', t} end
end
local setHard = 0
if incr(KEYS[6], ARGV[7]) >= tonumber(ARGV[5]) then
  redis.call('SET', KEYS[1], '1')
  setHard = 1
end
local lockMs = -1
if trusted == 1 then
  incr(KEYS[8], ARGV[9])
else
  incr(KEYS[7], ARGV[8])
  local n = incr(KEYS[5], ARGV[6])
  if n >= tonumber(ARGV[4]) then
    lockMs = math.floor(math.min(tonumber(ARGV[10]) * 2 ^ math.min(n - tonumber(ARGV[4]), 20), tonumber(ARGV[11])))
    redis.call('SET', KEYS[3], '1', 'PX', lockMs)
  end
end
return {1, trusted, setHard, lockMs}
`;

export function reserveArgs(c: LoginThrottleConfig, hasDevice: boolean): string[] {
  return [
    hasDevice ? '1' : '0',
    c.deviceMaxFailures, c.ipMaxFailures, c.phoneMaxFailures, c.dailyCap,
    c.phoneWindowMs, c.dailyWindowMs, c.ipWindowMs, c.deviceCookieTtlMs, c.lockBaseMs, c.lockMaxMs,
  ].map(String);
}

/** Runs the reserve script against Redis. */
export async function redisReserve(redis: Redis, k: ReserveKeys, c: LoginThrottleConfig): Promise<ReserveResult> {
  const keys = [k.hard, k.hardPrev, k.phoneLock, k.phoneLockPrev, k.phoneFailures, k.daily, k.ip, k.device ?? 'auth:df:-'];
  let r: [number, string | number, number?, number?];
  try {
    r = (await redis.eval(RESERVE_SCRIPT, keys.length, ...keys, ...reserveArgs(c, k.device !== null))) as typeof r;
  } catch (error) {
    throw new ThrottleUnavailableError(`throttle store unavailable: ${(error as Error).message}`);
  }
  if (Number(r[0]) !== 1) {
    const t = Number(r[2]);
    return { allowed: false, reason: r[1] as 'locked' | 'phone' | 'ip', retryAfterMs: t === -1 || Number.isNaN(t) ? null : t };
  }
  return { allowed: true, deviceTrusted: Number(r[1]) === 1, setHard: Number(r[2]) === 1, lockMs: Number(r[3]) >= 0 ? Number(r[3]) : null };
}

const keyFor = (phoneKey: string) => phoneKey.replace(/^k\d+:/, '').slice(0, 32);

/** A reserved attempt: confirm it as a failure, or release it on success. */
export interface Reservation {
  subject: LoginSubject;
  keys: ReserveKeys;
  deviceTrusted: boolean;
  setHard: boolean;
  lockMs: number | null;
}

export type ThrottleVerdict =
  | { allowed: true; reservation: Reservation }
  | { allowed: false; reason: 'locked' | 'phone' | 'ip'; retryAfterS: number | null };

export class LoginThrottle {
  readonly config: LoginThrottleConfig;
  private lastAlarmMinute = -1;
  /** Failures in the current minute crossed the alarm threshold (exposed on /health/details). */
  globalAlarm = false;

  constructor(private readonly store: ThrottleStore = new RedisThrottleStore(), config?: Partial<LoginThrottleConfig>) {
    this.config = { ...loginThrottleConfig(), ...config };
  }

  private keys(s: LoginSubject): ReserveKeys {
    const p = keyFor(s.phoneKey);
    const prev = s.prevPhoneKeys?.length ? keyFor(s.prevPhoneKeys[0]) : p;
    return {
      hard: `auth:hard:${p}`,
      hardPrev: `auth:hard:${prev}`,
      phoneLock: `auth:plock:${p}`,
      phoneLockPrev: `auth:plock:${prev}`,
      phoneFailures: `auth:pf:${p}`,
      daily: `auth:pday:${p}`,
      ip: `auth:ipf:${s.ip}`,
      device: s.deviceId ? `auth:df:${s.deviceId}` : null,
    };
  }

  /**
   * Atomically checks every limit and, when allowed, counts this attempt before the PIN is
   * verified. Throws ThrottleUnavailableError when Redis cannot answer (callers fail closed).
   */
  async reserve(s: LoginSubject): Promise<ThrottleVerdict> {
    const keys = this.keys(s);
    const r = await this.store.reserveLogin(keys, this.config);
    if (!r.allowed) return { allowed: false, reason: r.reason, retryAfterS: secs(r.retryAfterMs) };
    return { allowed: true, reservation: { subject: s, keys, deviceTrusted: r.deviceTrusted, setHard: r.setHard, lockMs: r.lockMs } };
  }

  /** The reserved attempt was a wrong PIN. `hardLocked` is true when it hit the 24 h cap. */
  async confirmFailure(r: Reservation): Promise<{ hardLocked: boolean; lockedForMs: number | null }> {
    await this.countGlobal();
    return { hardLocked: r.setHard, lockedForMs: r.lockMs };
  }

  /**
   * The reserved attempt was not a failure (correct PIN): undo its counts and clear the per-phone
   * lockout (the 24 h cap keeps counting earlier failures).
   */
  async release(r: Reservation): Promise<void> {
    const k = r.keys;
    await this.store.del(k.phoneFailures, k.phoneLock, ...(k.device ? [k.device] : []), ...(r.setHard ? [k.hard] : []));
    await this.store.decr(k.daily);
    if (!r.deviceTrusted) await this.store.decr(k.ip);
  }

  /** Admin unlock (CLI): clears the hard lock and every per-phone counter, under every configured key. */
  async unlock(phoneKeys: string | string[]): Promise<void> {
    for (const phoneKey of Array.isArray(phoneKeys) ? phoneKeys : [phoneKeys]) {
      const k = this.keys({ phoneKey, ip: '-', deviceId: null });
      await this.store.del(k.hard, k.daily, k.phoneFailures, k.phoneLock);
    }
  }

  private async countGlobal(): Promise<void> {
    const minute = Math.floor(Date.now() / 60_000);
    const n = await this.store.incr(`auth:gf:${minute}`, 120_000);
    this.globalAlarm = n >= this.config.globalAlarmPerMinute;
    if (this.globalAlarm && this.lastAlarmMinute !== minute) {
      this.lastAlarmMinute = minute;
      console.error(`[SECURITY ALARM] login failure rate >= ${this.config.globalAlarmPerMinute}/min (distributed guessing?)`);
    }
  }
}

const secs = (ms: number | null): number | null =>
  ms === null || !Number.isFinite(ms) || ms < 0 ? null : Math.max(1, Math.ceil(ms / 1000));

/** Keyed hash of a login phone for throttle keys and audit rows (unknown phones hash the same). */
export function loginPhoneKey(normalisedOrRaw: string): string {
  return keyedHash('auth', `phone:${normalisedOrRaw}`);
}

/** The login phone key under the current PII key, then under the previous key (during a rotation). */
export function loginPhoneKeys(normalisedOrRaw: string): string[] {
  return [loginPhoneKey(normalisedOrRaw), ...alternateKeyedHashes('auth', `phone:${normalisedOrRaw}`)];
}

// ── Trusted-device cookie (OWASP) ───────────────────────────────────────────

/** One phone-bound entry; a shared outlet device holds up to MAX_DEVICE_ENTRIES (newest first). */
interface DeviceEntry {
  p: string;
  d: string;
  e: number;
}
export const MAX_DEVICE_ENTRIES = 5;

/** The MAC-verified entries of a device cookie ("<payload>.<mac>", any configured PII key), or []. */
function deviceEntries(value: string | undefined): DeviceEntry[] {
  if (!value || value.length > 2048) return [];
  const dot = value.indexOf('.');
  if (dot <= 0) return [];
  const payload = value.slice(0, dot);
  if (keyedHashMatches(value.slice(dot + 1), 'device', payload) !== true) return [];
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (x: unknown): x is DeviceEntry =>
        isRecord(x) && typeof x.p === 'string' && typeof x.d === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(x.d) && typeof x.e === 'number'
    );
  } catch {
    return [];
  }
}

/**
 * Adds (or renews) this phone's entry at the front of the device cookie, keeping other phones'
 * unexpired entries (a shared outlet device), at most MAX_DEVICE_ENTRIES.
 */
export function issueDeviceCookie(
  existing: string | undefined,
  phoneKey: string,
  ttlMs: number,
  now = Date.now()
): { value: string; deviceId: string } {
  const deviceId = crypto.randomBytes(18).toString('base64url');
  const mine = keyFor(phoneKey);
  const kept = deviceEntries(existing).filter((x) => x.e > now && x.p !== mine);
  const entries = [{ p: mine, d: deviceId, e: now + ttlMs }, ...kept].slice(0, MAX_DEVICE_ENTRIES);
  const payload = Buffer.from(JSON.stringify(entries)).toString('base64url');
  return { value: `${payload}.${keyedHash('device', payload)}`, deviceId };
}

/**
 * The device id of a valid, unexpired entry bound to this phone — under the current PII key or,
 * during a rotation, the previous one — else null.
 */
export function verifyDeviceCookie(value: string | undefined, phoneKeys: string | string[], now = Date.now()): string | null {
  const wanted = new Set((Array.isArray(phoneKeys) ? phoneKeys : [phoneKeys]).map(keyFor));
  const hit = deviceEntries(value).find((x) => wanted.has(x.p) && x.e > now);
  return hit ? hit.d : null;
}

/** True when the cookie already carries an entry bound to the phone under the *current* key. */
export function deviceCookieCurrent(value: string | undefined, phoneKey: string, now = Date.now()): boolean {
  return deviceEntries(value).some((x) => x.p === keyFor(phoneKey) && x.e > now);
}

// ── Per-agent STK initiation rate limit ─────────────────────────────────────

export class StkRateLimiter {
  constructor(
    private readonly store: ThrottleStore = new RedisThrottleStore(),
    readonly perMinute = int(process.env.STK_RATE_LIMIT_PER_MINUTE, 5)
  ) {}

  /**
   * Counts distinct idempotency keys per agent per minute, so concurrent retries of the same
   * request count once. Throws ThrottleUnavailableError when Redis cannot answer.
   */
  async hit(agentId: string, idempotencyKey: string, now = Date.now()): Promise<{ allowed: boolean; retryAfterS: number }> {
    const window = Math.floor(now / 60_000);
    const size = await this.store.addToSet(`stk:rl:${agentId}:${window}`, idempotencyKey, 120_000);
    return { allowed: size <= this.perMinute, retryAfterS: Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) };
  }
}

/** Payout-destination verifications (B2C) per agent per 24 h (spec gh-11). */
export class PayoutVerificationLimiter {
  constructor(
    private readonly store: ThrottleStore = new RedisThrottleStore(),
    readonly perDay = 3
  ) {}

  /** Counts one verification. Throws ThrottleUnavailableError when Redis cannot answer. */
  async hit(agentId: string): Promise<{ allowed: boolean; retryAfterS: number }> {
    const key = `payout:verify:${agentId}`;
    const n = await this.store.incr(key, 24 * 3600_000);
    if (n <= this.perDay) return { allowed: true, retryAfterS: 0 };
    const ttl = await this.store.ttl(key);
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil((ttl !== null && Number.isFinite(ttl) ? ttl : 24 * 3600_000) / 1000)) };
  }
}
