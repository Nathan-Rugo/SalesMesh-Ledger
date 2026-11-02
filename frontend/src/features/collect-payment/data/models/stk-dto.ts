import type { StkRequest, StkStatus } from '../../domain/entities/stk-request';

// Validator for untrusted gateway bodies (payments.controller.ts: initiation replies and GET status).
// Returns null on any malformed field: the caller reports `unexpected`, never crashes.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStrOrNull = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === 'string';

/** Gateway status → what the agent sees (see StkStatus). */
const STATUS: Readonly<Record<string, StkStatus>> = {
  ACCEPTED: 'ACCEPTED',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  UNKNOWN: 'UNKNOWN',
  PENDING: 'UNKNOWN',
  PAID_UNCONFIRMED: 'UNKNOWN',
  RECONCILE_EXHAUSTED: 'UNKNOWN',
};

/** One STK request body. `paid` / `receipt` are only on GET status; absent means unpaid. */
export function toStkRequest(v: unknown): StkRequest | null {
  if (!isObj(v) || typeof v.stk_request_id !== 'string' || v.stk_request_id.length === 0) return null;
  const raw = typeof v.status === 'string' && Object.hasOwn(STATUS, v.status) ? STATUS[v.status] : undefined;
  if (!raw || !optStrOrNull(v.result_code) || !optStrOrNull(v.receipt)) return null;
  if (v.paid !== undefined && typeof v.paid !== 'boolean') return null;
  const receipt = v.receipt ?? null;
  if (v.paid === true && receipt === null) return null;
  return { id: v.stk_request_id, status: v.paid === true ? 'PAID' : raw, resultCode: v.result_code ?? null, receipt: v.paid === true ? receipt : null };
}
