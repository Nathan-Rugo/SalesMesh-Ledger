/**
 * @file pii.ts
 * @description Keyed hashing for PII (Kenya DPA 2019, thesis NFR-03).
 *
 * Every hash the gateway stores — the raw-payload hash and the counterparty hash — is
 * HMAC-SHA256 under one secret, PII_HMAC_KEY (>= 32 bytes, checked at startup), with domain
 * separation and a key-id prefix ("k1:<hex>"). A plain SHA-256 of a payload that carries an
 * MSISDN would be brute-forceable over the small phone-number space; an HMAC is not.
 *
 * Key encodings: "base64:<...>", "hex:<...>", otherwise the UTF-8 bytes of the value.
 * Rotation: see docs/compliance/pii-hmac-key-rotation.md (PII_HMAC_KEY_PREVIOUS keeps
 * in-flight retries verifiable; counterparty reuse resets across a rotation).
 */

import crypto from 'crypto';

/**
 * Domains keep hashes of the same input unlinkable across uses:
 *  - payload / counterparty: callback tamper-evidence and the payer MSISDN (spec gh-6);
 *  - auth: login throttle keys and audit rows (phone, user agent);
 *  - device: the trusted-device cookie MAC;
 *  - stk_fingerprint: the STK idempotency fingerprint (phone, amount).
 */
export type HashDomain = 'payload' | 'counterparty' | 'auth' | 'device' | 'stk_fingerprint';

interface KeyMaterial {
  id: string;
  key: Buffer;
}

interface Keyring {
  current: KeyMaterial;
  previous: KeyMaterial | null;
}

const MIN_KEY_BYTES = 32;
const KEY_ID_RE = /^k[0-9]{1,6}$/;
/** Shape of every hash this module produces. */
export const KEYED_HASH_RE = /^k[0-9]{1,6}:[0-9a-f]{64}$/;

export class PiiKeyError extends Error {}

function decodeKey(raw: string, name: string): Buffer {
  let key: Buffer;
  if (raw.startsWith('base64:')) key = Buffer.from(raw.slice(7), 'base64');
  else if (raw.startsWith('hex:')) {
    const hex = raw.slice(4);
    if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new PiiKeyError(`${name} is not valid hex`);
    key = Buffer.from(hex, 'hex');
  } else key = Buffer.from(raw, 'utf-8');
  if (key.length < MIN_KEY_BYTES) {
    throw new PiiKeyError(`${name} must be at least ${MIN_KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

function loadKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env.PII_HMAC_KEY;
  if (!raw) throw new PiiKeyError('PII_HMAC_KEY is not set');
  const id = env.PII_HMAC_KEY_ID || 'k1';
  if (!KEY_ID_RE.test(id)) throw new PiiKeyError('PII_HMAC_KEY_ID must look like k1, k2, ...');
  const current = { id, key: decodeKey(raw, 'PII_HMAC_KEY') };

  let previous: KeyMaterial | null = null;
  if (env.PII_HMAC_KEY_PREVIOUS) {
    const prevId = env.PII_HMAC_KEY_PREVIOUS_ID || '';
    if (!KEY_ID_RE.test(prevId) || prevId === id) {
      throw new PiiKeyError('PII_HMAC_KEY_PREVIOUS_ID must be set, look like k1, and differ from PII_HMAC_KEY_ID');
    }
    previous = { id: prevId, key: decodeKey(env.PII_HMAC_KEY_PREVIOUS, 'PII_HMAC_KEY_PREVIOUS') };
  }
  return { current, previous };
}

let cached: Keyring | null = null;
let cachedFrom: string | undefined;

function keyring(): Keyring {
  // Re-read when the env changes (tests); otherwise cached.
  const fingerprint = `${process.env.PII_HMAC_KEY}|${process.env.PII_HMAC_KEY_ID}|${process.env.PII_HMAC_KEY_PREVIOUS}|${process.env.PII_HMAC_KEY_PREVIOUS_ID}`;
  if (!cached || cachedFrom !== fingerprint) {
    cached = loadKeyring();
    cachedFrom = fingerprint;
  }
  return cached;
}

/** Throws PiiKeyError when the key is missing or too short. Called at startup. */
export function assertPiiKey(env: NodeJS.ProcessEnv = process.env): void {
  if (env === process.env) keyring();
  else loadKeyring(env);
}

function hmacWith(material: KeyMaterial, domain: HashDomain, data: Buffer | string): string {
  const mac = crypto.createHmac('sha256', material.key);
  mac.update(`salesmesh/${domain}/v1`);
  mac.update(Buffer.from([0]));
  mac.update(data);
  return `${material.id}:${mac.digest('hex')}`;
}

/** Keyed, domain-separated hash under the current key: "k1:<64 hex>". */
export function keyedHash(domain: HashDomain, data: Buffer | string): string {
  return hmacWith(keyring().current, domain, data);
}

/**
 * The same keyed hash under every *other* configured key (the previous key, during a rotation).
 * Lets a hash made before a rotation be matched to one made after it, by plain equality.
 */
export function alternateKeyedHashes(domain: HashDomain, data: Buffer | string): string[] {
  const ring = keyring();
  return ring.previous ? [hmacWith(ring.previous, domain, data)] : [];
}

/**
 * True when `stored` is the keyed hash of `data`, under whichever configured key produced it.
 * Returns null when `stored` was made with a key that is no longer configured (cannot tell).
 */
export function keyedHashMatches(stored: string, domain: HashDomain, data: Buffer | string): boolean | null {
  const ring = keyring();
  const colon = stored.indexOf(':');
  if (colon <= 0) return null; // legacy, unprefixed hash: key unknown
  const id = stored.slice(0, colon);
  const material = id === ring.current.id ? ring.current : ring.previous?.id === id ? ring.previous : null;
  if (!material) return null;
  const expected = Buffer.from(hmacWith(material, domain, data));
  const given = Buffer.from(stored);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
