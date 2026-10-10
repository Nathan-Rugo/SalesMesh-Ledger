/**
 * @file credentials.ts
 * @description PIN credentials (spec gh-5): numeric PIN of 4–6 digits, M-Pesa style.
 *
 * Hashed with Node's built-in scrypt, a per-user 16-byte salt and versioned parameters stored
 * with the hash (so the cost can be raised later without invalidating old hashes). Compared in
 * constant time. An unknown user is verified against a dummy hash so a failed login takes about
 * as long whether or not the user exists. A 4–6 digit space is small: safety rests on the login
 * lockout and throttling (throttle.ts), and weak PINs are refused outright.
 */

import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

export interface ScryptParams {
  v: 1;
  logN: number;
  r: number;
  p: number;
  keylen: number;
}

export interface StoredCredential {
  algorithm: 'scrypt';
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

const SALT_BYTES = 16;

/** scrypt cost (log2 N). 15 → 32 MiB, tens of ms. Tests may go lower; production never below 14. */
export function currentParams(env: NodeJS.ProcessEnv = process.env): ScryptParams {
  const floor = env.NODE_ENV === 'test' ? 10 : 14;
  const n = parseInt(env.AUTH_SCRYPT_LOG_N ?? '', 10);
  const logN = Number.isFinite(n) ? Math.min(Math.max(n, floor), 20) : 15;
  return { v: 1, logN, r: 8, p: 1, keylen: 32 };
}

function scryptOptions(params: ScryptParams): crypto.ScryptOptions {
  const N = 2 ** params.logN;
  return { N, r: params.r, p: params.p, maxmem: 256 * N * params.r * params.p };
}

function validParams(p: unknown): p is ScryptParams {
  const x = p as ScryptParams;
  return (
    !!x && x.v === 1 && Number.isInteger(x.logN) && x.logN >= 10 && x.logN <= 20 &&
    Number.isInteger(x.r) && x.r >= 1 && x.r <= 32 && Number.isInteger(x.p) && x.p >= 1 && x.p <= 16 &&
    Number.isInteger(x.keylen) && x.keylen >= 16 && x.keylen <= 64
  );
}

export async function hashPin(pin: string, params: ScryptParams = currentParams()): Promise<StoredCredential> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(pin.normalize('NFKC'), salt, params.keylen, scryptOptions(params));
  return { algorithm: 'scrypt', params, salt, hash };
}

let dummy: Promise<StoredCredential> | null = null;
/** A throwaway credential at the current cost, verified against when the user does not exist. */
function dummyCredential(): Promise<StoredCredential> {
  dummy ??= hashPin(crypto.randomBytes(8).toString('hex'));
  return dummy;
}

/**
 * Constant-time PIN check. `stored` null (unknown user) still costs one scrypt run against a
 * dummy hash and always returns false.
 */
export async function verifyPin(pin: string, stored: StoredCredential | null): Promise<boolean> {
  const target = stored && stored.algorithm === 'scrypt' && validParams(stored.params) ? stored : null;
  const cred = target ?? (await dummyCredential());
  const candidate = await scryptAsync(String(pin).normalize('NFKC'), cred.salt, cred.params.keylen, scryptOptions(cred.params));
  const equal = candidate.length === cred.hash.length && crypto.timingSafeEqual(candidate, cred.hash);
  return target !== null && equal;
}

// ── PIN policy ──────────────────────────────────────────────────────────────

/** Common PINs that are neither repeated digits nor straight runs (those are refused by rule). */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '1212', '1122', '1313', '1010', '2000', '2001', '2020', '2580', '0852', '1004', '6969', '4545',
  '1357', '2468', '1984', '1990', '0007', '5683', '1478', '3690', '1236', '1100',
  '121212', '112233', '123123', '123321', '159753', '147258', '258369', '520520', '696969',
  '111222', '100100', '131313', '101010', '007007', '202020', '147369', '789456', '456789',
]);

export type PinViolation = 'pin_format' | 'pin_repeated' | 'pin_sequence' | 'pin_common';

/** Why a PIN is refused, or null when acceptable: 4–6 digits, not all the same, not a run, not common. */
export function pinPolicyViolation(pin: unknown): PinViolation | null {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) return 'pin_format';
  if (/^(\d)\1+$/.test(pin)) return 'pin_repeated';
  const d = [...pin].map(Number);
  const run = (step: number) => d.every((x, i) => i === 0 || x === d[i - 1] + step);
  if (run(1) || run(-1)) return 'pin_sequence';
  if (COMMON_PINS.has(pin)) return 'pin_common';
  return null;
}

/** A random 6-digit one-time PIN that passes the policy (printed once by the user:create CLI). */
export function generateOneTimePin(): string {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (pinPolicyViolation(pin) === null) return pin;
  }
}

/** One-time PINs expire after this long (72 h). */
export const ONE_TIME_PIN_TTL_MS = 72 * 3600 * 1000;
