/**
 * @file callback.ts
 * @description Pure Daraja callback logic: hot-path validation, PII redaction, and the parser
 * that turns a stored (redacted) intake payload into what the settlement worker needs.
 *
 * Daraja sends numbers and strings interchangeably (Amount 1500.0 vs TransAmount "500.00",
 * TransactionDate 20191219102115 vs TransTime "20191122063845"), so every field is coerced
 * with String() and amounts are handled in integer cents.
 */

import { alternateKeyedHashes, keyedHash, keyedHashMatches, KEYED_HASH_RE } from '../config/pii';

export type SourceChannel = 'DARAJA_STK' | 'C2B';

/** M-Pesa receipt numbers are short upper-case alphanumerics (e.g. NLJ7RT61SV). */
export const RECEIPT_RE = /^[A-Z0-9]{8,20}$/;

/** Daraja timestamps are East Africa Time (UTC+3, no DST). */
const EAT_OFFSET_HOURS = 3;
/** DECIMAL(12,2): at most 10 integer digits. */
const AMOUNT_RE = /^(\d{1,10})(?:\.(\d{1,2})0*)?$/;
const MASKED_VALUE = '[masked]';
const REDACTED_VALUE = '[redacted]';

export class CallbackParseError extends Error {}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

/** Log-safe description of a payload: structure only, never values (Kenya DPA 2019). */
export function payloadShape(body: unknown): string {
  return body && typeof body === 'object'
    ? `keys=[${Object.keys(body).slice(0, 10).join(',')}]`
    : typeof body;
}

/** Positive amount in integer cents, or null. */
export function toCents(value: unknown): number | null {
  const m = AMOUNT_RE.exec(str(value));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

export const centsToAmount = (cents: number): number => cents / 100;
export const centsToDecimal = (cents: number): string =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** Daraja `yyyyMMddHHmmss` (EAT) → UTC Date, or null when unparseable. */
export function parseDarajaTime(value: unknown): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(str(value));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject rollovers such as 31 February.
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d) return null;
  return new Date(local.getTime() - EAT_OFFSET_HOURS * 3_600_000);
}

/** Date → Daraja `yyyyMMddHHmmss` in EAT (STK Push Timestamp / Password). */
export function formatDarajaTime(date: Date): string {
  const eat = new Date(date.getTime() + EAT_OFFSET_HOURS * 3_600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    p(eat.getUTCFullYear(), 4) + p(eat.getUTCMonth() + 1) + p(eat.getUTCDate()) +
    p(eat.getUTCHours()) + p(eat.getUTCMinutes()) + p(eat.getUTCSeconds())
  );
}

/** Daraja time may run ahead of our clock by at most this much before it is distrusted. */
export const MAX_PAYMENT_TIME_SKEW_MS = 5 * 60_000;

/**
 * The payment time used for scoring: Daraja's, unless missing or more than 5 minutes after we
 * received the callback (clock skew or forgery would shift the history window) — then received_at.
 */
export function effectivePaymentTime(paymentTime: Date | null, receivedAt: Date): Date {
  if (!paymentTime || paymentTime.getTime() - receivedAt.getTime() > MAX_PAYMENT_TIME_SKEW_MS) return receivedAt;
  return paymentTime;
}

/** C2B account number → agent code: trimmed, upper-case; null when empty or too long. */
export function normaliseAgentCode(value: unknown): string | null {
  const code = str(value).toUpperCase();
  return code.length > 0 && code.length <= 32 ? code : null;
}

// ── Hot-path validation ───────────────────────────────────────────────────

export type Ingress =
  | { kind: 'ok'; receipt: string; amountCents: number; channel: SourceChannel }
  | { kind: 'drop'; reason: string; stkFailure?: StkFailure };

/** A completed-but-unsuccessful STK push (ResultCode != 0: 1032 cancelled, 1037 timeout, ...). */
export interface StkFailure {
  checkoutRequestId: string;
  resultCode: string;
  resultDesc: string;
}

function stkItems(stk: any): Array<{ Name?: unknown; Value?: unknown }> {
  const items = stk?.CallbackMetadata?.Item;
  return Array.isArray(items) ? items : [];
}

const itemValue = (items: Array<{ Name?: unknown; Value?: unknown }>, name: string): unknown =>
  items.find((i) => i && str(i.Name) === name)?.Value;

