/**
 * @file stk.repository.ts
 * @description SQL for stk_requests — the STK Push initiation record (spec gh-5).
 *
 * Lifecycle: PENDING (claimed before Daraja is called) → ACCEPTED (CheckoutRequestID) |
 * REJECTED (definitive, the customer was not prompted) | UNKNOWN (sent, no definitive answer).
 * A failed STK callback (ResultCode ≠ 0) moves ACCEPTED → FAILED; one that races ahead of the
 * outcome being recorded is kept in stk_failed_callbacks and applied when it is. An UNKNOWN row is
 * bound to its callback by the settlement worker's fallback match (phone HMAC, amount, time
 * window); UNKNOWN / stale PENDING rows no callback can match any more become EXPIRED.
 *
 * Reconciliation (spec gh-6-recon): the STK Query sweep moves an overdue ACCEPTED request to
 * PAID_UNCONFIRMED (paid, callback missing: waits for the statement's receipt), FAILED, or — when
 * its attempts run out — RECONCILE_EXHAUSTED. A failure callback for a PAID_UNCONFIRMED request
 * contradicts the query: it raises STK_STATUS_CONFLICT instead of changing (or parking) anything.
 */

import { STK_TTL_MS, stkClockSkewMs } from '../config/stk';
import { withTransaction, type Db, type TxDb } from './db.types';

export { STK_TTL_MS };

export type StkStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'FAILED'
  | 'EXPIRED'
  | 'PAID_UNCONFIRMED'
  | 'RECONCILE_EXHAUSTED';

/**
 * Statuses a statement-recovered payment may bind to and consume (spec gh-6-recon). Every other
 * unconsumed status still counts toward ambiguity; FAILED / REJECTED matches are conflicts.
 */
export const RECONCILE_BINDABLE: readonly StkStatus[] = ['ACCEPTED', 'PAID_UNCONFIRMED', 'RECONCILE_EXHAUSTED', 'UNKNOWN', 'EXPIRED'];

/**
 * Inside the settlement transaction, for a RECONCILED intake row bound to `stkRequestId`: lock the
 * request and re-check it is still bindable and unconsumed (or consumed by this very receipt).
 */
export async function lockReconciledStk(
  db: Db,
  stkRequestId: string,
  receipt: string
): Promise<'ok' | 'replay' | 'status_changed' | 'missing'> {
  const { rows } = await db.query<{ status: StkStatus; consumed_receipt: string | null }>(
    `SELECT status, consumed_receipt FROM stk_requests WHERE stk_request_id = $1 FOR UPDATE`,
    [stkRequestId]
  );
  const r = rows[0];
  if (!r) return 'missing';
  if (r.consumed_receipt && r.consumed_receipt !== receipt) return 'replay';
  if (!RECONCILE_BINDABLE.includes(r.status)) return 'status_changed';
  return 'ok';
}

/** Serialises everything that touches one CheckoutRequestID (failure callback vs outcome recording). */
const lockCheckout = (db: Db, checkoutRequestId: string) =>
  db.query(`SELECT pg_advisory_xact_lock(hashtextextended('stkco:' || $1, 0))`, [checkoutRequestId]);

export interface StkRow {
  stkRequestId: string;
  agentId: string;
  status: StkStatus;
  checkoutRequestId: string | null;
  amount: string;
  requestFingerprint: string | null;
  responseCode: string | null;
  resultCode: string | null;
  error: string | null;
  customerMessage: string | null;
  /** How long the row has been PENDING (ms), or null when not PENDING. */
  pendingAgeMs: number | null;
}

const COLUMNS = `stk_request_id, agent_id, status, checkout_request_id, amount::text AS amount, request_fingerprint,
  response_code, result_code, error, customer_message,
  CASE WHEN status = 'PENDING' THEN EXTRACT(EPOCH FROM NOW() - COALESCE(claimed_at, created_at)) * 1000 END AS pending_age_ms`;

