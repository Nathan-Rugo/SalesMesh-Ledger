/**
 * In-memory ThrottleStore (the "mocked Redis" for unit tests). `down = true` makes every call
 * throw like an unreachable Redis; `now` can be moved to expire windows and lockouts.
 */

import {
  ThrottleUnavailableError,
  type LoginThrottleConfig,
  type ReserveKeys,
  type ReserveResult,
  type ThrottleStore,
} from '../../src/auth/throttle';

interface Entry {
  value: number | Set<string>;
  exp: number | null;
}

export class MemoryThrottleStore implements ThrottleStore {
  down = false;
  offsetMs = 0;
  private readonly m = new Map<string, Entry>();

  now(): number {
    return Date.now() + this.offsetMs;
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  private guard(): void {
    if (this.down) throw new ThrottleUnavailableError('throttle store unavailable: Connection is closed.');
  }

  private live(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (e && e.exp !== null && e.exp <= this.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }

  keys(): string[] {
    return [...this.m.keys()].filter((k) => this.live(k));
  }

  async incr(key: string, windowMs: number): Promise<number> {
    this.guard();
    const e = this.live(key);
    if (!e) {
      this.m.set(key, { value: 1, exp: this.now() + windowMs });
      return 1;
    }
    e.value = (e.value as number) + 1;
    return e.value;
  }

  async count(key: string): Promise<number> {
    this.guard();
    const e = this.live(key);
    return e && typeof e.value === 'number' ? e.value : 0;
  }

  async ttl(key: string): Promise<number | null> {
    this.guard();
    const e = this.live(key);
    if (!e) return null;
    return e.exp === null ? Infinity : e.exp - this.now();
  }

  async set(key: string, ttlMs: number | null): Promise<void> {
    this.guard();
    this.m.set(key, { value: 1, exp: ttlMs === null ? null : this.now() + ttlMs });
  }

  async del(...keys: string[]): Promise<void> {
    this.guard();
    for (const k of keys) this.m.delete(k);
  }

  async decr(key: string): Promise<void> {
    this.guard();
    const e = this.live(key);
    if (!e) return;
    e.value = (e.value as number) - 1;
    if ((e.value as number) <= 0) this.m.delete(key);
  }

  /** JS mirror of RESERVE_SCRIPT (atomic here: no await between check and count). */
  async reserveLogin(k: ReserveKeys, c: LoginThrottleConfig): Promise<ReserveResult> {
    this.guard();
    const num = (key: string) => {
      const e = this.live(key);
      return e && typeof e.value === 'number' ? e.value : 0;
    };
    const pttl = (key: string): number | null => {
      const e = this.live(key);
      if (!e) return null;
      return e.exp === null ? -1 : e.exp - this.now();
    };
    const incr = (key: string, ms: number) => {
      const e = this.live(key);
      if (!e) {
        this.m.set(key, { value: 1, exp: this.now() + ms });
        return 1;
      }
      e.value = (e.value as number) + 1;
      return e.value as number;
    };
    if (this.live(k.hard) || this.live(k.hardPrev) || num(k.daily) >= c.dailyCap) {
      return { allowed: false, reason: 'locked', retryAfterMs: null };
    }
    const trusted = k.device !== null && num(k.device) < c.deviceMaxFailures;
    if (!trusted) {
      if (num(k.ip) >= c.ipMaxFailures) return { allowed: false, reason: 'ip', retryAfterMs: pttl(k.ip) };
      for (const lock of [k.phoneLock, k.phoneLockPrev]) {
        const t = pttl(lock);
        if (t !== null) return { allowed: false, reason: 'phone', retryAfterMs: t };
      }
    }
    let setHard = false;
    if (incr(k.daily, c.dailyWindowMs) >= c.dailyCap) {
      this.m.set(k.hard, { value: 1, exp: null });
      setHard = true;
    }
    let lockMs: number | null = null;
    if (trusted) incr(k.device!, c.deviceCookieTtlMs);
    else {
      incr(k.ip, c.ipWindowMs);
      const n = incr(k.phoneFailures, c.phoneWindowMs);
      if (n >= c.phoneMaxFailures) {
        lockMs = Math.floor(Math.min(c.lockBaseMs * 2 ** Math.min(n - c.phoneMaxFailures, 20), c.lockMaxMs));
        this.m.set(k.phoneLock, { value: 1, exp: this.now() + lockMs });
      }
    }
    return { allowed: true, deviceTrusted: trusted, setHard, lockMs };
  }

  async addToSet(key: string, member: string, windowMs: number): Promise<number> {
    this.guard();
    let e = this.live(key);
    if (!e) {
      e = { value: new Set<string>(), exp: this.now() + windowMs };
      this.m.set(key, e);
    }
    (e.value as Set<string>).add(member);
    return (e.value as Set<string>).size;
  }
}
