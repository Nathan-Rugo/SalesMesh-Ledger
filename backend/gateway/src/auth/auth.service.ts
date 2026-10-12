/**
 * @file auth.service.ts
 * @description PIN login, rotating refresh-token families, logout and PIN change (spec gh-5).
 *
 * Refresh tokens follow the IETF OAuth 2.0 Security BCP: opaque, random, stored only as a hash,
 * rotated on every use (atomic UPDATE … WHERE rotated_at IS NULL AND revoked_at IS NULL), and a
 * rotated token presented again revokes its whole family (theft detection) — except within a
 * short grace window (concurrent tabs, a lost response), which yields an access token only.
 * Every refresh re-derives role, must_change and disabled status from the database.
 */

import crypto from 'crypto';
import pool from '../config/db';
import { REFRESH_FAMILY_MAX_S, REFRESH_TOKEN_TTL_S } from '../config/jwt';
import { keyedHash } from '../config/pii';
import { normaliseKenyanMsisdn } from '../domain/callback';
import {
  claimRotation,
  findRefreshToken,
  findUserById,
  findUserByPhone,
  insertAuthEvent,
  insertRefreshToken,
  revokeAllForUser,
  revokeFamily,
  supersedeUnusedTokens,
  upsertCredential,
  type AuthEvent,
  type UserAuthState,
} from '../repositories/auth.repository';
import { withTransaction, type Db, type TxDb } from '../repositories/db.types';
import { insertSubjectSecurityEvent } from '../repositories/security.repository';
import { metrics as defaultMetrics, type GatewayMetrics } from '../services/metrics.service';
import { hashPin, pinPolicyViolation, verifyPin, type PinViolation } from './credentials';
import {
  deviceCookieCurrent,
  issueDeviceCookie,
  LoginThrottle,
  loginPhoneKeys,
  ThrottleUnavailableError,
  verifyDeviceCookie,
  type LoginSubject,
  type Reservation,
} from './throttle';
import { signAccessToken } from './tokens';

/** A rotated refresh token presented again within this many seconds is a race, not theft. */
export const REFRESH_REUSE_GRACE_S = 20;

export interface Session {
  accessToken: string;
  expiresIn: number;
  /** New refresh token to set as the cookie. */
  refreshToken: string;
  userId: string;
  role: UserAuthState['role'];
  pinChangeRequired: boolean;
}

export interface ClientInfo {
  ip: string;
  userAgent: string | undefined;
  deviceCookie: string | undefined;
}

export type LoginResult =
  | { kind: 'ok'; session: Session; deviceCookie: string | null }
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterS: number | null }
  | { kind: 'unavailable' };

export type RefreshResult =
  | { kind: 'ok'; session: Session }
  | { kind: 'invalid'; reason: 'missing' | 'unknown' | 'expired' | 'revoked' | 'disabled' | 'reuse' };

export type PinChangeResult =
  | { kind: 'ok'; session: Session }
  | { kind: 'weak_pin'; violation: PinViolation | 'pin_unchanged' | 'current_pin_missing' }
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterS: number | null }
  | { kind: 'unavailable' };

export type PinConfirmResult =
  | { kind: 'ok'; phoneNumber: string }
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterS: number | null }
  | { kind: 'unavailable' };

export const hashRefreshToken = (token: string): string =>
  `sha256:${crypto.createHash('sha256').update(token, 'utf-8').digest('hex')}`;

export interface AuthServiceDeps {
  db?: TxDb;
  throttle?: LoginThrottle;
  metrics?: GatewayMetrics;
}

export class AuthService {
  readonly db: TxDb;
  readonly throttle: LoginThrottle;
  private readonly metrics: GatewayMetrics;

  constructor(deps: AuthServiceDeps = {}) {
    this.db = deps.db ?? pool;
    this.throttle = deps.throttle ?? new LoginThrottle();
    this.metrics = deps.metrics ?? defaultMetrics;
  }

  // ── login ────────────────────────────────────────────────────────────────

