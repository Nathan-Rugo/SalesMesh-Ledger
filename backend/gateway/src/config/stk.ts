/**
 * @file stk.ts
 * @description STK initiation timing (spec gh-5). Everything derives from one overall Daraja
 * deadline, DARAJA_TOTAL_TIMEOUT_MS (default 25 s), which bounds a whole stkPush() — OAuth fetch
 * and its retry, the push, and the one token-invalid refresh + push. So:
 *  - a concurrent same-key waiter waits a little longer than the claimant can possibly take;
 *  - a PENDING row older than the deadline + 10 s can no longer receive an answer (→ UNKNOWN);
 *  - an UNKNOWN / stale PENDING row whose callback cannot match any more (STK_TTL + 10 min) → EXPIRED.
 */

const posInt = (v: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** STK_TTL: a callback is attributed to a request created at most this long before payment time. */
export const STK_TTL_MS = 180_000;

/** The overall budget of one stkPush() (every sub-call is bounded by it). */
export function darajaTotalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return posInt(env.DARAJA_TOTAL_TIMEOUT_MS, 25_000, 120_000);
}

export interface PaymentsConfig {
  /** Overall Daraja budget (DARAJA_TOTAL_TIMEOUT_MS). */
  darajaTotalTimeoutMs: number;
  /** Concurrent same-key requests wait this long for the claimant (> its whole Daraja budget). */
  waiterTimeoutMs: number;
  /** A PENDING row older than this cannot still get Daraja's answer: it becomes UNKNOWN. */
  stalePendingMs: number;
  /** Concurrent same-key requests poll the row this often while it is PENDING. */
  pollIntervalMs: number;
  /** Soft duplicate guard window (same agent, phone, amount). */
  duplicateWindowMs: number;
}

export function paymentsConfig(env: NodeJS.ProcessEnv = process.env, total = darajaTotalTimeoutMs(env)): PaymentsConfig {
  return {
    darajaTotalTimeoutMs: total,
    waiterTimeoutMs: total + 5_000,
    stalePendingMs: total + 10_000,
    pollIntervalMs: 100,
    duplicateWindowMs: 60_000,
  };
}

/** Allowed gateway-ahead-of-Safaricom clock skew on the fallback window's upper bound (default 60 s). */
export const stkClockSkewMs = (env: NodeJS.ProcessEnv = process.env): number => posInt(env.STK_CLOCK_SKEW_MS, 60_000, 600_000);

/** UNKNOWN / stale PENDING rows older than this can no longer be matched by a callback: EXPIRED. */
export const STK_EXPIRE_AFTER_MS = STK_TTL_MS + 10 * 60_000;
