/**
 * @file reconcile.repository.ts
 * @description SQL for Daraja reconciliation (spec gh-6-recon).
 *
 * STK Query sweep — the re-score worker's lease pattern on stk_requests: candidates are ACCEPTED,
 * unconsumed, overdue (older than STK_TTL + grace), newer than RECONCILE_MAX_AGE, with no intake
 * row carrying their CheckoutRequestID; claims take a fresh reconcile_claim_token under SKIP
 * LOCKED and every outcome write is fenced on it (and re-checks that no callback won the race).
 *
 * Statement import — run records, binding candidates for a statement row, known-receipt lookups,
 * two-way reconciliation and exception records. No raw MSISDN or payer name ever reaches SQL.
 */

import type { Db } from './db.types';
import type { StkStatus } from './stk.repository';

// ── STK Query sweep ──────────────────────────────────────────────────────────

export interface ReconcileClaim {
  stkRequestId: string;
  checkoutRequestId: string;
  token: string;
  /** Attempts including this claim. */
  attempts: number;
}

/** No intake row (callback or recovered) carries this request yet. */
const NO_INTAKE = `NOT EXISTS (SELECT 1 FROM mpesa_callbacks m
                     WHERE m.checkout_request_id = s.checkout_request_id OR m.stk_request_id = s.stk_request_id)`;

export async function claimReconcileBatch(
  db: Db,
  q: { limit: number; overdueMs: number; maxAgeMs: number; maxAttempts: number; leaseMs: number }
): Promise<ReconcileClaim[]> {
  const { rows } = await db.query(
    `UPDATE stk_requests c
        SET reconcile_claimed_at = NOW(), reconcile_claim_token = gen_random_uuid(),
            reconcile_attempts = c.reconcile_attempts + 1
      WHERE c.stk_request_id IN (
            SELECT s.stk_request_id FROM stk_requests s
             WHERE s.status = 'ACCEPTED' AND s.consumed_receipt IS NULL AND s.checkout_request_id IS NOT NULL
               AND s.created_at < NOW() - make_interval(secs => $2::double precision / 1000)
               AND s.created_at > NOW() - make_interval(secs => $3::double precision / 1000)
               AND COALESCE(s.next_reconcile_at, '-infinity'::timestamptz) <= NOW()
               AND s.reconcile_attempts < $4
               AND (s.reconcile_claimed_at IS NULL
                    OR s.reconcile_claimed_at < NOW() - make_interval(secs => $5::double precision / 1000))
               AND ${NO_INTAKE}
             ORDER BY s.created_at
             LIMIT $1
             FOR UPDATE OF s SKIP LOCKED)
      RETURNING c.stk_request_id, c.checkout_request_id, c.reconcile_claim_token, c.reconcile_attempts`,
    [q.limit, q.overdueMs, q.maxAgeMs, q.maxAttempts, q.leaseMs]
  );
  return rows.map((r) => ({
    stkRequestId: r.stk_request_id,
    checkoutRequestId: r.checkout_request_id,
    token: r.reconcile_claim_token,
    attempts: Number(r.reconcile_attempts),
  }));
}

/** True when an intake row belongs to this request — by CheckoutRequestID or bound id (the claim predicate). */
export async function intakeExistsForRequest(db: Db, claim: Pick<ReconcileClaim, 'checkoutRequestId' | 'stkRequestId'>): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM mpesa_callbacks WHERE checkout_request_id = $1 OR stk_request_id = $2 LIMIT 1`,
    [claim.checkoutRequestId, claim.stkRequestId]
  );
  return rows.length > 0;
}

const FENCE = `s.stk_request_id = $1 AND s.reconcile_claim_token = $2 AND s.status = 'ACCEPTED'
               AND s.consumed_receipt IS NULL AND ${NO_INTAKE}`;

/** Query said paid (ResultCode 0): PAID_UNCONFIRMED, waiting for the statement's receipt. */
export async function markPaidUnconfirmed(db: Db, claim: ReconcileClaim, evidence: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests s
        SET status = 'PAID_UNCONFIRMED', last_query_result = $3, last_queried_at = NOW(),
            reconcile_claimed_at = NULL, reconcile_claim_token = NULL, next_reconcile_at = NULL, updated_at = NOW()
      WHERE ${FENCE}`,
    [claim.stkRequestId, claim.token, evidence.slice(0, 500)]
  );
  return rowCount === 1;
}