  async login(phone: unknown, pin: unknown, client: ClientInfo): Promise<LoginResult> {
    const normalised = normaliseKenyanMsisdn(phone);
    // Unknown and malformed phones are throttled exactly like real ones (no enumeration).
    const subject = this.subject(normalised ?? `raw:${String(phone ?? '').slice(0, 32)}`, client);
    const phoneKey = subject.phoneKey;
    const audit = (type: AuthEvent['type'], userId: string | null, reason: string | null) =>
      this.audit({ type, userId, phoneHash: phoneKey, ip: client.ip, userAgentHash: uaHash(client.userAgent), reason });

    // Reserve (check + count) atomically BEFORE verifying: parallel guesses cannot all pass.
    let reservation: Reservation;
    try {
      const verdict = await this.throttle.reserve(subject);
      if (!verdict.allowed) {
        this.metrics.login.throttled += 1;
        void audit('LOGIN_THROTTLED', null, verdict.reason);
        return { kind: 'throttled', retryAfterS: verdict.retryAfterS };
      }
      reservation = verdict.reservation;
    } catch (error) {
      return this.unavailable(error);
    }

    let user: UserAuthState | null;
    let pinOk: boolean;
    try {
      user = normalised ? await findUserByPhone(this.db, normalised) : null;
      pinOk = await verifyPin(typeof pin === 'string' ? pin : '', user?.credential ?? null); // always one scrypt run
    } catch (error) {
      await this.release(reservation); // a DB error is not a wrong PIN
      throw error;
    }
    const expired = !!user && user.mustChange && !!user.oneTimeExpiresAt && user.oneTimeExpiresAt.getTime() <= Date.now();

    if (!pinOk || !user) {
      await this.countFailure(reservation, user?.userId ?? null);
      this.metrics.login.failure += 1;
      void audit('LOGIN_FAILURE', user?.userId ?? null, 'bad_credentials');
      return { kind: 'invalid' };
    }
    await this.release(reservation); // the PIN was right: not a guessing failure
    if (user.disabled || expired) {
      this.metrics.login.failure += 1;
      void audit('LOGIN_FAILURE', user.userId, user.disabled ? 'disabled' : 'one_time_pin_expired');
      return { kind: 'invalid' };
    }

    const session = await this.issueSession(this.db, user, null, client.ip);
    // Add (or renew) this phone's entry in the shared device cookie unless it is current already.
    const device = deviceCookieCurrent(client.deviceCookie, phoneKey)
      ? null
      : issueDeviceCookie(client.deviceCookie, phoneKey, this.throttle.config.deviceCookieTtlMs).value;
    this.metrics.login.success += 1;
    void audit('LOGIN_SUCCESS', user.userId, null);
    return { kind: 'ok', session, deviceCookie: device };
  }

  // ── refresh / logout ─────────────────────────────────────────────────────

  async refresh(token: string | undefined, client: ClientInfo): Promise<RefreshResult> {
    if (!token || token.length > 200) return { kind: 'invalid', reason: 'missing' };
    const tokenHash = hashRefreshToken(token);
    const result = await withTransaction(this.db, async (tx) => {
      const claimed = await claimRotation(tx, tokenHash);
      if (claimed) {
        const user = await findUserById(tx, claimed.userId);
        if (!user || user.disabled || !user.credential) {
          await revokeFamily(tx, claimed.familyId);
          return { kind: 'invalid', reason: 'disabled', userId: claimed.userId } as const;
        }
        const session = await this.issueSession(tx, user, claimed, client.ip);
        return { kind: 'ok', session, grace: false } as const;
      }

      const row = await findRefreshToken(tx, tokenHash, REFRESH_REUSE_GRACE_S);
      if (!row) return { kind: 'invalid', reason: 'unknown', userId: null } as const;
      if (row.revokedAt || row.familyRevoked) return { kind: 'invalid', reason: 'revoked', userId: row.userId } as const;
      if (row.rotatedAt) {
        if (row.recentlyRotated) {
          // Concurrent tabs / a lost response: no revocation. The client may never have received the
          // successor, so issue a fresh token in the same family (set as the cookie) and supersede
          // the unused successor: only the newest token in the family stays live.
          if (row.familyExpiresAt.getTime() <= Date.now()) return { kind: 'invalid', reason: 'expired', userId: row.userId } as const;
          const user = await findUserById(tx, row.userId);
          if (!user || user.disabled || !user.credential) {
            await revokeFamily(tx, row.familyId);
            return { kind: 'invalid', reason: 'disabled', userId: row.userId } as const;
          }
          await supersedeUnusedTokens(tx, row.familyId);
          const session = await this.issueSession(tx, user, row, client.ip);
          return { kind: 'ok', session, grace: true } as const;
        }
        // A rotated token presented again: someone holds a stolen copy. Revoke the whole family.
        await revokeFamily(tx, row.familyId);
        await insertSubjectSecurityEvent(tx, {
          type: 'REFRESH_TOKEN_REUSE',
          userId: row.userId,
          familyId: row.familyId,
          detail: 'rotated refresh token presented again; token family revoked',
        });
        return { kind: 'invalid', reason: 'reuse', userId: row.userId } as const;
      }
      return { kind: 'invalid', reason: 'expired', userId: row.userId } as const;
    });

    const ua = uaHash(client.userAgent);
    if (result.kind === 'ok') {
      if (result.grace) this.metrics.refresh.grace += 1;
      else this.metrics.refresh.rotated += 1;
      void this.audit({ type: 'REFRESH', userId: result.session.userId, phoneHash: null, ip: client.ip, userAgentHash: ua, reason: result.grace ? 'grace' : null });
      return { kind: 'ok', session: result.session };
    }
    if (result.reason === 'reuse') {
      this.metrics.refresh.reuseDetected += 1;
      console.error('[SECURITY ALARM] refresh token reuse detected; token family revoked');
    } else this.metrics.refresh.failure += 1;
    void this.audit({ type: 'REFRESH_FAILURE', userId: result.userId, phoneHash: null, ip: client.ip, userAgentHash: ua, reason: result.reason });
    return { kind: 'invalid', reason: result.reason };
  }

