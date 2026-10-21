/**
 * @file escrow.repository.ts
 * @description SQL for the self-healing quarantine (re-score lease on escrow_accounts).
 *
 * Eligible: QUARANTINED, not security-held, not kept held by an admin, latest verification event fail-safe with a
 * retryable cause, attempts left, backoff elapsed, and no live re-score lease. Model-made
 * quarantines (latest event not fail-safe) and RELEASED escrows are never touched.
 */

import { RETRYABLE_FAIL_SAFE_CAUSES } from '../services/risk_client.service';
import type { Db } from './db.types';
import { enqueueQuarantine, enqueueRelease } from './ledger.repository';

const LATEST_EVENT = `
  SELECT v.is_fail_safe, v.fail_safe_cause FROM verification_events v
   WHERE v.transaction_id = e.transaction_id
   ORDER BY v.evaluated_at DESC, (v.kind = 'RESCORE') DESC, v.verification_id DESC
   LIMIT 1`;

const ELIGIBLE = `
  e.escrow_status = 'QUARANTINED' AND NOT e.security_hold
  AND e.reviewed_at IS NULL -- an admin's "Keep held" (spec gh-14) is never undone by a rescore
  AND lv.is_fail_safe AND lv.fail_safe_cause = ANY($1::text[])`;

export interface RescoreClaim {
  escrow_id: string;
  transaction_id: string;
  rescore_claim_token: string;
  rescore_attempts: number;
}

export async function claimRescoreBatch(
  db: Db,
  limit: number,
  leaseMs: number,
  maxAttempts: number
): Promise<RescoreClaim[]> {
  const { rows } = await db.query<RescoreClaim>(
    `UPDATE escrow_accounts c
        SET rescore_claimed_at = NOW(), rescore_claim_token = gen_random_uuid(),
            rescore_attempts = c.rescore_attempts + 1
      WHERE c.escrow_id IN (
            SELECT e.escrow_id FROM escrow_accounts e
              JOIN LATERAL (${LATEST_EVENT}) lv ON TRUE
             WHERE ${ELIGIBLE}
               AND e.rescore_attempts < $3 AND e.next_rescore_at <= NOW()
               AND (e.rescore_claimed_at IS NULL
                    OR e.rescore_claimed_at < NOW() - make_interval(secs => $4::double precision / 1000))
             ORDER BY e.next_rescore_at
             LIMIT $2
             FOR UPDATE OF e SKIP LOCKED)
      RETURNING c.escrow_id, c.transaction_id, c.rescore_claim_token, c.rescore_attempts`,
    [RETRYABLE_FAIL_SAFE_CAUSES, limit, maxAttempts, leaseMs]
  );
  return rows;
}

export interface RescoreContext {
  receipt: string;
  agentId: string;
  timestamp: Date;
  amount: number;
  counterpartyHash: string;
  /** Receipts the INITIAL request carried; null for legacy events (fall back to the ingest cut). */
  historyReceipts: string[] | null;
}

export async function loadRescoreContext(db: Db, transactionId: string): Promise<RescoreContext | null> {
  const { rows } = await db.query<{
    receipt: string; agent_id: string; ts: Date; amount: string; counterparty_hash: string; history_receipts: string[] | null;
  }>(
    `SELECT t.mpesa_receipt_id AS receipt, t.agent_id, t.timestamp AS ts, t.amount::text AS amount, t.counterparty_hash,
            (SELECT v.history_receipts FROM verification_events v
              WHERE v.transaction_id = t.transaction_id AND v.kind = 'INITIAL') AS history_receipts
       FROM transactions t WHERE t.transaction_id = $1`,
    [transactionId]
  );
  const r = rows[0];
  return r
    ? {
        receipt: r.receipt,
        agentId: r.agent_id,
        timestamp: new Date(r.ts),
        amount: Number(r.amount),
        counterpartyHash: r.counterparty_hash,
        historyReceipts: r.history_receipts ?? null,
      }
    : null;
}

