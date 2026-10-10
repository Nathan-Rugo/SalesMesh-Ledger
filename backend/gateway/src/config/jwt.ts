/**
 * @file jwt.ts
 * @description RS256 key ring for access tokens (spec gh-5; same keyring pattern as pii.ts).
 *
 *  - Current signing key: JWT_PRIVATE_KEY (PEM) or JWT_PRIVATE_KEY_FILE (path), id JWT_KEY_ID.
 *  - Previous verification key (rotation): JWT_PREVIOUS_PUBLIC_KEY or JWT_PREVIOUS_PUBLIC_KEY_FILE,
 *    id JWT_PREVIOUS_KEY_ID. Tokens signed with it stay valid until they expire (15 min).
 *  - RSA only, at least 2048 bits, checked at startup. There is no symmetric fallback.
 *
 * A token's `kid` is looked up only in this local ring; `jku` / `jwk` / `x5u` headers are never
 * followed. Generate a dev key pair with `npm run keys:generate`.
 */

import crypto, { KeyObject } from 'crypto';
import fs from 'fs';

export const MIN_RSA_BITS = 2048;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class JwtKeyError extends Error {}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface JwtKeyring {
  current: SigningKey;
  /** Verification-only keys by kid (current included). */
  verify: Map<string, KeyObject>;
  issuer: string;
  audience: string;
}

/** PEM from an env value (literal "\n" allowed, for single-line .env files) or from a file. */
function readPem(env: NodeJS.ProcessEnv, name: string): string | null {
  const inline = env[name];
  if (inline && inline.trim()) return inline.replace(/\\n/g, '\n');
  const file = env[`${name}_FILE`];
  if (file && file.trim()) {
    try {
      return fs.readFileSync(file.trim(), 'utf-8');
    } catch (error) {
      throw new JwtKeyError(`${name}_FILE cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  return null;
}

function assertRsa(key: KeyObject, name: string): void {
  if (key.asymmetricKeyType !== 'rsa') throw new JwtKeyError(`${name} must be an RSA key (RS256)`);
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) throw new JwtKeyError(`${name} must be at least ${MIN_RSA_BITS} bits (got ${bits})`);
}

export function loadJwtKeyring(env: NodeJS.ProcessEnv = process.env): JwtKeyring {
  const pem = readPem(env, 'JWT_PRIVATE_KEY');
  if (!pem) throw new JwtKeyError('JWT_PRIVATE_KEY (or JWT_PRIVATE_KEY_FILE) is not set');
  let privateKey: KeyObject;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    throw new JwtKeyError('JWT_PRIVATE_KEY is not a valid PEM private key');
  }
  assertRsa(privateKey, 'JWT_PRIVATE_KEY');
  const kid = env.JWT_KEY_ID?.trim() ?? '';
  if (!KID_RE.test(kid)) throw new JwtKeyError('JWT_KEY_ID must be set (1-64 of A-Z a-z 0-9 . _ -)');
  const current = { kid, privateKey, publicKey: crypto.createPublicKey(privateKey) };
  const verify = new Map<string, KeyObject>([[kid, current.publicKey]]);

  const prevPem = readPem(env, 'JWT_PREVIOUS_PUBLIC_KEY');
  if (prevPem) {
    const prevKid = env.JWT_PREVIOUS_KEY_ID?.trim() ?? '';
    if (!KID_RE.test(prevKid) || prevKid === kid) {
      throw new JwtKeyError('JWT_PREVIOUS_KEY_ID must be set and differ from JWT_KEY_ID');
    }
    let prev: KeyObject;
    try {
      prev = crypto.createPublicKey(prevPem);
    } catch {
      throw new JwtKeyError('JWT_PREVIOUS_PUBLIC_KEY is not a valid PEM key');
    }
    assertRsa(prev, 'JWT_PREVIOUS_PUBLIC_KEY');
    verify.set(prevKid, prev);
  }

  return {
    current,
    verify,
    issuer: env.JWT_ISSUER?.trim() || 'salesmesh-gateway',
    audience: env.JWT_AUDIENCE?.trim() || 'salesmesh-api',
  };
}

let cached: JwtKeyring | null = null;
let cachedFrom: string | undefined;

/** The configured key ring; re-read when the env changes (tests), otherwise cached. */
export function jwtKeyring(): JwtKeyring {
  const e = process.env;
  const fingerprint = [
    e.JWT_PRIVATE_KEY, e.JWT_PRIVATE_KEY_FILE, e.JWT_KEY_ID, e.JWT_PREVIOUS_PUBLIC_KEY,
    e.JWT_PREVIOUS_PUBLIC_KEY_FILE, e.JWT_PREVIOUS_KEY_ID, e.JWT_ISSUER, e.JWT_AUDIENCE,
  ].join('|');
  if (!cached || cachedFrom !== fingerprint) {
    cached = loadJwtKeyring();
    cachedFrom = fingerprint;
  }
  return cached;
}

/** Throws JwtKeyError when the keys are missing, not RSA, or under 2048 bits. Called at startup. */
export function assertJwtKeys(): void {
  jwtKeyring();
}

const posInt = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Access tokens live at most 15 minutes (thesis; shorter is allowed); refresh tokens 7 days. */
export const ACCESS_TOKEN_TTL_S = Math.min(posInt(process.env.JWT_ACCESS_TTL_SECONDS, 15 * 60), 15 * 60);
export const REFRESH_TOKEN_TTL_S = posInt(process.env.REFRESH_TOKEN_TTL_SECONDS, 7 * 24 * 3600);
/** A refresh-token family ends this long after login, however often it is rotated (default 30 days). */
export const REFRESH_FAMILY_MAX_S = posInt(process.env.REFRESH_FAMILY_MAX_DAYS, 30) * 24 * 3600;
/** Allowed clock skew when checking exp / nbf / iat (at most 30 s). */
export const CLOCK_TOLERANCE_S = Math.min(posInt(process.env.JWT_CLOCK_TOLERANCE_SECONDS, 30), 30);
