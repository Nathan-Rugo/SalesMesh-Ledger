/**
 * @file tokens.ts
 * @description RS256 access tokens (spec gh-5, thesis §3): 15 minutes, carrying `user_id` and
 * `role`, verified without a database round trip.
 *
 * Verification pins `alg: RS256`, requires `typ: at+jwt`, `sub`, `jti`, `iat`, `nbf`, `exp`, checks
 * `iss` / `aud` with at most 30 s clock tolerance, and resolves the key only by `kid` from the
 * local key ring (`jku` / `jwk` / `x5u` are never followed). Any failure is an AuthTokenError
 * (→ 401), never a 500.
 */

import crypto from 'crypto';
import { jwtVerify, SignJWT, type JWTHeaderParameters } from 'jose';
import { ACCESS_TOKEN_TTL_S, CLOCK_TOLERANCE_S, jwtKeyring } from '../config/jwt';

export const ROLES = ['MERCHANT_ADMIN', 'SALES_AGENT'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export interface AccessClaims {
  userId: string;
  role: Role;
  jti: string;
  /** Set while a one-time PIN must be changed: only POST /api/v1/auth/pin accepts the token. */
  pinChangeRequired: boolean;
  exp: number;
}

export class AuthTokenError extends Error {}

const TYP = 'at+jwt';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function signAccessToken(
  subject: { userId: string; role: Role; pinChangeRequired: boolean },
  now: Date = new Date()
): Promise<{ token: string; expiresIn: number }> {
  const ring = jwtKeyring();
  const iat = Math.floor(now.getTime() / 1000);
  const claims: Record<string, unknown> = { user_id: subject.userId, role: subject.role };
  if (subject.pinChangeRequired) claims.pin_change_required = true;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', typ: TYP, kid: ring.current.kid })
    .setIssuer(ring.issuer)
    .setAudience(ring.audience)
    .setSubject(subject.userId)
    .setJti(crypto.randomUUID())
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_S)
    .sign(ring.current.privateKey);
  return { token, expiresIn: ACCESS_TOKEN_TTL_S };
}

export async function verifyAccessToken(token: string, now: Date = new Date()): Promise<AccessClaims> {
  const ring = jwtKeyring();
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(
      token,
      (header: JWTHeaderParameters) => {
        // Only the local ring: a kid we do not hold (or none) is refused.
        const key = typeof header.kid === 'string' ? ring.verify.get(header.kid) : undefined;
        if (!key) throw new AuthTokenError('unknown kid');
        return key;
      },
      {
        algorithms: ['RS256'],
        typ: TYP,
        issuer: ring.issuer,
        audience: ring.audience,
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['sub', 'jti', 'iat', 'nbf', 'exp'],
        currentDate: now,
      }
    ));
  } catch (error) {
    throw new AuthTokenError(error instanceof AuthTokenError ? error.message : 'invalid token');
  }
  const { sub, user_id: userId, role, jti, exp } = payload;
  if (typeof sub !== 'string' || !UUID_RE.test(sub) || userId !== sub) throw new AuthTokenError('invalid subject');
  if (!isRole(role)) throw new AuthTokenError('invalid role');
  if (typeof jti !== 'string' || !jti) throw new AuthTokenError('invalid jti');
  return { userId: sub, role, jti, pinChangeRequired: payload.pin_change_required === true, exp: Number(exp) };
}
