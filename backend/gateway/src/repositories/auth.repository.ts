/**
 * @file auth.repository.ts
 * @description SQL for users, PIN credentials, rotating refresh tokens and the auth audit trail
 * (spec gh-5). Refresh tokens are stored only as their SHA-256; PINs only as scrypt hashes.
 */

import type { StoredCredential } from '../auth/credentials';
import type { Role } from '../auth/tokens';
import type { QueryResultRow } from 'pg';
import type { Db } from './db.types';

export interface UserAuthState {
  userId: string;
  role: Role;
  phoneNumber: string;
  disabled: boolean;
  credential: StoredCredential | null;
  mustChange: boolean;
  /** One-time PIN expiry (only meaningful while mustChange). */
  oneTimeExpiresAt: Date | null;
}

const USER_SELECT = `
  SELECT u.user_id, u.role, u.phone_number, u.disabled_at IS NOT NULL AS disabled,
         c.algorithm, c.params, c.salt, c.hash, COALESCE(c.must_change, FALSE) AS must_change, c.one_time_expires_at
    FROM users u LEFT JOIN user_credentials c ON c.user_id = u.user_id`;

function toState(r: QueryResultRow): UserAuthState {
  return {
    userId: r.user_id,
    role: r.role,
    phoneNumber: r.phone_number,
    disabled: r.disabled === true,
    credential: r.algorithm ? { algorithm: r.algorithm, params: r.params, salt: r.salt, hash: r.hash } : null,
    mustChange: r.must_change === true,
    oneTimeExpiresAt: r.one_time_expires_at ? new Date(r.one_time_expires_at) : null,
  };
}

export async function findUserByPhone(db: Db, phone: string): Promise<UserAuthState | null> {
  const { rows } = await db.query(`${USER_SELECT} WHERE u.phone_number = $1`, [phone]);
  return rows[0] ? toState(rows[0]) : null;
}

export async function findUserById(db: Db, userId: string): Promise<UserAuthState | null> {
  const { rows } = await db.query(`${USER_SELECT} WHERE u.user_id = $1`, [userId]);
  return rows[0] ? toState(rows[0]) : null;
}

/** Inserts or replaces a user's credential. */
export async function upsertCredential(
  db: Db,
  userId: string,
  cred: StoredCredential,
  opts: { mustChange: boolean; oneTimeExpiresAt: Date | null }
): Promise<void> {
  await db.query(
    `INSERT INTO user_credentials (user_id, algorithm, params, salt, hash, must_change, one_time_expires_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE
        SET algorithm = EXCLUDED.algorithm, params = EXCLUDED.params, salt = EXCLUDED.salt, hash = EXCLUDED.hash,
            must_change = EXCLUDED.must_change, one_time_expires_at = EXCLUDED.one_time_expires_at, updated_at = NOW()`,
    [userId, cred.algorithm, JSON.stringify(cred.params), cred.salt, cred.hash, opts.mustChange, opts.oneTimeExpiresAt]
  );
}

// ── Refresh tokens ──────────────────────────────────────────────────────────

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  /** The family's absolute end (REFRESH_FAMILY_MAX_DAYS after login), carried on every token. */
  familyExpiresAt: Date;
  /** Rotated within the concurrency grace window. */
  recentlyRotated: boolean;
  /** The family's newest token is revoked (logout / reuse / PIN change), not merely superseded. */
  familyRevoked: boolean;
}

/**
 * Inserts a refresh token. A new family gets `familyExpiresAt` = NOW() + familyMaxSeconds; a
 * rotation carries the family's expiry forward. A token never outlives its family.
 */
export async function insertRefreshToken(
  db: Db,
  t: {
    userId: string;
    familyId: string;
    tokenHash: string;
    ttlSeconds: number;
    ip: string | null;
    familyExpiresAt: Date | null;
    familyMaxSeconds: number;
  }
): Promise<void> {
  await db.query(
    // The family's expiry is carried forward exactly from its existing rows (microsecond precision);
    // a new family starts its absolute lifetime now. (`familyExpiresAt` is informational here.)
    `WITH f AS (
       SELECT COALESCE((SELECT min(family_expires_at) FROM refresh_tokens WHERE family_id = $2),
                       NOW() + make_interval(secs => $6::double precision)) AS fx)
     INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, family_expires_at, created_ip, created_at)
     SELECT $1, $2, $3, LEAST(NOW() + make_interval(secs => $4::double precision), f.fx), f.fx, $5, clock_timestamp() FROM f`,
    // created_at = clock_timestamp(): insertion order (not transaction start), which the
    // "newest token in the family" check relies on when grace refreshes queue on the family lock.
    [t.userId, t.familyId, t.tokenHash, t.ttlSeconds, t.ip?.slice(0, 64) ?? null, t.familyMaxSeconds]
  );
}