/** Query gave a definitive failure (1032 cancelled, 1037 timeout, 2001 wrong PIN, 1 insufficient funds, ...). */
export async function markQueryFailed(db: Db, claim: ReconcileClaim, resultCode: string, resultDesc: string, evidence: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests s
        SET status = 'FAILED', result_code = $3, error = $4, last_query_result = $5, last_queried_at = NOW(),
            reconcile_claimed_at = NULL, reconcile_claim_token = NULL, next_reconcile_at = NULL, updated_at = NOW()
      WHERE ${FENCE}`,
    [claim.stkRequestId, claim.token, resultCode.slice(0, 20), resultDesc.slice(0, 500) || null, evidence.slice(0, 500)]
  );
  return rowCount === 1;
}

/**
 * Ends our lease without a definitive answer: retry after `delayMs`. `refund` gives the attempt
 * back (throttled, or never sent); `exhaust` moves the request to RECONCILE_EXHAUSTED.
 */
export async function releaseReconcileLease(
  db: Db,
  claim: ReconcileClaim,
  o: { delayMs: number; refund?: boolean; exhaust?: boolean; evidence?: string | null; queried?: boolean }
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests
        SET reconcile_claimed_at = NULL, reconcile_claim_token = NULL,
            next_reconcile_at = NOW() + make_interval(secs => $3::double precision / 1000),
            reconcile_attempts = GREATEST(reconcile_attempts - CASE WHEN $4::boolean THEN 1 ELSE 0 END, 0),
            status = CASE WHEN $5::boolean AND status = 'ACCEPTED' THEN 'RECONCILE_EXHAUSTED' ELSE status END,
            last_query_result = COALESCE($6, last_query_result),
            last_queried_at = CASE WHEN $7::boolean THEN NOW() ELSE last_queried_at END,
            updated_at = NOW()
      WHERE stk_request_id = $1 AND reconcile_claim_token = $2`,
    [claim.stkRequestId, claim.token, Math.max(0, o.delayMs), o.refund ?? false, o.exhaust ?? false, o.evidence?.slice(0, 500) ?? null, o.queried ?? false]
  );
  return rowCount === 1;
}

/** A crashed sweeper's last attempt: lease expired with the attempts exhausted → RECONCILE_EXHAUSTED. */
export async function sweepExhaustedLeases(db: Db, leaseMs: number, maxAttempts: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests
        SET status = 'RECONCILE_EXHAUSTED', reconcile_claimed_at = NULL, reconcile_claim_token = NULL, updated_at = NOW()
      WHERE status = 'ACCEPTED' AND consumed_receipt IS NULL AND reconcile_attempts >= $2
        AND (reconcile_claimed_at IS NULL OR reconcile_claimed_at < NOW() - make_interval(secs => $1::double precision / 1000))`,
    [leaseMs, maxAttempts]
  );
  return rowCount ?? 0;
}

export interface ReconcileStats {
  paidUnconfirmed: number;
  exhausted: number;
  overdueAccepted: number;
  oldestOverdueAcceptedAgeSeconds: number | null;
  lastImportAt: string | null;
  /** Open reconciliation_exceptions by kind (CLAWBACK_DUE, RELEASED_NOT_ON_STATEMENT). */
  openExceptions: Record<string, number>;
  /** The latest non-dry-run import (a FAILED or still RUNNING one needs an operator). */
  latestRun: { status: string; startedAt: string; finishedAt: string | null } | null;
}

/** /health/details: the "state limbo" register. Only unconsumed requests count. */
export async function reconcileStats(db: Db, overdueMs: number): Promise<ReconcileStats> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'PAID_UNCONFIRMED')::int AS paid_unconfirmed,
            count(*) FILTER (WHERE status = 'RECONCILE_EXHAUSTED')::int AS exhausted,
            count(*) FILTER (WHERE status = 'ACCEPTED'
                               AND created_at < NOW() - make_interval(secs => $1::double precision / 1000))::int AS overdue,
            EXTRACT(EPOCH FROM NOW() - min(created_at) FILTER (
              WHERE status = 'ACCEPTED' AND created_at < NOW() - make_interval(secs => $1::double precision / 1000)))::double precision AS oldest,
            (SELECT max(finished_at) FROM reconciliation_runs WHERE status = 'COMPLETED' AND NOT dry_run) AS last_import
       FROM stk_requests
      WHERE consumed_receipt IS NULL AND status IN ('PAID_UNCONFIRMED', 'RECONCILE_EXHAUSTED', 'ACCEPTED')`,
    [overdueMs]
  );
  const r = rows[0] ?? {};
  const { rows: ex } = await db.query<{ kind: string; n: number }>(
    `SELECT kind, count(*)::int AS n FROM reconciliation_exceptions WHERE resolved_at IS NULL GROUP BY kind`
  );
  const { rows: runs } = await db.query(
    `SELECT status, started_at, finished_at FROM reconciliation_runs WHERE NOT dry_run ORDER BY started_at DESC LIMIT 1`
  );
  const run = runs[0]?.status ? runs[0] : null;
  return {
    openExceptions: Object.fromEntries(ex.filter((e) => e.kind).map((e) => [e.kind, Number(e.n)])),
    latestRun: run
      ? { status: run.status, startedAt: new Date(run.started_at).toISOString(), finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null }
      : null,
    paidUnconfirmed: r.paid_unconfirmed ?? 0,
    exhausted: r.exhausted ?? 0,
    overdueAccepted: r.overdue ?? 0,
    oldestOverdueAcceptedAgeSeconds: r.oldest === null || r.oldest === undefined ? null : Number(r.oldest),
    lastImportAt: r.last_import ? new Date(r.last_import).toISOString() : null,
  };
}