  /** Revokes the presented token's family. Idempotent; unknown tokens are ignored. */
  async logout(token: string | undefined, client: ClientInfo): Promise<void> {
    if (!token || token.length > 200) return;
    const row = await findRefreshToken(this.db, hashRefreshToken(token), 0);
    if (!row) return;
    await revokeFamily(this.db, row.familyId);
    void this.audit({ type: 'LOGOUT', userId: row.userId, phoneHash: null, ip: client.ip, userAgentHash: uaHash(client.userAgent), reason: null });
  }

  // ── PIN change ───────────────────────────────────────────────────────────

  async changePin(userId: string, currentPin: unknown, newPin: unknown, client: ClientInfo): Promise<PinChangeResult> {
    if (typeof currentPin !== 'string' || currentPin.length === 0) return { kind: 'weak_pin', violation: 'current_pin_missing' };
    const violation = pinPolicyViolation(newPin);
    if (violation) return { kind: 'weak_pin', violation };
    if (newPin === currentPin) return { kind: 'weak_pin', violation: 'pin_unchanged' };

    const user = await findUserById(this.db, userId);
    if (!user || user.disabled) return { kind: 'invalid' };
    const subject = this.subject(user.phoneNumber, client);
    const phoneKey = subject.phoneKey;
    const audit = (type: AuthEvent['type'], reason: string | null) =>
      this.audit({ type, userId, phoneHash: phoneKey, ip: client.ip, userAgentHash: uaHash(client.userAgent), reason });

    let reservation: Reservation;
    try {
      const verdict = await this.throttle.reserve(subject);
      if (!verdict.allowed) {
        void audit('PIN_CHANGE_FAILURE', `throttled_${verdict.reason}`);
        return { kind: 'throttled', retryAfterS: verdict.retryAfterS };
      }
      reservation = verdict.reservation;
    } catch (error) {
      return this.unavailable(error);
    }

    const ok = await verifyPin(currentPin, user.credential).catch(async (error) => {
      await this.release(reservation);
      throw error;
    });
    const expired = user.mustChange && !!user.oneTimeExpiresAt && user.oneTimeExpiresAt.getTime() <= Date.now();
    if (!ok) {
      // A wrong current PIN counts toward the same lockout as a failed login.
      await this.countFailure(reservation, userId);
      void audit('PIN_CHANGE_FAILURE', 'bad_current_pin');
      return { kind: 'invalid' };
    }
    await this.release(reservation);
    if (expired) {
      void audit('PIN_CHANGE_FAILURE', 'one_time_pin_expired');
      return { kind: 'invalid' };
    }

    const cred = await hashPin(newPin as string);
    const session = await withTransaction(this.db, async (tx) => {
      await upsertCredential(tx, userId, cred, { mustChange: false, oneTimeExpiresAt: null });
      // Every existing session ends; the current one continues in a fresh family.
      await revokeAllForUser(tx, userId);
      await insertSubjectSecurityEvent(tx, { type: 'PIN_CHANGED', userId, detail: 'PIN changed; all refresh-token families revoked' });
      return this.issueSession(tx, { ...user, mustChange: false }, null, client.ip);
    });
    void audit('PIN_CHANGED', null);
    return { kind: 'ok', session };
  }

  // ── PIN confirmation (spec gh-11) ────────────────────────────────────────