/** Extracts and validates receipt + amount from a raw Daraja body (STK callback or C2B confirmation). */
export function extractIngress(body: any): Ingress {
  let receipt: string;
  let rawAmount: unknown;
  let channel: SourceChannel;

  if (body?.Body?.stkCallback) {
    const stk = body.Body.stkCallback;
    if (str(stk.ResultCode) !== '0') {
      const resultCode = str(stk.ResultCode);
      const checkoutRequestId = str(stk.CheckoutRequestID);
      return {
        kind: 'drop',
        reason: `stk_result_${resultCode || 'missing'}`,
        stkFailure:
          resultCode && checkoutRequestId && checkoutRequestId.length <= 100
            ? { checkoutRequestId, resultCode: resultCode.slice(0, 20), resultDesc: str(stk.ResultDesc).slice(0, 200) }
            : undefined,
      };
    }
    const items = stkItems(stk);
    receipt = str(itemValue(items, 'MpesaReceiptNumber'));
    rawAmount = itemValue(items, 'Amount');
    channel = 'DARAJA_STK';
  } else if (body && typeof body === 'object' && 'TransID' in body) {
    receipt = str(body.TransID);
    rawAmount = body.TransAmount;
    channel = 'C2B';
  } else {
    return { kind: 'drop', reason: 'unrecognised' };
  }

  const amountCents = toCents(rawAmount);
  if (!RECEIPT_RE.test(receipt) || amountCents === null) return { kind: 'drop', reason: 'invalid_receipt_or_amount' };
  return { kind: 'ok', receipt, amountCents, channel };
}

// ── Counterparty & redaction ──────────────────────────────────────────────

/**
 * A Kenyan mobile number in Daraja's format (2547XXXXXXXX / 2541XXXXXXXX), or null.
 * Accepts 07.. / 01.., 7.. / 1.., 2547.. / 2541.., with or without "+", spaces, dashes.
 */
export function normaliseKenyanMsisdn(raw: unknown): string | null {
  const digits = str(raw).replace(/[\s+()-]/g, '');
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  return null;
}

/** Counterparty HMAC of an already-normalised MSISDN (same value msisdnHash produces). */
export const normalisedMsisdnHash = (msisdn: string): string => keyedHash('counterparty', `msisdn:${msisdn}`);

/** True when `stored` is the counterparty HMAC of `msisdn` under any configured key (rotation-safe). */
export const msisdnHashMatches = (stored: string, msisdn: string): boolean =>
  keyedHashMatches(stored, 'counterparty', `msisdn:${msisdn}`) === true;

/**
 * Keyed hash of a raw MSISDN-like value, or null when absent/masked.
 *  - masked values ("2547***149") are treated as absent;
 *  - a provider-hashed MSISDN (hex digest) is HMAC'd as-is;
 *  - phone numbers are normalised to 2547XXXXXXXX / 2541XXXXXXXX first.
 */
export function msisdnHash(raw: unknown): string | null {
  const input = msisdnHashInput(raw);
  return input === null ? null : keyedHash('counterparty', input);
}

/** The string msisdnHash() MACs, or null when absent/masked/not a phone. */
function msisdnHashInput(raw: unknown): string | null {
  const value = str(raw);
  // Masked ("2547*****149", "2547XXXXX149") falls through to null below; "*" is decisive.
  if (!value || /[*•]/.test(value)) return null;
  if (/^[0-9a-fA-F]{32,128}$/.test(value) && /[a-fA-F]/.test(value)) return `provider:${value.toLowerCase()}`;
  const digits = value.replace(/[\s+()-]/g, '');
  if (!/^\d{9,15}$/.test(digits)) return null;
  let normalised = digits;
  if (/^0[17]\d{8}$/.test(digits)) normalised = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) normalised = `254${digits}`;
  return `msisdn:${normalised}`;
}

/** Counterparty when the payer MSISDN is absent: unique per receipt, so it never fakes reuse. */
export function receiptCounterpartyHash(receipt: string): string {
  return keyedHash('counterparty', `receipt:${receipt}`);
}

const PHONE_KEY_RE = /^(msisdn|phonenumber|phone|partya|partyb)$/i;
const NAME_KEY_RE = /^(firstname|middlename|lastname|name_of_payer|payername)$/i;

/** True for a value that looks like a Kenyan MSISDN (redacted before storage). */
export function isPhoneLike(value: unknown): boolean {
  const digits = str(value).replace(/[\s+()-]/g, '');
  return /^(?:254|0)?[17]\d{8}$/.test(digits);
}

function redactNode(node: any): any {
  if (Array.isArray(node)) {
    return node.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && PHONE_KEY_RE.test(str(item.Name)) && 'Value' in item) {
        return { ...redactNode({ ...item, Value: undefined }), Value: msisdnHash(item.Value) ?? MASKED_VALUE };
      }
      return redactNode(item);
    });
  }
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (PHONE_KEY_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) {
      out[key] = msisdnHash(value) ?? MASKED_VALUE;
    } else if (NAME_KEY_RE.test(key) && value !== null && value !== undefined && typeof value !== 'object') {
      out[key] = REDACTED_VALUE;
    } else if (key === 'BillRefNumber' && isPhoneLike(value)) {
      out[key] = keyedHash('counterparty', `billref:${str(value).replace(/[\s+()-]/g, '')}`);
    } else {
      out[key] = redactNode(value);
    }
  }
  return out;
}

