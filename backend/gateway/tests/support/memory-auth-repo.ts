/**
 * In-memory stand-in for src/repositories/auth.repository (unit tests), with the same exported
 * signatures. JS is single-threaded, so claimRotation is atomic here as the SQL UPDATE is in Postgres.
 */

import type { StoredCredential } from '../../src/auth/credentials';
import type { AuthEvent, RefreshTokenRow, UserAuthState } from '../../src/repositories/auth.repository';

interface MemUser {
  userId: string;
  role: 'MERCHANT_ADMIN' | 'SALES_AGENT';
  phoneNumber: string;
  disabled: boolean;
  credential: StoredCredential | null;
  mustChange: boolean;
  oneTimeExpiresAt: Date | null;
}

interface MemToken {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: number;
  familyExpiresAt: number;
  createdSeq: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  ip: string | null;
}

export const memAuth = {
  users: new Map<string, MemUser>(),
  tokens: [] as MemToken[],
  events: [] as AuthEvent[],
  reset() {
    this.users.clear();
    this.tokens.length = 0;
    this.events.length = 0;
  },
};

const state = (u: MemUser): UserAuthState => ({ ...u });
let seq = 0;

export async function findUserByPhone(_db: unknown, phone: string): Promise<UserAuthState | null> {
  const u = [...memAuth.users.values()].find((x) => x.phoneNumber === phone);
  return u ? state(u) : null;
}

export async function findUserById(_db: unknown, userId: string): Promise<UserAuthState | null> {
  const u = memAuth.users.get(userId);
  return u ? state(u) : null;
}

export async function upsertCredential(
  _db: unknown,
  userId: string,
  cred: StoredCredential,
  opts: { mustChange: boolean; oneTimeExpiresAt: Date | null }
): Promise<void> {
  const u = memAuth.users.get(userId)!;
  u.credential = cred;
  u.mustChange = opts.mustChange;
  u.oneTimeExpiresAt = opts.oneTimeExpiresAt;
}

export async function insertRefreshToken(
  _db: unknown,
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
  const fx = t.familyExpiresAt ? t.familyExpiresAt.getTime() : Date.now() + t.familyMaxSeconds * 1000;
  memAuth.tokens.push({
    id: `t${++seq}`,
    userId: t.userId,
    familyId: t.familyId,
    tokenHash: t.tokenHash,
    expiresAt: Math.min(Date.now() + t.ttlSeconds * 1000, fx),
    familyExpiresAt: fx,
    createdSeq: seq,
    rotatedAt: null,
    revokedAt: null,
    ip: t.ip,
  });
}

export async function claimRotation(
  _db: unknown,
  tokenHash: string
): Promise<{ userId: string; familyId: string; familyExpiresAt: Date } | null> {
  const now = Date.now();
  const t = memAuth.tokens.find(
    (x) => x.tokenHash === tokenHash && x.rotatedAt === null && x.revokedAt === null && x.expiresAt > now && x.familyExpiresAt > now
  );
  if (!t) return null;
  t.rotatedAt = now;
  return { userId: t.userId, familyId: t.familyId, familyExpiresAt: new Date(t.familyExpiresAt) };
}

export async function findRefreshToken(_db: unknown, tokenHash: string, graceSeconds: number): Promise<RefreshTokenRow | null> {
  const t = memAuth.tokens.find((x) => x.tokenHash === tokenHash);
  if (!t) return null;
  return {
    id: t.id,
    userId: t.userId,
    familyId: t.familyId,
    expiresAt: new Date(t.expiresAt),
    rotatedAt: t.rotatedAt === null ? null : new Date(t.rotatedAt),
    revokedAt: t.revokedAt === null ? null : new Date(t.revokedAt),
    familyExpiresAt: new Date(t.familyExpiresAt),
    recentlyRotated: t.rotatedAt !== null && t.rotatedAt > Date.now() - graceSeconds * 1000,
    // The family's newest token is revoked (not merely superseded).
    familyRevoked:
      memAuth.tokens.filter((x) => x.familyId === t.familyId).sort((a, b) => b.createdSeq - a.createdSeq)[0]?.revokedAt !== null,
  };
}

export async function revokeFamily(_db: unknown, familyId: string): Promise<number> {
  let n = 0;
  for (const t of memAuth.tokens) if (t.familyId === familyId && t.revokedAt === null) {
      t.revokedAt = Date.now();
      n++;
    }
  return n;
}

export async function supersedeUnusedTokens(_db: unknown, familyId: string): Promise<number> {
  let n = 0;
  for (const t of memAuth.tokens) if (t.familyId === familyId && t.rotatedAt === null && t.revokedAt === null) {
      t.revokedAt = Date.now();
      n++;
    }
  return n;
}

export async function purgeAuthData(): Promise<{ tokens: number; events: number }> {
  return { tokens: 0, events: 0 };
}

export async function revokeAllForUser(_db: unknown, userId: string): Promise<number> {
  let n = 0;
  for (const t of memAuth.tokens) if (t.userId === userId && t.revokedAt === null) {
      t.revokedAt = Date.now();
      n++;
    }
  return n;
}

export async function insertAuthEvent(_db: unknown, e: AuthEvent): Promise<void> {
  memAuth.events.push(e);
}