function toRow(r: any): StkRow {
  return {
    stkRequestId: r.stk_request_id,
    agentId: r.agent_id,
    status: r.status,
    checkoutRequestId: r.checkout_request_id,
    amount: r.amount,
    requestFingerprint: r.request_fingerprint,
    responseCode: r.response_code,
    resultCode: r.result_code,
    error: r.error,
    customerMessage: r.customer_message,
    pendingAgeMs: r.pending_age_ms === null || r.pending_age_ms === undefined ? null : Number(r.pending_age_ms),
  };
}

export interface NewStkRequest {
  agentId: string;
  idempotencyKey: string;
  fingerprint: string;
  phoneHash: string;
  amount: number;
  accountReference: string;
  /** Masked-phone fingerprint (visible prefix/suffix): lets a masked statement phone corroborate it. */
  phoneMaskHash?: string | null;
}

/** Claims the (agent, Idempotency-Key) pair by inserting a PENDING row; null when it already exists. */
export async function claimStkRequest(db: Db, r: NewStkRequest): Promise<StkRow | null> {
  const { rows } = await db.query(
    `INSERT INTO stk_requests (agent_id, idempotency_key, request_fingerprint, phone_hash, amount, account_reference, status, claimed_at,
                               phone_mask_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW(), $7)
     ON CONFLICT ON CONSTRAINT stk_requests_agent_idempotency_key DO NOTHING
     RETURNING ${COLUMNS}`,
    [r.agentId, r.idempotencyKey, r.fingerprint, r.phoneHash, r.amount, r.accountReference, r.phoneMaskHash ?? null]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function findByIdempotencyKey(db: Db, agentId: string, key: string): Promise<StkRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM stk_requests WHERE agent_id = $1 AND idempotency_key = $2`, [agentId, key]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function findStkById(db: Db, stkRequestId: string): Promise<StkRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM stk_requests WHERE stk_request_id = $1`, [stkRequestId]);
  return rows[0] ? toRow(rows[0]) : null;
}

export type RecordedOutcome =
  | { kind: 'ACCEPTED'; checkoutRequestId: string; merchantRequestId: string | null; responseCode: string; customerMessage: string }
  | { kind: 'REJECTED' | 'UNKNOWN'; code: string; message: string };

/**
 * Records Daraja's answer. A row a replay already moved to UNKNOWN (stale PENDING) still takes a
 * later definitive answer; a row bound or consumed meanwhile is never overwritten.
 */
