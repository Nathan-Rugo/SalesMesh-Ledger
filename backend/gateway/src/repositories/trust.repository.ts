/**
 * @file trust.repository.ts
 * @description SQL for the trust score and the outcome-based agent rating (spec gh-23).
 *
 * LOCKING: callers lock the agent row LAST in their transaction, one agent per transaction, with
 * FOR NO KEY UPDATE (compatible with the FK's FOR KEY SHARE taken by a concurrent transactions
 * insert, so a settlement of the same agent never deadlocks against it). S_t is computed from R
 * read under that lock, before any credit or penalty in the same transaction.
 *
 * Every rating change is one agent_trust_events row (UNIQUE(cause, ref)) written before the
 * rating update: a retry, a re-import or a second sweep changes nothing.
 */

import { trustConfigHash, trustParams } from '../config/trust';
import { ewma, FORMULA_VERSION, penalise, round6, type AgentMaturity, type TrustAssessment, type TrustParams } from '../domain/trust';
import type { FeatureVector } from '../services/risk_client.service';
import type { Db } from './db.types';
import { SECURITY_HOLD_EVENTS } from '../domain/security_events';

export type TrustCause = 'HOLD_MATURED_CLEAN' | 'STATEMENT_CONFIRMED' | 'SECURITY_PENALTY' | 'OPERATOR_ADJUST';
export type CreditCause = Extract<TrustCause, 'HOLD_MATURED_CLEAN' | 'STATEMENT_CONFIRMED'>;
const CREDIT_CAUSES: readonly CreditCause[] = ['HOLD_MATURED_CLEAN', 'STATEMENT_CONFIRMED'];

/** Locks the agent row (FOR NO KEY UPDATE) and returns its rating; null when the agent does not exist. */
export async function lockAgentRating(db: Db, agentId: string): Promise<number | null> {
  const { rows } = await db.query<{ r: string }>(
    'SELECT agent_trust_rating::text AS r FROM sales_agents WHERE agent_id = $1 FOR NO KEY UPDATE',
    [agentId]
  );
  return rows[0] ? Number(rows[0].r) : null;
}

/** SQL: the receipt has no hold-type security event (now); `param` binds SECURITY_HOLD_EVENTS. */
const clean = (receipt: string, param: string) =>
  `NOT EXISTS (SELECT 1 FROM security_events s WHERE s.mpesa_receipt_id = ${receipt} AND s.event_type = ANY(${param}::text[]))`;

/**
 * Maturity evidence: the agent's credited receipts (one credit per receipt: a matured clean hold or
 * a statement confirmation) that are still clean — a receipt penalised later stops counting — the
 * distinct payment days they span and their settled value.
 */
export async function agentMaturity(db: Db, agentId: string): Promise<AgentMaturity> {
  const { rows } = await db.query<{ holds: number; days: number; value: string }>(
    `SELECT count(*)::int AS holds, count(DISTINCT (t.timestamp AT TIME ZONE 'UTC')::date)::int AS days,
            COALESCE(sum(t.amount), 0)::text AS value
       FROM agent_trust_events a JOIN transactions t ON t.mpesa_receipt_id = a.ref
      WHERE a.agent_id = $1 AND a.cause = ANY($3::text[]) AND ${clean('t.mpesa_receipt_id', '$2')}`,
    [agentId, SECURITY_HOLD_EVENTS, CREDIT_CAUSES]
  );
  const r = rows[0];
  return { cleanHolds: r?.holds ?? 0, distinctDays: r?.days ?? 0, settledValue: Number(r?.value ?? 0) };
}

/**
 * The agent's median settled amount over (at − days, at], excluding this receipt, and how many there
 * were. Only payments that cleared count (escrow HELD, CLAIMED or RELEASED, not security-held, no hold-type
 * event): large never-clearing self-payments cannot inflate the median.
 */