/**
 * Atomic rotation: marks the token rotated only if it is live (not rotated, not revoked, not
 * expired). Exactly one concurrent caller wins; the others see no row.
 */
export async function claimRotation(
  db: Db,
  tokenHash: string
): Promise<{ userId: string; familyId: string; familyExpiresAt: Date } | null> {
  const { rows } = await db.query<{ user_id: string; family_id: string; family_expires_at: Date }>(
    `UPDATE refresh_tokens SET rotated_at = NOW()
      WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL
        AND expires_at > NOW() AND family_expires_at > NOW()
      RETURNING user_id, family_id, family_expires_at`,
    [tokenHash]
  );
  const r = rows[0];
  return r ? { userId: r.user_id, familyId: r.family_id, familyExpiresAt: new Date(r.family_expires_at) } : null;
}

export async function findRefreshToken(db: Db, tokenHash: string, graceSeconds: number): Promise<RefreshTokenRow | null> {
  const { rows } = await db.query(
    `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at, t.family_expires_at,
            (t.rotated_at IS NOT NULL AND t.rotated_at > NOW() - make_interval(secs => $2::double precision)) AS recent,
            COALESCE((SELECT f.revoked_at IS NOT NULL FROM refresh_tokens f WHERE f.family_id = t.family_id
                       ORDER BY f.created_at DESC, f.id DESC LIMIT 1), FALSE) AS family_revoked
       FROM refresh_tokens t WHERE t.token_hash = $1`,
    [tokenHash, graceSeconds]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    familyId: r.family_id,
    expiresAt: new Date(r.expires_at),
    rotatedAt: r.rotated_at ? new Date(r.rotated_at) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    familyExpiresAt: new Date(r.family_expires_at),
    recentlyRotated: r.recent === true,
    familyRevoked: r.family_revoked === true,
  };
}

export async function revokeFamily(db: Db, familyId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId]
  );
  return rowCount ?? 0;
}

/**
 * Grace refresh: the family's not-yet-used successor (issued to a response the client never
 * received) is superseded, so only the newest token in the family stays live.
 */
export async function supersedeUnusedTokens(db: Db, familyId: string): Promise<number> {
  // Serialise concurrent grace refreshes of one family (inside the caller's transaction), so the
  // next statement sees every token a concurrent grace refresh just issued.
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('rtfam:' || $1, 0))`, [familyId]);
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND rotated_at IS NULL AND revoked_at IS NULL`,
    [familyId]
  );
  return rowCount ?? 0;
}

/**
 * Retention (worker housekeeping): refresh tokens expired or revoked more than `tokenDays` ago,
 * and auth_events (raw IPs) older than `eventDays`.
 */
export async function purgeAuthData(db: Db, tokenDays: number, eventDays: number): Promise<{ tokens: number; events: number }> {
  const t = await db.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < NOW() - make_interval(days => $1::int)
         OR revoked_at < NOW() - make_interval(days => $1::int)`,
    [tokenDays]
  );
  const e = await db.query(`DELETE FROM auth_events WHERE occurred_at < NOW() - make_interval(days => $1::int)`, [eventDays]);
  return { tokens: t.rowCount ?? 0, events: e.rowCount ?? 0 };
}

export async function revokeAllForUser(db: Db, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return rowCount ?? 0;
}

// ── Audit ───────────────────────────────────────────────────────────────────

export type AuthEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGIN_THROTTLED'
  | 'REFRESH'
  | 'REFRESH_FAILURE'
  | 'LOGOUT'
  | 'PIN_CHANGED'
  | 'PIN_CHANGE_FAILURE';

export interface AuthEvent {
  type: AuthEventType;
  userId: string | null;
  phoneHash: string | null;
  ip: string | null;
  userAgentHash: string | null;
  reason: string | null;
}

export async function insertAuthEvent(db: Db, e: AuthEvent): Promise<void> {
  await db.query(
    `INSERT INTO auth_events (event_type, user_id, phone_hash, ip, user_agent_hash, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.type, e.userId, e.phoneHash, e.ip?.slice(0, 64) ?? null, e.userAgentHash, e.reason?.slice(0, 60) ?? null]
  );
}