// ── Statement import ─────────────────────────────────────────────────────────

/** An active MERCHANT_ADMIN by user_id or normalised phone, or why not. */
export async function findOperator(
  db: Db,
  ref: { userId?: string; phone?: string }
): Promise<{ userId: string; role: string; disabled: boolean } | null> {
  const { rows } = await db.query(
    `SELECT user_id, role, disabled_at IS NOT NULL AS disabled FROM users
      WHERE ($1::uuid IS NOT NULL AND user_id = $1::uuid) OR ($2::text IS NOT NULL AND phone_number = $2)
      LIMIT 1`,
    [ref.userId ?? null, ref.phone ?? null]
  );
  const r = rows[0];
  return r ? { userId: r.user_id, role: r.role, disabled: r.disabled === true } : null;
}

const IMPORT_LOCK_KEY = 'salesmesh:reconcile-import';

/** Session advisory lock: one importer at a time (held on `client` until released). */
export async function tryImportLock(client: Db): Promise<boolean> {
  const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [IMPORT_LOCK_KEY]);
  return rows[0]?.ok === true;
}

export async function releaseImportLock(client: Db): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [IMPORT_LOCK_KEY]);
}

export async function findCompletedRun(db: Db, sha256: string): Promise<{ runId: string } | null> {
  const { rows } = await db.query(
    `SELECT run_id FROM reconciliation_runs WHERE file_sha256 = $1 AND status = 'COMPLETED' AND NOT dry_run AND noop_of_run_id IS NULL
      ORDER BY finished_at LIMIT 1`,
    [sha256]
  );
  return rows[0] ? { runId: rows[0].run_id } : null;
}

/** RUNNING runs (of any file) left by a crashed importer become FAILED — we hold the global import lock. */
export async function failAbandonedRuns(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE reconciliation_runs SET status = 'FAILED', finished_at = NOW(),
            error = COALESCE(error || ' | ', '') || 'abandoned: importer stopped before completing'
      WHERE status = 'RUNNING'`
  );
  return rowCount ?? 0;
}

export interface NewRun {
  sha256: string;
  fileName: string;
  operatorUserId: string;
  dryRun: boolean;
  status: 'RUNNING' | 'COMPLETED';
  shortCode: string | null;
  account: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  rowsTotal: number;
  noopOfRunId?: string | null;
  counts?: Record<string, unknown>;
}

export async function insertRun(db: Db, r: NewRun): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO reconciliation_runs (file_sha256, file_name, operator_user_id, dry_run, status, short_code, account,
                                      period_start, period_end, rows_total, noop_of_run_id, counts, finished_at)
     VALUES ($1, $2, $3, $4, $5::text, $6, $7, $8, $9, $10, $11, $12::jsonb, CASE WHEN $5::text = 'COMPLETED' THEN NOW() END)
     RETURNING run_id`,
    [
      r.sha256,
      r.fileName.slice(0, 255),
      r.operatorUserId,
      r.dryRun,
      r.status,
      r.shortCode,
      r.account?.slice(0, 100) ?? null,
      r.periodStart?.toISOString() ?? null,
      r.periodEnd?.toISOString() ?? null,
      r.rowsTotal,
      r.noopOfRunId ?? null,
      JSON.stringify(r.counts ?? {}),
    ]
  );
  return rows[0].run_id;
}