export async function recordStkOutcome(db: TxDb, stkRequestId: string, o: RecordedOutcome): Promise<StkRow | null> {
  const fence = `stk_request_id = $1 AND checkout_request_id IS NULL AND consumed_receipt IS NULL`;
  if (o.kind === 'ACCEPTED') {
    // A failure callback for this CheckoutRequestID may have arrived first: apply it (FAILED).
    return withTransaction(db, async (tx) => {
      await lockCheckout(tx, o.checkoutRequestId);
      const { rows } = await tx.query(
        `WITH f AS (DELETE FROM stk_failed_callbacks WHERE checkout_request_id = $2 RETURNING result_code, result_desc)
         UPDATE stk_requests
            SET status = CASE WHEN EXISTS (SELECT 1 FROM f) THEN 'FAILED' ELSE 'ACCEPTED' END,
                checkout_request_id = $2, merchant_request_id = $3, response_code = $4, customer_message = $5,
                result_code = (SELECT result_code FROM f), error = (SELECT result_desc FROM f), updated_at = NOW()
          WHERE ${fence} AND status IN ('PENDING', 'UNKNOWN')
          RETURNING ${COLUMNS}`,
        [stkRequestId, o.checkoutRequestId, o.merchantRequestId, o.responseCode, o.customerMessage.slice(0, 500)]
      );
      return rows[0] ? toRow(rows[0]) : null;
    });
  }
  const res = await db.query(
    `UPDATE stk_requests
        SET status = $2, response_code = $3, error = $4, updated_at = NOW()
      WHERE ${fence} AND (status = 'PENDING' OR (status = 'UNKNOWN' AND $2 = 'REJECTED'))
      RETURNING ${COLUMNS}`,
    [stkRequestId, o.kind, o.code.slice(0, 40), o.message.slice(0, 500)]
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** A PENDING row older than `olderThanMs` (its Daraja call cannot still be running) becomes UNKNOWN. */
export async function expireStalePending(db: Db, stkRequestId: string, olderThanMs: number): Promise<StkRow | null> {
  const { rows } = await db.query(
    `UPDATE stk_requests SET status = 'UNKNOWN', error = 'no recorded Daraja answer (stale PENDING)', updated_at = NOW()
      WHERE stk_request_id = $1 AND status = 'PENDING'
        AND COALESCE(claimed_at, created_at) < NOW() - make_interval(secs => $2::double precision / 1000)
      RETURNING ${COLUMNS}`,
    [stkRequestId, olderThanMs]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Transaction-scoped lock on (agent, phone, amount): the soft duplicate guard and the claim run
 * under it, so two concurrent requests with different keys cannot both pass the guard.
 */
export async function lockDuplicateGuard(db: Db, agentId: string, phoneHash: string, amount: number): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('stkdup:' || $1, 0))`, [`${agentId}|${phoneHash}|${amount}`]);
}

/** Same agent, phone and amount within the window, under another Idempotency-Key, still live. */
export async function hasRecentDuplicate(
  db: Db,
  q: { agentId: string; phoneHashes: string[]; amount: number; idempotencyKey: string; windowMs: number }
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM stk_requests
      WHERE agent_id = $1 AND phone_hash = ANY($2::text[]) AND amount = $3
        AND idempotency_key IS DISTINCT FROM $4
        AND status IN ('PENDING', 'ACCEPTED', 'UNKNOWN')
        AND created_at > NOW() - make_interval(secs => $5::double precision / 1000)
      LIMIT 1`,
    [q.agentId, q.phoneHashes, q.amount, q.idempotencyKey, q.windowMs]
  );
  return rows.length > 0;
}

/**
 * A completed-but-unsuccessful STK push (callback ResultCode ≠ 0): the matching request becomes
 * FAILED with the code. When no request carries this CheckoutRequestID yet (the callback raced
 * ahead of recording Daraja's answer), the failure is stored and applied by recordStkOutcome.
 * Returns the number of requests updated now.
 */
export async function markStkFailed(db: TxDb, checkoutRequestId: string, resultCode: string, resultDesc: string): Promise<number> {
  return withTransaction(db, async (tx) => {
    await lockCheckout(tx, checkoutRequestId);
    // The STK Query sweep said this request was paid: a failure callback contradicts it. Raise
    // STK_STATUS_CONFLICT for review; the status stays PAID_UNCONFIRMED and nothing is parked.
    const { rows: paid } = await tx.query<{ stk_request_id: string }>(
      `SELECT stk_request_id FROM stk_requests
        WHERE checkout_request_id = $1 AND status = 'PAID_UNCONFIRMED' AND consumed_receipt IS NULL
        FOR UPDATE`,
      [checkoutRequestId]
    );
    if (paid[0]?.stk_request_id) {
      console.error(`[SECURITY ALARM] failure callback (ResultCode ${resultCode}) for an STK request the STK Query reported paid`);
      await tx.query(
        `INSERT INTO security_events (event_type, stk_request_id, incoming_hash, detail)
         VALUES ('STK_STATUS_CONFLICT', $1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [paid[0].stk_request_id, `result:${resultCode}`, `failure callback ResultCode ${resultCode} for a PAID_UNCONFIRMED request`]
      );
      return 1;
    }
    const { rowCount } = await tx.query(
      `UPDATE stk_requests SET status = 'FAILED', result_code = $2, error = $3, updated_at = NOW()
        WHERE checkout_request_id = $1 AND consumed_receipt IS NULL
          AND status IN ('ACCEPTED', 'UNKNOWN', 'PENDING', 'FAILED', 'RECONCILE_EXHAUSTED')`,
      [checkoutRequestId, resultCode, resultDesc || null]
    );
    if (!rowCount) {
      await tx.query(
        `INSERT INTO stk_failed_callbacks (checkout_request_id, result_code, result_desc) VALUES ($1, $2, $3)
         ON CONFLICT (checkout_request_id) DO UPDATE SET result_code = EXCLUDED.result_code, result_desc = EXCLUDED.result_desc`,
        [checkoutRequestId, resultCode, resultDesc || null]
      );
    }
    return rowCount ?? 0;
  });
}

/**
 * Housekeeping: UNKNOWN / stale PENDING requests older than `olderThanMs` (no callback can match
 * them any more) become EXPIRED — final, and out of the duplicate guard and the fallback. Stored
 * failure callbacks that never found their request are dropped after a day.
 */
export async function expireOpenRequests(db: Db, olderThanMs: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests SET status = 'EXPIRED', updated_at = NOW(),
            error = COALESCE(error || ' | ', '') || 'expired: no callback matched'
      WHERE status IN ('UNKNOWN', 'PENDING') AND checkout_request_id IS NULL AND consumed_receipt IS NULL
        AND created_at < NOW() - make_interval(secs => $1::double precision / 1000)`,
    [olderThanMs]
  );
  await db.query(`DELETE FROM stk_failed_callbacks WHERE received_at < NOW() - interval '1 day'`);
  return rowCount ?? 0;
}

// ── Fallback match (settlement worker) ──────────────────────────────────────

export interface FallbackCandidate {
  stkRequestId: string;
  agentId: string;
  status: 'UNKNOWN' | 'PENDING';
}

const FALLBACK_WHERE = `
  phone_hash = ANY($1::text[]) AND amount = $2
  AND checkout_request_id IS NULL AND consumed_receipt IS NULL
  AND status IN ('UNKNOWN', 'PENDING')
  AND date_trunc('second', created_at) <= $3::timestamptz + make_interval(secs => $5::double precision / 1000)
  AND created_at >= $3::timestamptz - make_interval(secs => $4::double precision / 1000)`;

/** UNKNOWN / PENDING requests that could have produced a callback (phone, amount, payment time). */
export async function findFallbackCandidates(
  db: Db,
  q: { phoneHashes: string[]; amount: string; at: Date; ttlMs?: number },
  forUpdate = false
): Promise<FallbackCandidate[]> {
  const { rows } = await db.query(
    `SELECT stk_request_id, agent_id, status FROM stk_requests WHERE ${FALLBACK_WHERE}
      ORDER BY created_at${forUpdate ? ' FOR UPDATE' : ''}`,
    [q.phoneHashes, q.amount, q.at.toISOString(), q.ttlMs ?? STK_TTL_MS, stkClockSkewMs()]
  );
  return rows.map((r) => ({ stkRequestId: r.stk_request_id, agentId: r.agent_id, status: r.status }));
}

/**
 * Inside the settlement transaction: re-select the candidates FOR UPDATE, re-count, and bind the
 * CheckoutRequestID only if exactly the expected UNKNOWN row still fits (and nothing PENDING
 * does). Any ambiguity returns false (fail closed).
 */
export async function bindFallback(
  db: Db,
  q: { phoneHashes: string[]; amount: string; at: Date; stkRequestId: string; checkoutRequestId: string }
): Promise<boolean> {
  const now = await findFallbackCandidates(db, q, true);
  if (now.length !== 1 || now[0].status !== 'UNKNOWN' || now[0].stkRequestId !== q.stkRequestId) return false;
  const { rowCount } = await db.query(
    `UPDATE stk_requests
        SET checkout_request_id = $2, status = 'ACCEPTED', fallback_bound_at = NOW(), updated_at = NOW()
      WHERE stk_request_id = $1 AND checkout_request_id IS NULL AND consumed_receipt IS NULL AND status = 'UNKNOWN'`,
    [q.stkRequestId, q.checkoutRequestId]
  );
  return rowCount === 1;
}
