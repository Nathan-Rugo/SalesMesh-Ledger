/** In-memory stand-in for src/repositories/stk.repository (unit tests), same exported signatures. */

import crypto from 'crypto';
import type { FallbackCandidate, NewStkRequest, RecordedOutcome, StkRow, StkStatus } from '../../src/repositories/stk.repository';

export interface MemStk {
  stkRequestId: string;
  agentId: string;
  status: StkStatus;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  amount: number;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  phoneHash: string | null;
  accountReference: string | null;
  responseCode: string | null;
  resultCode: string | null;
  error: string | null;
  customerMessage: string | null;
  claimedAt: number;
  createdAt: number;
  consumedReceipt: string | null;
}

export const memStk = { rows: [] as MemStk[], reset() { this.rows.length = 0; } };

const view = (r: MemStk): StkRow => ({
  stkRequestId: r.stkRequestId,
  agentId: r.agentId,
  status: r.status,
  checkoutRequestId: r.checkoutRequestId,
  amount: r.amount.toFixed(2),
  requestFingerprint: r.requestFingerprint,
  responseCode: r.responseCode,
  resultCode: r.resultCode,
  error: r.error,
  customerMessage: r.customerMessage,
  pendingAgeMs: r.status === 'PENDING' ? Date.now() - r.claimedAt : null,
});

export function seedStk(p: Partial<MemStk> & { agentId: string }): MemStk {
  const row: MemStk = {
    stkRequestId: crypto.randomUUID(),
    status: 'PENDING',
    checkoutRequestId: null,
    merchantRequestId: null,
    amount: 100,
    idempotencyKey: null,
    requestFingerprint: null,
    phoneHash: null,
    accountReference: null,
    responseCode: null,
    resultCode: null,
    error: null,
    customerMessage: null,
    claimedAt: Date.now(),
    createdAt: Date.now(),
    consumedReceipt: null,
    ...p,
  };
  memStk.rows.push(row);
  return row;
}

export async function claimStkRequest(_db: unknown, r: NewStkRequest): Promise<StkRow | null> {
  if (memStk.rows.some((x) => x.agentId === r.agentId && x.idempotencyKey === r.idempotencyKey)) return null;
  return view(
    seedStk({
      agentId: r.agentId,
      idempotencyKey: r.idempotencyKey,
      requestFingerprint: r.fingerprint,
      phoneHash: r.phoneHash,
      amount: r.amount,
      accountReference: r.accountReference,
    })
  );
}

export async function findByIdempotencyKey(_db: unknown, agentId: string, key: string): Promise<StkRow | null> {
  const r = memStk.rows.find((x) => x.agentId === agentId && x.idempotencyKey === key);
  return r ? view(r) : null;
}

export async function findStkById(_db: unknown, id: string): Promise<StkRow | null> {
  const r = memStk.rows.find((x) => x.stkRequestId === id);
  return r ? view(r) : null;
}

export async function recordStkOutcome(_db: unknown, id: string, o: RecordedOutcome): Promise<StkRow | null> {
  const r = memStk.rows.find((x) => x.stkRequestId === id && x.checkoutRequestId === null && x.consumedReceipt === null);
  if (!r) return null;
  if (o.kind === 'ACCEPTED') {
    if (r.status !== 'PENDING' && r.status !== 'UNKNOWN') return null;
    Object.assign(r, { status: 'ACCEPTED', checkoutRequestId: o.checkoutRequestId, merchantRequestId: o.merchantRequestId, responseCode: o.responseCode, customerMessage: o.customerMessage, error: null });
  } else {
    if (!(r.status === 'PENDING' || (r.status === 'UNKNOWN' && o.kind === 'REJECTED'))) return null;
    Object.assign(r, { status: o.kind, responseCode: o.code, error: o.message });
  }
  return view(r);
}

export async function expireStalePending(_db: unknown, id: string, olderThanMs: number): Promise<StkRow | null> {
  const r = memStk.rows.find((x) => x.stkRequestId === id && x.status === 'PENDING' && x.claimedAt < Date.now() - olderThanMs);
  if (!r) return null;
  r.status = 'UNKNOWN';
  r.error = 'no recorded Daraja answer (stale PENDING)';
  return view(r);
}

export async function hasRecentDuplicate(
  _db: unknown,
  q: { agentId: string; phoneHashes: string[]; amount: number; idempotencyKey: string; windowMs: number }
): Promise<boolean> {
  return memStk.rows.some(
    (x) =>
      x.agentId === q.agentId && x.phoneHash !== null && q.phoneHashes.includes(x.phoneHash) && x.amount === q.amount &&
      x.idempotencyKey !== q.idempotencyKey && ['PENDING', 'ACCEPTED', 'UNKNOWN'].includes(x.status) && x.createdAt > Date.now() - q.windowMs
  );
}

export async function lockDuplicateGuard(): Promise<void> {
  /* single-threaded: nothing to serialise */
}
export async function expireOpenRequests(): Promise<number> {
  return 0;
}
export async function markStkFailed(): Promise<number> {
  return 0;
}
export async function findFallbackCandidates(): Promise<FallbackCandidate[]> {
  return [];
}
export async function bindFallback(): Promise<boolean> {
  return false;
}
export const STK_TTL_MS = 180_000;