export async function setRunEvidence(db: Db, runId: string, evidencePath: string): Promise<void> {
  await db.query(`UPDATE reconciliation_runs SET evidence_path = $2 WHERE run_id = $1`, [runId, evidencePath]);
}

export async function finishRun(
  db: Db,
  runId: string,
  o: { status: 'COMPLETED' | 'FAILED'; rowsNew: number; counts: Record<string, unknown>; error?: string | null }
): Promise<void> {
  await db.query(
    `UPDATE reconciliation_runs SET status = $2, rows_new = $3, counts = $4::jsonb, error = $5, finished_at = NOW()
      WHERE run_id = $1`,
    [runId, o.status, o.rowsNew, JSON.stringify(o.counts), o.error?.slice(0, 2000) ?? null]
  );
}

/** Receipts of `receipts` already known (intake or transactions). */
export async function knownReceipts(db: Db, receipts: string[]): Promise<Set<string>> {
  if (receipts.length === 0) return new Set();
  const { rows } = await db.query<{ r: string }>(
    `SELECT mpesa_receipt_id AS r FROM mpesa_callbacks WHERE mpesa_receipt_id = ANY($1::text[])
     UNION SELECT mpesa_receipt_id FROM transactions WHERE mpesa_receipt_id = ANY($1::text[])`,
    [receipts]
  );
  return new Set(rows.map((x) => x.r));
}

export interface KnownReceipt {
  inIntake: boolean;
  origin: 'CALLBACK' | 'RECONCILED' | null;
  channel: string | null;
  payload: unknown;
  receivedAt: Date | null;
  /** The STK request the intake row belongs to (CheckoutRequestID or bound id), for its account reference. */
  stkAccountReference: string | null;
  txAmount: string | null;
  txTime: Date | null;
  txAgentCode: string | null;
}

/** What we already hold for a receipt (to verify a statement row against), or null when unknown. */
export async function findKnownReceipt(db: Db, receipt: string): Promise<KnownReceipt | null> {
  const { rows } = await db.query(
    `SELECT m.mpesa_receipt_id IS NOT NULL AS in_intake, m.origin, m.source_channel, m.payload, m.received_at,
            (SELECT s.account_reference FROM stk_requests s
              WHERE (m.checkout_request_id IS NOT NULL AND s.checkout_request_id = m.checkout_request_id)
                 OR (m.stk_request_id IS NOT NULL AND s.stk_request_id = m.stk_request_id)
              LIMIT 1) AS stk_account_reference,
            t.amount::text AS tx_amount, t.timestamp AS tx_time, a.agent_code AS tx_agent_code
       FROM (SELECT $1::text AS receipt) k
       LEFT JOIN mpesa_callbacks m ON m.mpesa_receipt_id = k.receipt
       LEFT JOIN transactions t ON t.mpesa_receipt_id = k.receipt
       LEFT JOIN sales_agents a ON a.agent_id = t.agent_id
      WHERE m.mpesa_receipt_id IS NOT NULL OR t.mpesa_receipt_id IS NOT NULL`,
    [receipt]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    inIntake: r.in_intake === true,
    origin: r.origin ?? null,
    channel: r.source_channel ?? null,
    payload: r.payload ?? null,
    receivedAt: r.received_at ? new Date(r.received_at) : null,
    stkAccountReference: r.stk_account_reference ?? null,
    txAmount: r.tx_amount ?? null,
    txTime: r.tx_time ? new Date(r.tx_time) : null,
    txAgentCode: r.tx_agent_code ?? null,
  };
}

export interface BindingCandidate {
  stkRequestId: string;
  agentId: string;
  status: StkStatus;
  checkoutRequestId: string | null;
  /** An intake row (a genuine callback, or an earlier recovered row) already belongs to this request. */
  hasIntake: boolean;
}

/**
 * Every unconsumed STK request (any status) a statement row could be: agent_code = A/C No., the
 * amount, `created_at - skew <= Initiation Time <= created_at + STK_TTL + skew`, and the phone —
 * the counterparty HMAC for a full phone, the masked-phone fingerprint for a masked one (a request
 * without a fingerprint never matches a masked phone). `forUpdate` locks the rows (binding).
 */
