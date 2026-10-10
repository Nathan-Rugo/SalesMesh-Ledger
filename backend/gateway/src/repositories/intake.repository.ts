/**
 * @file intake.repository.ts
 * @description SQL for mpesa_callbacks — the durable intake queue (spec gh-6, B5).
 *
 * Lease fencing: every claim sets a fresh claim_token and every status write is fenced on
 * (callback_id, claim_token, status = 'PROCESSING'). A worker whose lease was reclaimed after
 * the visibility timeout therefore cannot overwrite the new owner's outcome.
 */

import { checkoutRequestIdOf, extractIngress, type SourceChannel } from '../domain/callback';
import type { Db } from './db.types';

export type IntakeStatus = 'PENDING' | 'PROCESSING' | 'UNRESOLVED' | 'SETTLED' | 'FAILED' | 'DEAD';

/** CALLBACK: delivered by Daraja. RECONCILED: synthesised from an M-Pesa statement (spec gh-6-recon). */
export type IntakeOrigin = 'CALLBACK' | 'RECONCILED';

export interface IntakeRow {
  callback_id: string;
  mpesa_receipt_id: string;
  raw_payload_hash: string;
  source_channel: SourceChannel;
  payload: unknown;
  status: IntakeStatus;
  attempts: number;
  resolve_attempts: number;
  claim_token: string;
  received_at: Date;
  /** Absent on rows built by older code paths / tests: treated as CALLBACK. */
  origin?: IntakeOrigin;
}

export interface NewIntake {
  receipt: string;
  hash: string;
  channel: SourceChannel;
  payload: unknown; // already redacted
  receivedAt?: Date;
  /** Reconciliation (spec gh-6-recon): a statement-recovered row and its run / bound STK request. */
  origin?: IntakeOrigin;
  reconciliationRunId?: string | null;
  stkRequestId?: string | null;
}

export type InsertOutcome = { outcome: 'inserted'; callbackId: string } | { outcome: 'existing'; storedHash: string };

/** Inserts the intake row; on a receipt conflict returns the hash already stored (Postgres is the dedup truth). */
export async function insertIntake(db: Db, row: NewIntake): Promise<InsertOutcome> {
  const { rows } = await db.query<{ callback_id: string }>(
    `INSERT INTO mpesa_callbacks (mpesa_receipt_id, raw_payload_hash, source_channel, payload, received_at,
                                  checkout_request_id, origin, reconciliation_run_id, stk_request_id)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, NOW()), $6, $7, $8, $9)
     ON CONFLICT (mpesa_receipt_id) DO NOTHING
     RETURNING callback_id`,
    [
      row.receipt,
      row.hash,
      row.channel,
      JSON.stringify(row.payload),
      row.receivedAt?.toISOString() ?? null,
      row.channel === 'DARAJA_STK' ? checkoutRequestIdOf(row.payload) : null,
      row.origin ?? 'CALLBACK',
      row.reconciliationRunId ?? null,
      row.stkRequestId ?? null,
    ]
  );
  if (rows[0]?.callback_id) return { outcome: 'inserted', callbackId: rows[0].callback_id };
  // New statement → new snapshot: sees a concurrent insert that just committed.
  const existing = await db.query<{ raw_payload_hash: string }>(
    'SELECT raw_payload_hash FROM mpesa_callbacks WHERE mpesa_receipt_id = $1',
    [row.receipt]
  );
  if (!existing.rows[0]) throw new Error('intake conflict without a visible row');
  return { outcome: 'existing', storedHash: existing.rows[0].raw_payload_hash };
}