/** Stored next to an STK callback's PhoneNumber hash: the same MSISDN under the previous PII key. */
export const STK_PHONE_ALT_FIELD = 'PhoneNumberAltHashes';

/**
 * Deep copy of the body with MSISDNs replaced by their HMAC and payer names removed.
 * During a PII key rotation an STK callback also keeps its PhoneNumber's HMAC under the previous
 * key, so the STK fallback match can still pair it with a request hashed before the rotation.
 */
export function redactPayload(body: unknown): unknown {
  const out = redactNode(body);
  const stk = (body as any)?.Body?.stkCallback;
  if (stk && typeof stk === 'object' && out?.Body?.stkCallback) {
    const input = msisdnHashInput(itemValue(stkItems(stk), 'PhoneNumber'));
    const alt = input === null ? [] : alternateKeyedHashes('counterparty', input);
    if (alt.length > 0) out.Body.stkCallback[STK_PHONE_ALT_FIELD] = alt;
  }
  return out;
}

// ── Worker-side parser (stored, redacted payload) ─────────────────────────

export interface ParsedCallback {
  receipt: string;
  amountCents: number;
  channel: SourceChannel;
  /** Payment time in UTC, or null when Daraja's timestamp is missing/unparseable. */
  paymentTime: Date | null;
  /** Keyed MSISDN hash from the redacted payload, or null when absent/masked. */
  counterpartyHash: string | null;
  /** The same MSISDN's hash under the previous PII key (STK, during a rotation only). */
  counterpartyAltHashes: string[];
  checkoutRequestId: string | null;
  billRefNumber: string | null;
}

/** Parses a stored intake payload; throws CallbackParseError (terminal) when it is unusable. */
export function parseStoredCallback(payload: unknown): ParsedCallback {
  const ingress = extractIngress(payload);
  if (ingress.kind !== 'ok') throw new CallbackParseError(`unparseable payload: ${ingress.reason}`);
  const body = payload as any;
  const keyed = (v: unknown): string | null => (KEYED_HASH_RE.test(str(v)) ? str(v) : null);

  if (ingress.channel === 'DARAJA_STK') {
    const stk = body.Body.stkCallback;
    const items = stkItems(stk);
    return {
      receipt: ingress.receipt,
      amountCents: ingress.amountCents,
      channel: ingress.channel,
      paymentTime: parseDarajaTime(itemValue(items, 'TransactionDate')),
      counterpartyHash: keyed(itemValue(items, 'PhoneNumber')),
      counterpartyAltHashes: Array.isArray(stk[STK_PHONE_ALT_FIELD])
        ? stk[STK_PHONE_ALT_FIELD].map(keyed).filter((h: string | null): h is string => h !== null)
        : [],
      checkoutRequestId: str(stk.CheckoutRequestID) || null,
      billRefNumber: null,
    };
  }
  return {
    receipt: ingress.receipt,
    amountCents: ingress.amountCents,
    channel: ingress.channel,
    paymentTime: parseDarajaTime(body.TransTime),
    counterpartyHash: keyed(body.MSISDN),
    counterpartyAltHashes: [],
    checkoutRequestId: null,
    billRefNumber: str(body.BillRefNumber) || null,
  };
}

/** The counterparty id sent to ml-engine and stored on the transaction. */
export function counterpartyHash(parsed: Pick<ParsedCallback, 'counterpartyHash' | 'receipt'>): string {
  return parsed.counterpartyHash ?? receiptCounterpartyHash(parsed.receipt);
}

// ── Reconciliation helpers (spec gh-6-recon) ──────────────────────────────

/** Visible digits a masked-phone fingerprint is made of: the 254-form prefix and the last digits. */
export const MASK_PREFIX_DIGITS = 4;
export const MASK_SUFFIX_DIGITS = 3;

const maskInput = (prefix: string, suffix: string) => `mask:${prefix}|${suffix}`;

/**
 * The visible prefix/suffix of a masked phone ("2547****678", "07** *** 678", "2547XXXXX678"), the
 * prefix normalised to the 254 form; null when it is not a masked phone or shows too few digits.
 */