/** Inside the finalise transaction: lock our leased escrow and re-check eligibility. */
export async function lockRescoreLease(db: Db, escrowId: string, token: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM escrow_accounts e
       JOIN LATERAL (${LATEST_EVENT}) lv ON TRUE
      WHERE e.escrow_id = $2 AND e.rescore_claim_token = $3 AND ${ELIGIBLE}
      FOR UPDATE OF e`,
    [RETRYABLE_FAIL_SAFE_CAUSES, escrowId, token]
  );
  return rows.length === 1;
}

/** Guarded promote: model CLEAR moves QUARANTINED → HELD, T_hold (seconds) from the re-score; queues the ledger Release. */
export async function promoteToHeld(db: Db, escrowId: string, token: string, holdSeconds: number): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE escrow_accounts
        SET escrow_status = 'HELD', hold_period_hours = CEIL($3::int / 3600.0)::int, hold_seconds = $3::int,
            release_due_at = NOW() + make_interval(secs => $3::int), quarantine_reason = NULL,
            rescore_claimed_at = NULL, rescore_claim_token = NULL
      WHERE escrow_id = $1 AND rescore_claim_token = $2
        AND escrow_status = 'QUARANTINED' AND NOT security_hold
      RETURNING release_due_at`,
    [escrowId, token, holdSeconds]
  );
  if (rows.length !== 1) return false;
  await enqueueRelease(db, escrowId, 'rescore_clear', new Date(rows[0].release_due_at));
  return true;
}

/** A re-score that ended in a model-made quarantine (REVIEW / QUARANTINE / trust freeze) records why; a new reason goes to the ledger. */
export async function setQuarantineReason(db: Db, escrowId: string, reason: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE escrow_accounts SET quarantine_reason = $2 WHERE escrow_id = $1 AND escrow_status = 'QUARANTINED' AND quarantine_reason IS DISTINCT FROM $2`,
    [escrowId, reason]
  );
  if (rowCount === 1) await enqueueQuarantine(db, escrowId, reason);
}

/** Ends our lease; the next attempt waits `delayMs` (re-score failures back off). */
export async function releaseRescoreLease(
  db: Db,
  escrowId: string,
  token: string,
  delayMs: number,
  refundAttempt = false
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE escrow_accounts
        SET rescore_claimed_at = NULL, rescore_claim_token = NULL,
            next_rescore_at = NOW() + make_interval(secs => $3::double precision / 1000),
            rescore_attempts = GREATEST(rescore_attempts - CASE WHEN $4::boolean THEN 1 ELSE 0 END, 0)
      WHERE escrow_id = $1 AND rescore_claim_token = $2`,
    [escrowId, token, delayMs, refundAttempt]
  );
  return rowCount === 1;
}

/**
 * Quarantines (health endpoint): `awaitingSelfHeal` are fail-safes that can still be re-scored;
 * `stalledQuarantines` never will and need an operator: fail-safes that are security-held, have a
 * non-retryable cause or exhausted their attempts, plus trust quarantines (spec gh-23:
 * trust_below_threshold, trust_input_invalid).
 */
export async function quarantineStats(
  db: Db,
  maxAttempts: number
): Promise<{ awaitingSelfHeal: number; stalledQuarantines: number }> {
  const { rows } = await db.query<{ awaiting: number; stalled: number }>(
    `SELECT count(*) FILTER (WHERE eligible)::int AS awaiting, count(*) FILTER (WHERE NOT eligible)::int AS stalled
       FROM (SELECT COALESCE(lv.is_fail_safe AND NOT e.security_hold AND lv.fail_safe_cause = ANY($1::text[])
                             AND e.rescore_attempts < $2, FALSE) AS eligible
               FROM escrow_accounts e
               JOIN LATERAL (${LATEST_EVENT}) lv ON TRUE
              WHERE e.escrow_status = 'QUARANTINED'
                AND (lv.is_fail_safe OR e.quarantine_reason IN ('trust_below_threshold', 'trust_input_invalid'))) q`,
    [RETRYABLE_FAIL_SAFE_CAUSES, maxAttempts]
  );
  return { awaitingSelfHeal: rows[0]?.awaiting ?? 0, stalledQuarantines: rows[0]?.stalled ?? 0 };
}
