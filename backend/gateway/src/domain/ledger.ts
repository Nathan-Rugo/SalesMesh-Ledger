/**
 * @file ledger.ts
 * @description Pure rules for the Fabric ledger sync (DLT-03, #10): the escrow state preimage v1 and
 * its HMAC, the chaincode request builders (docs/architecture/commission-chaincode.md), chaincode
 * error classification and the Fabric block-header hash. No I/O, no env.
 */

import crypto from 'crypto';

/** The #9 chaincode's error codes: a failure carrying one is terminal (retrying cannot change it). */
export const LEDGER_CODES = [
  'UNAUTHORISED',
  'INVALID_ARGUMENT',
  'NOT_INITIALISED',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
  'NOT_MATURED',
  'CANARY_NOT_HEALTHY',
  'LOCKED_BY_AUDITOR',
] as const;
export type LedgerCode = (typeof LEDGER_CODES)[number];

/** Sorted-key, whitespace-free JSON (objects recursively; arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const hmacHex = (key: Buffer, data: string): string => crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');

/** Fabric times: RFC3339 UTC with milliseconds (what the chaincode stores). */
export const ledgerTime = (d: Date): string => d.toISOString();

/** The escrow as settled in Postgres: everything the state hash commits to. */
export interface EscrowState {
  escrowId: string;
  transactionId: string;
  agentId: string;
  mpesaReceiptId: string;
  rawPayloadHash: string;
  amountCents: number;
  grossCents: number;
  verificationId: string;
  modelVersion: string;
  modelSha256: string | null;
  decision: string;
  failSafe: boolean;
  quarantineReason: string | null;
  releaseDueAt: Date;
}

/** State preimage v1: canonical JSON of the Postgres values (an auditor recomputes it from the DB). */
export function statePreimageV1(s: EscrowState): string {
  return canonicalJson({
    v: 1,
    escrowId: s.escrowId,
    transactionId: s.transactionId,
    agentId: s.agentId,
    mpesaReceiptId: s.mpesaReceiptId,
    rawPayloadHash: s.rawPayloadHash,
    amountCents: s.amountCents,
    grossCents: s.grossCents,
    verificationId: s.verificationId,
    modelVersion: s.modelVersion,
    modelSha256: s.modelSha256,
    decision: s.decision,
    failSafe: s.failSafe,
    quarantineReason: s.quarantineReason,
    releaseDueAt: ledgerTime(s.releaseDueAt),
  });
}

/** A chaincode code (`^[a-z][a-z0-9_]{0,39}$`): lowercase, other characters → `_`, a letter first, 40 max. */
export function sanitizeCode(s: string): string {
  let c = s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z]/.test(c)) c = `x${c}`;
  return c.slice(0, 40);
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECISIONS = new Set(['CLEAR', 'REVIEW', 'QUARANTINE']);

export function commitRequest(s: EscrowState, stateHash: string): string {
  return JSON.stringify({
    escrowId: s.escrowId,
    agentRef: s.agentId,
    stateHash,
    modelVersion: s.modelVersion.replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 64) || 'unknown',
    modelSha256: s.modelSha256 && HEX64.test(s.modelSha256) ? s.modelSha256 : '',
    decision: DECISIONS.has(s.decision) ? s.decision : 'QUARANTINE', // fail closed
    failSafe: s.failSafe,
    quarantineReason: s.quarantineReason ? sanitizeCode(s.quarantineReason) : '',
    grossCents: s.grossCents,
    releaseDueAt: ledgerTime(s.releaseDueAt),
  });
}

export const quarantineRequest = (requestId: string, escrowId: string, reason: string): string =>
  JSON.stringify({ requestId, escrowId, reason: sanitizeCode(reason) });

export const releaseRequest = (requestId: string, escrowId: string, reason: string, releaseDueAt: Date): string =>
  JSON.stringify({ requestId, escrowId, reason: sanitizeCode(reason), releaseDueAt: ledgerTime(releaseDueAt) });

export interface Canary {
  status: string;
  destinationRef: string;
  checkedAt: Date;
}

export interface AuthoriseInput {
  payoutId: string;
  agentId: string;
  escrowIds: string[];
  grossCents: number;
  carryInCents: number;
  carryOutCents: number;
  amount: number;
  consentDigest: string;
  disclosureVersion: string;
  canary: Canary;
}

export const authoriseRequest = (a: AuthoriseInput): string =>
  JSON.stringify({
    payoutId: a.payoutId,
    agentRef: a.agentId,
    escrowIds: a.escrowIds,
    grossCents: a.grossCents,
    carryInCents: a.carryInCents,
    carryOutCents: a.carryOutCents,
    amount: a.amount,
    consentDigest: a.consentDigest,
    disclosureVersion: a.disclosureVersion,
    canary: { status: a.canary.status, destinationRef: a.canary.destinationRef, checkedAt: ledgerTime(a.canary.checkedAt) },
  });

export const settleRequest = (payoutId: string, s: { outcome: 'PAID' } | { outcome: 'FAILED'; failureCode: string; quarantineEscrowIds: string[] }): string =>
  JSON.stringify(
    s.outcome === 'PAID'
      ? { payoutId, outcome: 'PAID' }
      : { payoutId, outcome: 'FAILED', failureCode: sanitizeCode(s.failureCode), quarantineEscrowIds: [...s.quarantineEscrowIds].sort() }
  );

const CODE_RE = new RegExp(`(?:^|[\\s,(])(${LEDGER_CODES.join('|')}): `);

/**
 * The #9 code of a chaincode refusal, read from `EndorseError.details[].message` (one per endorsing
 * peer), or null for anything else: unavailable, deadline, MVCC, ENDORSEMENT_POLICY_FAILURE, commit
 * failures — all retryable. Only the details are read: a gRPC status text ("5 NOT_FOUND: ...") is not ours.
 */
export function chaincodeCode(err: unknown): LedgerCode | null {
  const details = (err as { details?: unknown })?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const m = CODE_RE.exec(String((d as { message?: unknown })?.message ?? ''));
    if (m) return m[1] as LedgerCode;
  }
  return null;
}

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);

function derUnsigned(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const b = Buffer.from(hex, 'hex');
  return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; // a positive INTEGER never has its top bit set
}

/**
 * Fabric's block hash (protoutil.BlockHeaderHash): SHA-256 of the DER
 * SEQUENCE{INTEGER number, OCTET STRING previous_hash, OCTET STRING data_hash}. Block N+1's
 * previous_hash equals it.
 */
export function blockHeaderHash(number: bigint, previousHash: Uint8Array, dataHash: Uint8Array): string {
  const der = tlv(0x30, Buffer.concat([tlv(0x02, derUnsigned(number)), tlv(0x04, Buffer.from(previousHash)), tlv(0x04, Buffer.from(dataHash))]));
  return crypto.createHash('sha256').update(der).digest('hex');
}