export function maskedPhoneParts(raw: unknown): { prefix: string; suffix: string } | null {
  const v = str(raw).replace(/[\s()-]/g, '');
  const m = /^\+?(\d+)[*•xX]+(\d+)$/.exec(v);
  if (!m) return null;
  let prefix = m[1];
  if (prefix.startsWith('0')) prefix = `254${prefix.slice(1)}`;
  else if (/^[17]/.test(prefix)) prefix = `254${prefix}`;
  if (!prefix.startsWith('254') || prefix.length < MASK_PREFIX_DIGITS || m[2].length < MASK_SUFFIX_DIGITS) return null;
  return { prefix: prefix.slice(0, MASK_PREFIX_DIGITS), suffix: m[2].slice(-MASK_SUFFIX_DIGITS) };
}

/** Masked-phone fingerprint of a normalised MSISDN, stored at STK initiation (current key). */
export function msisdnMaskHash(msisdn: string): string {
  return keyedHash('phone_mask', maskInput(msisdn.slice(0, MASK_PREFIX_DIGITS), msisdn.slice(-MASK_SUFFIX_DIGITS)));
}

/** Every fingerprint (current and previous PII key) a masked statement phone can match. */
export function maskHashCandidates(parts: { prefix: string; suffix: string }): string[] {
  const input = maskInput(parts.prefix, parts.suffix);
  return [keyedHash('phone_mask', input), ...alternateKeyedHashes('phone_mask', input)];
}

/** Every counterparty hash (current and previous PII key) a full, normalised MSISDN can match. */
export function msisdnHashCandidates(msisdn: string): string[] {
  return [normalisedMsisdnHash(msisdn), ...alternateKeyedHashes('counterparty', `msisdn:${msisdn}`)];
}

export type OtherParty = { kind: 'full'; msisdn: string } | { kind: 'masked'; prefix: string; suffix: string } | { kind: 'none' };

/**
 * Statement "Other Party Info" ("2547****678 - JOHN DOE", "254712345678 - JOHN DOE", "600000 - ACME"):
 * the phone (full or masked), never the name — the name is dropped here and never stored.
 */
export function parseOtherParty(raw: unknown): OtherParty {
  const value = str(raw);
  if (!value) return { kind: 'none' };
  // Up to the first " - NAME" separator, then the leading run of phone characters ending in a digit
  // (internal spaces / hyphens allowed; a name with no separator stops it). Normalised whole.
  const m = /^[+\d*•xX\s-]*\d/.exec(value.split(/\s+-\s+/)[0].trim());
  if (!m) return { kind: 'none' };
  const head = m[0].replace(/[\s-]/g, '');
  const msisdn = normaliseKenyanMsisdn(head);
  if (msisdn) return { kind: 'full', msisdn };
  const masked = maskedPhoneParts(head);
  return masked ? { kind: 'masked', ...masked } : { kind: 'none' };
}

/** JSON with object keys sorted at every level: the canonical bytes of a synthesised payload. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The CheckoutRequestID of an STK callback body (raw or redacted), or null. */
export function checkoutRequestIdOf(body: unknown): string | null {
  const id = str((body as any)?.Body?.stkCallback?.CheckoutRequestID);
  return id && id.length <= 100 ? id : null;
}

/** Identity fields of a raw (unredacted) callback, for comparing a late callback with a recovered row. */
export function callbackIdentity(body: unknown): { checkoutRequestId: string | null; billRefNumber: string | null; phoneRaw: unknown } {
  const b = body as any;
  if (b?.Body?.stkCallback) {
    return { checkoutRequestId: checkoutRequestIdOf(b), billRefNumber: null, phoneRaw: itemValue(stkItems(b.Body.stkCallback), 'PhoneNumber') };
  }
  return { checkoutRequestId: null, billRefNumber: str(b?.BillRefNumber) || null, phoneRaw: b?.MSISDN };
}

/** The normalised MSISDN of a plain (unmasked, not provider-hashed) phone value, else null. */
export function plainMsisdn(raw: unknown): string | null {
  const input = msisdnHashInput(raw);
  return input?.startsWith('msisdn:') ? input.slice('msisdn:'.length) : null;
}

/**
 * Does a stored phone hash belong to `msisdn`? `counterparty`: the full-phone HMAC; `phone_mask`:
 * the masked-phone fingerprint. null when it cannot be told (made under a retired key).
 */
export function phoneHashVerdict(stored: string, domain: 'counterparty' | 'phone_mask', msisdn: string): boolean | null {
  const input = domain === 'counterparty' ? `msisdn:${msisdn}` : maskInput(msisdn.slice(0, MASK_PREFIX_DIGITS), msisdn.slice(-MASK_SUFFIX_DIGITS));
  return keyedHashMatches(stored, domain, input);
}