export async function findBindingCandidates(
  db: Db,
  q: {
    agentCode: string;
    amount: string;
    initiatedAt: Date;
    ttlMs: number;
    skewMs: number;
    phoneHashes: string[] | null;
    maskHashes: string[] | null;
  },
  forUpdate = false
): Promise<BindingCandidate[]> {
  const { rows } = await db.query(
    `SELECT s.stk_request_id, s.agent_id, s.status, s.checkout_request_id,
            EXISTS (SELECT 1 FROM mpesa_callbacks m
                     WHERE (s.checkout_request_id IS NOT NULL AND m.checkout_request_id = s.checkout_request_id)
                        OR m.stk_request_id = s.stk_request_id) AS has_intake
       FROM stk_requests s
      WHERE s.agent_id = (SELECT agent_id FROM sales_agents WHERE agent_code = $1)
        AND s.amount = $2::numeric AND s.consumed_receipt IS NULL
        AND date_trunc('second', s.created_at) <= $3::timestamptz + make_interval(secs => $5::double precision / 1000)
        AND s.created_at >= $3::timestamptz - make_interval(secs => ($4::double precision + $5::double precision) / 1000)
        AND ($6::text[] IS NULL OR s.phone_hash = ANY($6::text[]))
        AND ($7::text[] IS NULL OR s.phone_mask_hash = ANY($7::text[]))
      ORDER BY s.created_at${forUpdate ? ' FOR UPDATE OF s' : ''}`,
    [q.agentCode, q.amount, q.initiatedAt.toISOString(), q.ttlMs, q.skewMs, q.phoneHashes, q.maskHashes]
  );
  return rows.map((r) => ({
    stkRequestId: r.stk_request_id,
    agentId: r.agent_id,
    status: r.status,
    checkoutRequestId: r.checkout_request_id,
    hasIntake: r.has_intake === true,
  }));
}

/** Locks the intake row of a receipt (serialises with a worker settling it), if there is one. */
export async function lockReceipt(db: Db, receipt: string): Promise<void> {
  await db.query(`SELECT 1 FROM mpesa_callbacks WHERE mpesa_receipt_id = $1 FOR UPDATE`, [receipt]);
}

export async function insertException(
  db: Db,
  e: {
    kind: 'CLAWBACK_DUE' | 'RELEASED_NOT_ON_STATEMENT';
    receipt: string;
    relatedReceipt?: string | null;
    runId: string;
    escrowId: string | null;
    amount: string | null;
    detail: string;
  }
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO reconciliation_exceptions (kind, mpesa_receipt_id, related_receipt_id, run_id, escrow_id, amount, detail)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7)
     ON CONFLICT ON CONSTRAINT reconciliation_exceptions_dedup DO NOTHING`,
    [e.kind, e.receipt, e.relatedReceipt ?? '', e.runId, e.escrowId, e.amount, e.detail.slice(0, 2000)]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Two-way reconciliation: callback-origin receipts paid inside [from, to] to this statement's
 * shortcode that the statement does not list — settled ones by payment time, unsettled intake rows
 * by receipt time. C2B callbacks carry their BusinessShortCode; STK callbacks carry none, so they
 * count only when `includeStk` (the statement is of the shortcode STK payments are paid into).
 */
export async function callbackReceiptsMissingFrom(
  db: Db,
  q: { from: Date; to: Date; statementReceipts: string[]; shortCode: string; includeStk: boolean }
): Promise<string[]> {
  const paidHere = `((m.source_channel = 'C2B' AND BTRIM(m.payload->>'BusinessShortCode') = $4)
                     OR ($5::boolean AND m.source_channel = 'DARAJA_STK'))`;
  const { rows } = await db.query<{ r: string }>(
    `SELECT t.mpesa_receipt_id AS r FROM transactions t JOIN mpesa_callbacks m ON m.callback_id = t.callback_id
      WHERE m.origin = 'CALLBACK' AND ${paidHere}
        AND t.timestamp >= $1::timestamptz AND t.timestamp <= $2::timestamptz
        AND NOT (t.mpesa_receipt_id = ANY($3::text[]))
     UNION
     SELECT m.mpesa_receipt_id FROM mpesa_callbacks m
      WHERE m.origin = 'CALLBACK' AND m.status <> 'SETTLED' AND ${paidHere}
        AND m.received_at >= $1::timestamptz AND m.received_at <= $2::timestamptz
        AND NOT (m.mpesa_receipt_id = ANY($3::text[]))
     ORDER BY 1`,
    [q.from.toISOString(), q.to.toISOString(), q.statementReceipts, q.shortCode, q.includeStk]
  );
  return rows.map((x) => x.r);
}