/** Channel and amount of the stored intake row for a receipt (cross-channel echo check), or null. */
export async function findIntakeSummary(db: Db, receipt: string): Promise<{ channel: SourceChannel; amountCents: number | null } | null> {
  const { rows } = await db.query<{ source_channel: SourceChannel; payload: unknown }>(
    'SELECT source_channel, payload FROM mpesa_callbacks WHERE mpesa_receipt_id = $1',
    [receipt]
  );
  const r = rows[0];
  if (!r || (r.source_channel !== 'DARAJA_STK' && r.source_channel !== 'C2B')) return null;
  const ingress = extractIngress(r.payload);
  return { channel: r.source_channel, amountCents: ingress.kind === 'ok' ? ingress.amountCents : null };
}

/** What a late genuine callback is compared against when its receipt was recovered from a statement. */
export interface StoredIntakeIdentity {
  origin: IntakeOrigin;
  channel: SourceChannel;
  payload: unknown;
  rawPayloadHash: string;
  checkoutRequestId: string | null;
  stkRequestId: string | null;
  confirmedHash: string | null;
}

export async function findStoredIdentity(db: Db, receipt: string): Promise<StoredIntakeIdentity | null> {
  const { rows } = await db.query(
    `SELECT origin, source_channel, payload, raw_payload_hash, checkout_request_id, stk_request_id, confirmed_hash
       FROM mpesa_callbacks WHERE mpesa_receipt_id = $1`,
    [receipt]
  );
  const r = rows[0];
  if (!r || !r.origin) return null;
  return {
    origin: r.origin,
    channel: r.source_channel,
    payload: r.payload,
    rawPayloadHash: r.raw_payload_hash,
    checkoutRequestId: r.checkout_request_id ?? null,
    stkRequestId: r.stk_request_id ?? null,
    confirmedHash: r.confirmed_hash ?? null,
  };
}

/**
 * Inside a transaction: a genuine callback matched a statement-recovered (RECONCILED) receipt.
 * Locks the row and confirms it with the callback's hash unless another delivery confirmed it
 * first. Returns the confirmed hash now stored — the caller's own hash only if it won. Never
 * touches escrow or settlement state.
 */
export async function confirmReconciledByCallback(db: Db, receipt: string, incomingHash: string): Promise<string | null> {
  const { rows } = await db.query<{ confirmed_hash: string | null }>(
    `SELECT confirmed_hash FROM mpesa_callbacks WHERE mpesa_receipt_id = $1 AND origin = 'RECONCILED' FOR UPDATE`,
    [receipt]
  );
  if (!rows[0]) return null;
  if (rows[0].confirmed_hash) return rows[0].confirmed_hash;
  await db.query(
    `UPDATE mpesa_callbacks SET confirmed_by_callback_at = NOW(), confirmed_hash = $2, updated_at = NOW()
      WHERE mpesa_receipt_id = $1 AND confirmed_hash IS NULL`,
    [receipt, incomingHash]
  );
  return incomingHash;
}

/** A recovered row that was unbound (ambiguous import) is bound to the request its genuine callback proved. */
export async function bindReconciledRow(db: Db, receipt: string, stkRequestId: string): Promise<void> {
  await db.query(`UPDATE mpesa_callbacks SET stk_request_id = $2, updated_at = NOW() WHERE mpesa_receipt_id = $1 AND stk_request_id IS NULL`, [receipt, stkRequestId]);
}

/**
 * Same receipt, same amount, different channel: one payment Safaricom delivered as both an STK
 * callback and a C2B confirmation. An echo, not a payload mutation.
 */
export function isChannelEcho(
  stored: { channel: SourceChannel; amountCents: number | null } | null,
  incoming: { channel: SourceChannel; amountCents: number }
): boolean {
  return !!stored && stored.channel !== incoming.channel && stored.amountCents === incoming.amountCents;
}

/**
 * Atomic claim: PENDING/UNRESOLVED rows whose backoff elapsed, plus PROCESSING rows whose
 * lease expired (a crashed claimer) that still have attempts left.
 */