  /**
   * Confirms a sensitive action with the user's PIN: the same reserve → verify → countFailure /
   * release sequence as changePin, so a wrong PIN counts toward the login lockout. Fails closed
   * (unavailable) when the throttle cannot answer.
   */
  async confirmPin(userId: string, pin: unknown, client: ClientInfo): Promise<PinConfirmResult> {
    // No PIN at all (e.g. a bodiless DELETE) is not a guess: never reserved or counted.
    if (typeof pin !== 'string' || pin.length === 0) return { kind: 'invalid' };
    const user = await findUserById(this.db, userId);
    if (!user || user.disabled) return { kind: 'invalid' };
    const subject = this.subject(user.phoneNumber, client);

    let reservation: Reservation;
    try {
      const verdict = await this.throttle.reserve(subject);
      if (!verdict.allowed) return { kind: 'throttled', retryAfterS: verdict.retryAfterS };
      reservation = verdict.reservation;
    } catch (error) {
      return this.unavailable(error);
    }

    const ok = await verifyPin(typeof pin === 'string' ? pin : '', user.credential).catch(async (error) => {
      await this.release(reservation);
      throw error;
    });
    if (!ok) {
      await this.countFailure(reservation, userId);
      return { kind: 'invalid' };
    }
    await this.release(reservation);
    return { kind: 'ok', phoneNumber: user.phoneNumber };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Inserts a new refresh token and signs an access token. `family` null starts a new family
   * (absolute expiry REFRESH_FAMILY_MAX_DAYS from now); otherwise the family's expiry carries forward.
   */
  private async issueSession(
    db: Db,
    user: UserAuthState,
    family: { familyId: string; familyExpiresAt: Date } | null,
    ip: string | null
  ): Promise<Session> {
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    await insertRefreshToken(db, {
      userId: user.userId,
      familyId: family?.familyId ?? crypto.randomUUID(),
      tokenHash: hashRefreshToken(refreshToken),
      ttlSeconds: REFRESH_TOKEN_TTL_S,
      ip,
      familyExpiresAt: family?.familyExpiresAt ?? null,
      familyMaxSeconds: REFRESH_FAMILY_MAX_S,
    });
    const access = await signAccessToken({ userId: user.userId, role: user.role, pinChangeRequired: user.mustChange });
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken,
      userId: user.userId,
      role: user.role,
      pinChangeRequired: user.mustChange,
    };
  }

  /** Throttle subject: the phone key under the current PII key, plus the previous key (rotation). */
  private subject(phoneIdentity: string, client: ClientInfo): LoginSubject {
    const [phoneKey, ...prevPhoneKeys] = loginPhoneKeys(phoneIdentity);
    return {
      phoneKey,
      prevPhoneKeys,
      ip: client.ip,
      deviceId: verifyDeviceCookie(client.deviceCookie, [phoneKey, ...prevPhoneKeys]),
    };
  }

  /** The reserved attempt was right after all: undo its counts (best effort; logged). */
  private async release(r: Reservation): Promise<void> {
    await this.throttle.release(r).catch((e) => console.warn('[Auth] could not clear login counters:', (e as Error).message));
  }

  /** The reserved attempt was a wrong PIN (already counted at reservation): alarms and the lockout event. */
  private async countFailure(r: Reservation, userId: string | null): Promise<void> {
    const res = await this.throttle.confirmFailure(r).catch((e) => {
      console.warn('[Auth] global failure counter unavailable:', (e as Error).message);
      return { hardLocked: r.setHard, lockedForMs: r.lockMs };
    });
    this.metrics.globalLoginFailureAlarm = this.throttle.globalAlarm;
    if (res.hardLocked) {
      this.metrics.login.hardLocks += 1;
      console.error('[SECURITY ALARM] login hard-locked after the 24 h failure cap; admin unlock required (npm run user:unlock)');
      await insertSubjectSecurityEvent(this.db, {
        type: 'LOGIN_LOCKOUT',
        userId,
        detail: `24 h failure cap reached for phone ${r.subject.phoneKey}; admin unlock required`,
      }).catch((e) => console.error('[Auth] could not persist LOGIN_LOCKOUT:', (e as Error).message));
    }
  }

  private unavailable(error: unknown): { kind: 'unavailable' } {
    if (!(error instanceof ThrottleUnavailableError)) throw error;
    this.metrics.login.unavailable += 1;
    console.error('[Auth] login throttle unavailable (Redis) — refusing logins (fail closed)');
    return { kind: 'unavailable' };
  }

  private async audit(e: AuthEvent): Promise<void> {
    await insertAuthEvent(this.db, e).catch((err) => console.error('[Auth] audit insert failed:', (err as Error).message));
  }
}

/** Keyed hash of the user agent for the audit trail (never stored raw). */
function uaHash(ua: string | undefined): string | null {
  return ua ? keyedHash('auth', `ua:${ua.slice(0, 512)}`) : null;
}
