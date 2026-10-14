import { fromGatewayEscrow, type GatewayEscrowStatus } from '@/shared/domain/escrow-status';
import type { CommissionAccrual, LedgerSnapshot, Payout, PayoutLine, PayoutLineStatus, PayoutStatus } from '../../domain/entities/ledger';

// Validators for untrusted gateway bodies (payout.controller.ts / payout_destination.controller.ts).
// Each returns null on any malformed field: the caller reports `unexpected`, never crashes.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
/** ISO timestamp → epoch ms, or NaN. */
const time = (v: unknown): number => (isStr(v) ? Date.parse(v) : NaN);
/** null stays null; a bad timestamp is undefined (malformed). */
const timeOrNull = (v: unknown): number | null | undefined => (v === null ? null : Number.isFinite(time(v)) ? time(v) : undefined);

/** Maps an array, or null if it isn't one or any item fails. */
function all<T>(v: unknown, f: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const m = f(x);
    if (m === null) return null;
    out.push(m);
  }
  return out;
}

const PAYOUT_STATUSES: readonly PayoutStatus[] = ['SENT', 'UNKNOWN', 'PAID', 'FAILED', 'UNRESOLVED'];
const ACCRUAL_STATUSES: readonly GatewayEscrowStatus[] = ['HELD', 'QUARANTINED', 'CLAIMED'];
const LINE_STATUSES: readonly PayoutLineStatus[] = ['PENDING_VERIFICATION', 'COOLING_OFF', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'EXPIRED', 'CANCELLED'];

/** One payout `view`: `amount` is whole shillings. */
export function toPayout(v: unknown): Payout | null {
  if (!isObj(v)) return null;
  const status = PAYOUT_STATUSES.find((s) => s === v.status);
  const createdAt = time(v.created_at);
  const resolvedAt = timeOrNull(v.resolved_at);
  if (!isStr(v.payout_id) || !status || !isCount(v.amount) || !isStr(v.msisdn) || !strOrNull(v.receipt) || !strOrNull(v.failure_reason)) return null;
  if (!Number.isFinite(createdAt) || resolvedAt === undefined) return null;
  return { id: v.payout_id, status, amountCents: v.amount * 100, msisdn: v.msisdn, receipt: v.receipt, failureReason: v.failure_reason, createdAt, resolvedAt };
}

/**
 * One accrual. The gateway lists only unmatured HELD escrows (matured ones are the balance), so
 * HELD is always "in escrow" here, whatever the local clock says: only a refetch moves it.
 */
export function toAccrual(v: unknown): CommissionAccrual | null {
  if (!isObj(v)) return null;
  const raw = ACCRUAL_STATUSES.find((s) => s === v.status);
  const releaseDueAt = time(v.release_due_at);
  if (!isStr(v.escrow_id) || !raw || !isCount(v.amount_cents) || !Number.isFinite(releaseDueAt) || !strOrNull(v.quarantine_reason)) return null;
  return {
    id: v.escrow_id,
    amountCents: v.amount_cents,
    status: fromGatewayEscrow(raw, { matured: false, securityHold: v.quarantine_reason === 'security_hold' }),
    releaseDueAt,
    quarantineReason: v.quarantine_reason,
  };
}

/** GET /api/v1/payouts. */
export function toLedgerSnapshot(body: unknown): LedgerSnapshot | null {
  if (!isObj(body) || !isObj(body.balance) || !isObj(body.disclosure)) return null;
  const { balance: b, disclosure: d } = body;
  if (!isCount(b.cents) || !isCount(b.payable_now) || !isCount(b.min_amount) || !isCount(b.max_amount)) return null;
  if (!strOrNull(body.destination) || typeof body.destination_changing !== 'boolean' || !isStr(d.version) || !isStr(d.text)) return null;
  if (!isCount(body.pending_count) || !isCount(body.pending_cents)) return null;
  const payouts = all(body.payouts, toPayout);
  const accruals = all(body.accruals, toAccrual);
  if (!payouts || !accruals) return null;
  return {
    balance: { cents: b.cents, payableNowCents: b.payable_now * 100, minAmountCents: b.min_amount * 100, maxAmountCents: b.max_amount * 100 },
    destination: body.destination,
    destinationChanging: body.destination_changing,
    disclosure: { version: d.version, text: d.text },
    payouts,
    accruals,
    pendingCount: body.pending_count,
    pendingCents: body.pending_cents,
  };
}

export function toPayoutLine(v: unknown): PayoutLine | null {
  if (!isObj(v)) return null;
  const status = LINE_STATUSES.find((s) => s === v.status);
  const coolingOffUntil = timeOrNull(v.cooling_off_until);
  if (!isStr(v.destination_id) || !isStr(v.msisdn) || !status || !strOrNull(v.reject_reason) || coolingOffUntil === undefined) return null;
  return { id: v.destination_id, msisdn: v.msisdn, status, rejectReason: v.reject_reason, coolingOffUntil };
}

/** GET /api/v1/payout-destinations → its lines. */
export const toPayoutLines = (body: unknown): PayoutLine[] | null => (isObj(body) ? all(body.destinations, toPayoutLine) : null);

/** A body carrying one `payout` (claim 202) or `destination` (verify 202). */
export const toClaimedPayout = (body: unknown): Payout | null => (isObj(body) ? toPayout(body.payout) : null);
export const toRegisteredLine = (body: unknown): PayoutLine | null => (isObj(body) ? toPayoutLine(body.destination) : null);