export async function claimBatch(db: Db, limit: number, visibilityMs: number, maxAttempts: number): Promise<IntakeRow[]> {
  const { rows } = await db.query<IntakeRow>(
    `UPDATE mpesa_callbacks
        SET status = 'PROCESSING', attempts = attempts + 1, claimed_at = NOW(),
            claim_token = gen_random_uuid(), updated_at = NOW()
      WHERE callback_id IN (
            SELECT callback_id FROM mpesa_callbacks
             WHERE (status IN ('PENDING', 'UNRESOLVED') AND next_attempt_at <= NOW())
                OR (status = 'PROCESSING' AND claimed_at < NOW() - make_interval(secs => $2::double precision / 1000)
                    AND attempts < $3)
             ORDER BY received_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED)
      RETURNING callback_id, mpesa_receipt_id, raw_payload_hash, source_channel, payload, status,
                attempts, resolve_attempts, claim_token, received_at, origin`,
    [limit, visibilityMs, maxAttempts]
  );
  return rows;
}

/** Stale PROCESSING rows that exhausted their attempts go to DEAD (terminal, requeue-able). */
export async function sweepDead(db: Db, visibilityMs: number, maxAttempts: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE mpesa_callbacks
        SET status = 'DEAD', claim_token = NULL, updated_at = NOW(),
            last_error = COALESCE(last_error || ' | ', '') || 'lease expired with attempts exhausted'
      WHERE status = 'PROCESSING' AND attempts >= $2
        AND claimed_at < NOW() - make_interval(secs => $1::double precision / 1000)`,
    [visibilityMs, maxAttempts]
  );
  return rowCount ?? 0;
}

/** Locks our claimed row inside a transaction; false when the lease was lost. */
export async function lockClaimed(db: Db, callbackId: string, token: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM mpesa_callbacks
      WHERE callback_id = $1 AND claim_token = $2 AND status = 'PROCESSING'
      FOR UPDATE`,
    [callbackId, token]
  );
  return rows.length === 1;
}

const FENCE = `callback_id = $1 AND claim_token = $2 AND status = 'PROCESSING'`;

export async function markSettled(db: Db, callbackId: string, token: string, transactionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mpesa_callbacks
        SET status = 'SETTLED', transaction_id = $3, claim_token = NULL, last_error = NULL, updated_at = NOW()
      WHERE ${FENCE}`,
    [callbackId, token, transactionId]
  );
  return rowCount === 1;
}

/** Transient failure: back to PENDING after an exponential backoff. */
export async function markRetry(db: Db, callbackId: string, token: string, delayMs: number, error: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mpesa_callbacks
        SET status = 'PENDING', next_attempt_at = NOW() + make_interval(secs => $3::double precision / 1000),
            claim_token = NULL, claimed_at = NULL, last_error = $4, updated_at = NOW()
      WHERE ${FENCE}`,
    [callbackId, token, delayMs, error.slice(0, 2000)]
  );
  return rowCount === 1;
}