export async function medianSettledAmount(
  db: Db,
  q: { agentId: string; at: Date; excludeReceipt: string; days: number }
): Promise<{ median: number | null; count: number }> {
  const { rows } = await db.query<{ n: number; median: number | null }>(
    `SELECT count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.amount)::float8 AS median
       FROM transactions t JOIN escrow_accounts e USING (transaction_id)
      WHERE t.agent_id = $1 AND t.mpesa_receipt_id <> $3
        AND t.timestamp > $2::timestamptz - make_interval(secs => $4::float8 * 86400) AND t.timestamp <= $2::timestamptz
        AND e.escrow_status IN ('HELD', 'CLAIMED', 'RELEASED') AND NOT e.security_hold
        AND ${clean('t.mpesa_receipt_id', '$5')}`,
    [q.agentId, q.at.toISOString(), q.excludeReceipt, q.days, SECURITY_HOLD_EVENTS]
  );
  return { median: rows[0]?.median ?? null, count: rows[0]?.n ?? 0 };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * The trust row (Table 7, extended) for one verification, plus its config snapshot (written once
 * per distinct parameter set, in the same statement). Idempotent per verification; the agent's
 * scored_txn_count moves only when the row is new.
 */
export async function insertTrustScore(
  db: Db,
  row: { verificationId: string; agentId: string; assessment: TrustAssessment; features: FeatureVector },
  params: TrustParams = trustParams()
): Promise<boolean> {
  const a = row.assessment;
  const { rows } = await db.query(
    `WITH snap AS (
       INSERT INTO trust_config_snapshots (config_hash, params, formula_version) VALUES ($11, $12::jsonb, $13)
       ON CONFLICT (config_hash) DO NOTHING)
     INSERT INTO trust_scores (verification_id, velocity_score, split_ratio_score, final_trust_index, transaction_trust,
                               p_used, p_source, agent_rating_used, amount_factor, hold_seconds, hold_reason,
                               config_hash, formula_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $14, $11, $13)
     ON CONFLICT (verification_id) DO NOTHING
     RETURNING 1`,
    [
      row.verificationId,
      clamp(row.features.velocity_v_i, 0, 9999.9999).toFixed(4), // DECIMAL(8,4)
      clamp(row.features.split_ratio_r_s, 0, 1).toFixed(4), // DECIMAL(5,4)
      a.trustIndex.toFixed(6),
      round6(1 - a.pUsed).toFixed(6),
      a.pUsed.toFixed(6),
      a.pSource,
      a.agentRatingUsed.toFixed(6),
      a.amountFactor.toFixed(6),
      a.holdSeconds,
      trustConfigHash(params),
      JSON.stringify(params),
      FORMULA_VERSION,
      a.holdReason,
    ]
  );
  if (rows.length === 0) return false;
  await db.query('UPDATE sales_agents SET scored_txn_count = scored_txn_count + 1 WHERE agent_id = $1', [row.agentId]);
  return true;
}

/** Records the parameter set in force (startup). */
export async function ensureConfigSnapshot(db: Db, params: TrustParams = trustParams()): Promise<string> {
  const hash = trustConfigHash(params);
  await db.query(
    `INSERT INTO trust_config_snapshots (config_hash, params, formula_version) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (config_hash) DO NOTHING`,
    [hash, JSON.stringify(params), FORMULA_VERSION]
  );
  return hash;
}

/**
 * One audited rating change: locks the agent, writes the event (UNIQUE(cause, ref)), then the rating.
 * Returns the new rating, or null when this (cause, ref) was already applied or the agent is unknown.
 */
export async function applyRatingChange(
  db: Db,
  c: { agentId: string; cause: TrustCause; ref: string; next: (old: number) => number; detail: string }
): Promise<number | null> {
  if (c.ref.length > 200) throw new Error(`trust event ref is longer than 200 characters: ${c.ref.slice(0, 40)}…`);
  const old = await lockAgentRating(db, c.agentId);
  if (old === null) return null;
  const next = round6(clamp(c.next(old), 0, 1));
  const { rows } = await db.query(
    `INSERT INTO agent_trust_events (agent_id, cause, ref, old_rating, new_rating, delta, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (cause, ref) DO NOTHING
     RETURNING 1`,
    [c.agentId, c.cause, c.ref, old.toFixed(6), next.toFixed(6), round6(next - old).toFixed(6), c.detail.slice(0, 2000)]
  );
  if (rows.length === 0) return null;
  await db.query('UPDATE sales_agents SET agent_trust_rating = $2 WHERE agent_id = $1', [c.agentId, next.toFixed(6)]);
  return next;
}

async function receiptAgent(db: Db, receipt: string): Promise<string | null> {
  const { rows } = await db.query<{ agent_id: string }>('SELECT agent_id FROM transactions WHERE mpesa_receipt_id = $1', [receipt]);
  return rows[0]?.agent_id ?? null;
}

/**
 * −penalty once per security-hold event type on the receipt (ref "event_type:receipt"), whatever
 * the escrow's status. A receipt not settled yet has no agent: its settlement applies them later.
 */
export async function penaliseReceipt(db: Db, receipt: string, params: TrustParams = trustParams()): Promise<number> {
  const { rows } = await db.query<{ event_type: string }>(
    `SELECT DISTINCT event_type FROM security_events WHERE mpesa_receipt_id = $1 AND event_type = ANY($2::text[]) ORDER BY 1`,
    [receipt, SECURITY_HOLD_EVENTS]
  );
  if (rows.length === 0) return 0;
  const agentId = await receiptAgent(db, receipt);
  if (!agentId) return 0;
  let applied = 0;
  for (const { event_type: type } of rows) {
    const r = await applyRatingChange(db, {
      agentId,
      cause: 'SECURITY_PENALTY',
      ref: `${type}:${receipt}`,
      next: (old) => penalise(old, params.penalty),
      detail: `${type} on ${receipt}`,
    });
    if (r !== null) applied += 1;
  }
  if (applied > 0) console.warn(`[Trust] agent ${agentId} penalised ${applied}× for security events on ${receipt}`);
  return applied;
}

/**
 * +β credit for evidence the money was legitimate: at most ONE credit per receipt across both kinds,
 * never for a receipt with a security-hold event, never a zero-delta credit (R = 1). Matured clean
 * holds also need an escrow decided under the trust regime (hold_seconds set), HELD, CLAIMED or RELEASED,
 * whose release_due_at has passed, and count against maxCreditsPerDay per agent per (UTC) day;
 * statement confirmations are money-backed evidence and are exempt from the cap.
 * Returns the new rating, or null when nothing was credited.
 */
export async function creditReceipt(db: Db, cause: CreditCause, receipt: string, params: TrustParams = trustParams()): Promise<number | null> {
  const agentId = await receiptAgent(db, receipt);
  if (!agentId) return null;
  const old = await lockAgentRating(db, agentId);
  if (old === null || ewma(old, params.beta) === old) return null;
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT ${clean('$1', '$2')}
        AND NOT EXISTS (SELECT 1 FROM agent_trust_events WHERE cause = ANY($3::text[]) AND ref = $1)
        AND ($4::text <> 'HOLD_MATURED_CLEAN' OR (
              (SELECT count(*) FROM agent_trust_events
                WHERE agent_id = $5 AND cause = 'HOLD_MATURED_CLEAN' AND created_at >= date_trunc('day', NOW())) < $6
              AND EXISTS (SELECT 1 FROM escrow_accounts e JOIN transactions t USING (transaction_id)
                           WHERE t.mpesa_receipt_id = $1 AND e.escrow_status IN ('HELD', 'CLAIMED', 'RELEASED')
                             AND e.hold_seconds IS NOT NULL AND e.release_due_at <= NOW()))) AS ok`,
    [receipt, SECURITY_HOLD_EVENTS, CREDIT_CAUSES, cause, agentId, params.maxCreditsPerDay]
  );
  if (!rows[0]?.ok) return null;
  return applyRatingChange(db, { agentId, cause, ref: receipt, next: (r) => ewma(r, params.beta), detail: `${cause} ${receipt}` });
}

/**
 * Receipts whose escrow (decided under the trust regime, HELD, CLAIMED or RELEASED) has matured with
 * no security-hold event and no credit yet, for agents under today's maturity-credit cap whose
 * credit would still move the rating (an agent at R = 1 would otherwise be re-selected forever).
 */
export async function findMaturedHolds(db: Db, limit: number, params: TrustParams = trustParams()): Promise<string[]> {
  const { rows } = await db.query<{ receipt: string }>(
    `SELECT t.mpesa_receipt_id AS receipt
       FROM escrow_accounts e JOIN transactions t USING (transaction_id) JOIN sales_agents a ON a.agent_id = t.agent_id
      WHERE e.escrow_status IN ('HELD', 'CLAIMED', 'RELEASED') AND e.hold_seconds IS NOT NULL AND e.release_due_at <= NOW()
        AND round(a.agent_trust_rating + $5 * (1 - a.agent_trust_rating), 6) <> a.agent_trust_rating
        AND NOT EXISTS (SELECT 1 FROM agent_trust_events c WHERE c.cause = ANY($3::text[]) AND c.ref = t.mpesa_receipt_id)
        AND ${clean('t.mpesa_receipt_id', '$2')}
        AND (SELECT count(*) FROM agent_trust_events c
              WHERE c.agent_id = t.agent_id AND c.cause = 'HOLD_MATURED_CLEAN' AND c.created_at >= date_trunc('day', NOW())) < $4
      ORDER BY e.release_due_at
      LIMIT $1`,
    [limit, SECURITY_HOLD_EVENTS, CREDIT_CAUSES, params.maxCreditsPerDay, params.beta]
  );
  return rows.map((r) => r.receipt);
}

/** Longest operator --ref: the stored ref is "operator:<agent uuid>:<ref>", within VARCHAR(200). */
export const MAX_OPERATOR_REF_LENGTH = 200 - 'operator:'.length - 36 - 1;

/**
 * An audited OPERATOR_ADJUST (e.g. undoing a clock-skew false alarm). The ref is per agent, so a
 * ticket id reused for another agent is a separate adjustment; the same ref on the same agent is
 * applied once. Returns the new rating, or null when this adjustment was already applied.
 */
export async function operatorAdjust(db: Db, a: { agentId: string; delta: number; ref: string; detail: string }): Promise<number | null> {
  if (a.ref.length > MAX_OPERATOR_REF_LENGTH) throw new Error(`--ref is longer than ${MAX_OPERATOR_REF_LENGTH} characters`);
  return applyRatingChange(db, { agentId: a.agentId, cause: 'OPERATOR_ADJUST', ref: `operator:${a.agentId}:${a.ref}`, next: (r) => r + a.delta, detail: a.detail });
}

/** Resolves an agent by id or agent_code (operator CLI). */
export async function findAgent(db: Db, ref: string): Promise<string | null> {
  const { rows } = await db.query<{ agent_id: string }>(
    `SELECT agent_id FROM sales_agents
      WHERE agent_code = UPPER(BTRIM($1)) OR (agent_id::text = LOWER(BTRIM($1)))`,
    [ref]
  );
  return rows[0]?.agent_id ?? null;
}

/**
 * Health: average S_t and the computed-hold distribution over 24 h; quarantined escrows by reason;
 * agents frozen even at p = 0 (R_eff^(1−w) ≤ TRUST_FREEZE_AT: every CLEAR of theirs is quarantined).
 */
export async function trustStats(db: Db, params: TrustParams = trustParams()): Promise<{
  frozenAgents: number;
  scored24h: number;
  avgTrustIndex24h: number | null;
  holdHours24h: { p50: number | null; p90: number | null; max: number | null };
  holdReason24h: Record<string, number>;
  quarantinedByReason: Record<string, number>;
}> {
  const { rows: [s] } = await db.query<{ n: number; avg: number | null; p50: number | null; p90: number | null; max: number | null; reasons: Record<string, number> | null }>(
    `SELECT count(*)::int AS n, avg(final_trust_index)::float8 AS avg,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY hold_seconds)::float8 / 3600 AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY hold_seconds)::float8 / 3600 AS p90,
            max(hold_seconds)::float8 / 3600 AS max,
            (SELECT jsonb_object_agg(hold_reason, n) FROM (
               SELECT hold_reason, count(*)::int AS n FROM trust_scores
                WHERE created_at > NOW() - interval '24 hours' AND hold_reason IS NOT NULL GROUP BY 1) r) AS reasons
       FROM trust_scores WHERE created_at > NOW() - interval '24 hours'`
  );
  const { rows: q } = await db.query<{ reason: string; n: number }>(
    `SELECT COALESCE(quarantine_reason, 'unknown') AS reason, count(*)::int AS n
       FROM escrow_accounts WHERE escrow_status = 'QUARANTINED' GROUP BY 1`
  );
  // R_eff = min(R, cap) and cap^(1−w) > freeze (validated), so R_eff is at the floor exactly when R is.
  const floor = params.txWeight === 1 ? -1 : params.freezeAt ** (1 / (1 - params.txWeight));
  const { rows: [f] } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sales_agents WHERE agent_trust_rating <= $1', [floor]);
  return {
    frozenAgents: f?.n ?? 0,
    scored24h: s?.n ?? 0,
    avgTrustIndex24h: s?.avg ?? null,
    holdHours24h: { p50: s?.p50 ?? null, p90: s?.p90 ?? null, max: s?.max ?? null },
    holdReason24h: s?.reasons ?? {},
    quarantinedByReason: Object.fromEntries(q.map((r) => [r.reason, r.n])),
  };
}
