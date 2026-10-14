import type { EscrowStatus } from '@/shared/domain/escrow-status';

/** Commission not yet in the claimable balance: in escrow, quarantined, or inside a claim. */
export interface CommissionAccrual {
  readonly id: string;
  readonly amountCents: number;
  /** Lifecycle state as of the server snapshot (never flipped locally by a countdown). */
  readonly status: EscrowStatus;
  /** Epoch ms the hold matures (server's release_due_at). */
  readonly releaseDueAt: number;
  readonly quarantineReason: string | null;
}

export type PayoutStatus = 'SENT' | 'UNKNOWN' | 'PAID' | 'FAILED' | 'UNRESOLVED';

export interface Payout {
  readonly id: string;
  readonly status: PayoutStatus;
  readonly amountCents: number;
  /** Masked, as the gateway sends it (2547******78). */
  readonly msisdn: string;
  /** M-Pesa receipt code once PAID. */
  readonly receipt: string | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface LedgerSnapshot {
  readonly balance: {
    /** Claimable gross plus the carry. */
    readonly cents: number;
    /** What a claim would pay now (whole shillings, as cents). */
    readonly payableNowCents: number;
    readonly minAmountCents: number;
    readonly maxAmountCents: number;
  };
  /** The ACTIVE payout line, masked, or null when none is verified. */
  readonly destination: string | null;
  /** A replacement line is pending or cooling off: claims are blocked. */
  readonly destinationChanging: boolean;
  readonly disclosure: { readonly version: string; readonly text: string };
  /** Newest first. */
  readonly payouts: readonly Payout[];
  /** Soonest maturity first. */
  readonly accruals: readonly CommissionAccrual[];
  readonly pendingCount: number;
  readonly pendingCents: number;
}

export type PayoutLineStatus = 'PENDING_VERIFICATION' | 'COOLING_OFF' | 'ACTIVE' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/** A payout destination (the agent's own registered M-Pesa number). */
export interface PayoutLine {
  readonly id: string;
  readonly msisdn: string;
  readonly status: PayoutLineStatus;
  readonly rejectReason: string | null;
  readonly coolingOffUntil: number | null;
}

const OPEN: readonly PayoutStatus[] = ['SENT', 'UNKNOWN', 'UNRESOLVED'];
export const isOpenPayout = (p: Payout): boolean => OPEN.includes(p.status);

/** The payout still in flight, if any (at most one per agent). */
export const openPayout = (s: LedgerSnapshot): Payout | null => s.payouts.find(isOpenPayout) ?? null;

/** Milliseconds until a hold matures, never negative. */
export const holdRemaining = (now: number, dueAt: number): number => Math.max(0, dueAt - now);

/** Next instant a countdown reaches zero (an in-escrow accrual maturing after `now`), or null. */
export function nextMaturity(s: LedgerSnapshot, now: number): number | null {
  let next: number | null = null;
  for (const a of s.accruals) if (a.status === 'ESCROW_HOLD' && a.releaseDueAt > now && (next === null || a.releaseDueAt < next)) next = a.releaseDueAt;
  return next;
}

/** "2d 4h", "3h 05m", "4:09" — coarse for long holds, a ticking clock under an hour. */
export function formatHold(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