/** Terminal failure (parse/validation error, or retries exhausted). */
export async function markFailed(db: Db, callbackId: string, token: string, error: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mpesa_callbacks
        SET status = 'FAILED', claim_token = NULL, last_error = $3, updated_at = NOW()
      WHERE ${FENCE}`,
    [callbackId, token, error.slice(0, 2000)]
  );
  return rowCount === 1;
}

/**
 * Agent resolution failed. Retryable reasons back off (base·2^n, capped) until the resolution
 * window closes; then — or immediately for inconsistent callbacks — the row stays UNRESOLVED
 * for review (next_attempt_at = 'infinity'). Never creates a transaction.
 */
export async function markUnresolved(
  db: Db,
  callbackId: string,
  token: string,
  reason: string,
  opts: { terminal: boolean; windowMs: number; baseDelayMs: number; maxDelayMs: number }
): Promise<{ updated: boolean; terminal: boolean }> {
  const { rows } = await db.query<{ terminal: boolean }>(
    `WITH cfg AS (
       SELECT COALESCE(resolve_deadline, NOW() + make_interval(secs => $4::double precision / 1000)) AS deadline,
              make_interval(secs => LEAST($5::double precision * power(2, LEAST(resolve_attempts, 30)), $6::double precision) / 1000) AS delay
         FROM mpesa_callbacks WHERE callback_id = $1)
     UPDATE mpesa_callbacks m
        SET status = 'UNRESOLVED', attempts = 0, resolve_attempts = resolve_attempts + 1,
            resolve_deadline = cfg.deadline,
            next_attempt_at = CASE WHEN $7::boolean OR NOW() + cfg.delay >= cfg.deadline
                                   THEN 'infinity'::timestamptz ELSE NOW() + cfg.delay END,
            claim_token = NULL, claimed_at = NULL, last_error = $3, updated_at = NOW()
       FROM cfg
      WHERE m.callback_id = $1 AND m.claim_token = $2 AND m.status = 'PROCESSING'
      RETURNING (m.next_attempt_at = 'infinity'::timestamptz) AS terminal`,
    [callbackId, token, reason.slice(0, 2000), opts.windowMs, opts.baseDelayMs, opts.maxDelayMs, opts.terminal]
  );
  return { updated: rows.length === 1, terminal: rows[0]?.terminal ?? false };
}

export interface QueueStats {
  depth: number;
  pending: number;
  processing: number;
  oldestPendingAgeSeconds: number | null;
  unresolved: number;
  failed: number;
  dead: number;
}

export async function queueStats(db: Db): Promise<QueueStats> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
            EXTRACT(EPOCH FROM NOW() - min(received_at) FILTER (WHERE status = 'PENDING'))::double precision AS oldest,
            count(*) FILTER (WHERE status = 'UNRESOLVED')::int AS unresolved,
            count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            count(*) FILTER (WHERE status = 'DEAD')::int AS dead
       FROM mpesa_callbacks WHERE status <> 'SETTLED'`
  );
  const r = rows[0] ?? {};
  return {
    depth: (r.pending ?? 0) + (r.processing ?? 0),
    pending: r.pending ?? 0,
    processing: r.processing ?? 0,
    oldestPendingAgeSeconds: r.oldest === null || r.oldest === undefined ? null : Number(r.oldest),
    unresolved: r.unresolved ?? 0,
    failed: r.failed ?? 0,
    dead: r.dead ?? 0,
  };
}

export const REQUEUEABLE: readonly IntakeStatus[] = ['UNRESOLVED', 'FAILED', 'DEAD'];

/** Puts UNRESOLVED/FAILED/DEAD rows back to PENDING with fresh counters (requeue CLI). */
export async function requeue(
  db: Db,
  filter: { statuses: IntakeStatus[]; receipts: string[]; dryRun: boolean }
): Promise<Array<{ mpesa_receipt_id: string; status: string }>> {
  const statuses = filter.statuses.filter((s) => REQUEUEABLE.includes(s));
  const where = `status = ANY($1::text[]) AND (cardinality($2::text[]) = 0 OR mpesa_receipt_id = ANY($2::text[]))`;
  const params = [statuses.length ? statuses : [...REQUEUEABLE], filter.receipts];
  if (filter.dryRun) {
    const { rows } = await db.query(`SELECT mpesa_receipt_id, status FROM mpesa_callbacks WHERE ${where} ORDER BY received_at`, params);
    return rows;
  }
  const { rows } = await db.query(
    `UPDATE mpesa_callbacks
        SET status = 'PENDING', attempts = 0, resolve_attempts = 0, resolve_deadline = NULL,
            next_attempt_at = NOW(), claim_token = NULL, claimed_at = NULL, updated_at = NOW(),
            last_error = COALESCE(last_error, '') || ' [requeued ' || to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || ']'
      WHERE ${where}
      RETURNING mpesa_receipt_id, status`,
    params
  );
  return rows;
}
