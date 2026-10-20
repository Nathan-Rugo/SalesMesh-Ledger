/**
 * @file frozen.repository.ts
 * @description Frozen-payout SLA (spec gh-11, part 3c): QUARANTINED escrows (any reason, UFAA-frozen
 * included) and UNRESOLVED payouts waiting for an admin. The freeze clocks are escrow_accounts.frozen_at
 * (kept by the escrow_accounts_freeze_clock trigger) and payouts.unresolved_at.
 */

import type { ShapFeature } from '../services/risk_client.service';
import { withTransaction, type Db, type TxDb } from './db.types';

export interface SlaHours {
  escrowHours: number;
  payoutHours: number;
}

export interface Escalated {
  escrows: number;
  escrowCents: number;
  payouts: number;
  payoutCents: number;
}

export interface FrozenEscrow {
  escrowId: string;
  agentCode: string | null;
  agentName: string;
  cents: number;
  quarantineReason: string | null;
  securityHold: boolean;
  ufaaFrozen: boolean;
  receipt: string;
  frozenAt: Date;
  escalatedAt: Date | null;
  /** An admin chose "Keep held" in this spell (spec gh-14); clears the overdue flag. */
  reviewedAt: Date | null;
  overdue: boolean;
  /** The latest verification event: the model run behind this quarantine (null when none). */
  risk: FrozenRisk | null;
}

export interface FrozenRisk {
  decision: string;
  isoScore: number | null;
  xgbProb: number | null;
  modelVersion: string;
  /** That run's SHAP attributions, only when XGBoost (layer 2) made the quarantining decision: null before
   * migration 010, on fail-safe, for security holds, trust freezes and layer-1 (Isolation Forest) quarantines. */
  shap: ShapFeature[] | null;
  units: string | null;
}

export interface FrozenPayout {
  payoutId: string;
  agentCode: string | null;
  agentName: string;
  amount: number;
  msisdn: string;
  unresolvedAt: Date | null;
  escalatedAt: Date | null;
  overdue: boolean;
}

/**
 * Marks every frozen item past its SLA and not yet escalated, one atomic UPDATE per table: a
 * concurrent sweep re-checks `sla_escalated_at IS NULL` on the locked row, so each spell is marked once.
 */
export async function escalateOverdue(db: Db, q: SlaHours): Promise<Escalated> {
  const { rows: [r] } = await db.query(
    `WITH e AS (
       UPDATE escrow_accounts SET sla_escalated_at = NOW()
        WHERE escrow_status = 'QUARANTINED' AND sla_escalated_at IS NULL AND frozen_at <= NOW() - make_interval(hours => $1::int)
       RETURNING (gross_commission * 100)::bigint AS cents),
     p AS (
       UPDATE payouts SET sla_escalated_at = NOW()
        WHERE status = 'UNRESOLVED' AND sla_escalated_at IS NULL AND unresolved_at <= NOW() - make_interval(hours => $2::int)
       RETURNING amount::bigint * 100 AS cents)
     SELECT (SELECT count(*) FROM e)::int AS escrows, (SELECT COALESCE(sum(cents), 0) FROM e)::bigint AS escrow_cents,
            (SELECT count(*) FROM p)::int AS payouts, (SELECT COALESCE(sum(cents), 0) FROM p)::bigint AS payout_cents`,
    [q.escrowHours, q.payoutHours]
  );
  return { escrows: r.escrows, escrowCents: Number(r.escrow_cents), payouts: r.payouts, payoutCents: Number(r.payout_cents) };
}

/** Every frozen item (up to `limit` of each), overdue first, then oldest first; `total` counts beyond the cap. */
export async function listFrozen(
  db: Db,
  q: SlaHours & { limit: number }
): Promise<{
  escrows: FrozenEscrow[];
  payouts: FrozenPayout[];
  totals: { escrows: number; payouts: number };
  overdue: { escrows: number; payouts: number };
}> {
  const escrowOverdue = `COALESCE(e.frozen_at <= NOW() - make_interval(hours => $1::int) AND e.reviewed_at IS NULL, FALSE)`;
  const modelFroze = `(NOT e.security_hold AND e.quarantine_reason = 'model_decision' AND v.layer2_adjudicated IS TRUE)`;
  const payoutOverdue = `COALESCE(p.unresolved_at <= NOW() - make_interval(hours => $1::int), FALSE)`;
  const [e, p] = await Promise.all([
    db.query(
      `SELECT e.escrow_id, a.agent_code, u.full_name, (e.gross_commission * 100)::bigint AS cents, e.quarantine_reason, e.security_hold,
              e.ufaa_return_id IS NOT NULL AS ufaa_frozen, t.mpesa_receipt_id, e.frozen_at, e.sla_escalated_at, e.reviewed_at,
              ${escrowOverdue} AS overdue, count(*) OVER ()::int AS total, (count(*) FILTER (WHERE ${escrowOverdue}) OVER ())::int AS total_overdue,
              v.decision, v.isolation_forest_score, v.xgboost_fraud_prob, v.model_version,
              -- SHAP explains the freeze only when XGBoost (layer 2) made the quarantining decision.
              CASE WHEN ${modelFroze} THEN v.shap_features END AS shap_features, CASE WHEN ${modelFroze} THEN v.shap_units END AS shap_units
         FROM escrow_accounts e
         JOIN transactions t USING (transaction_id)
         JOIN sales_agents a ON a.agent_id = t.agent_id
         JOIN users u ON u.user_id = a.user_id
         -- The run behind the quarantine: same ordering as the self-heal's latest event.
         LEFT JOIN LATERAL (
           SELECT v.decision, v.isolation_forest_score, v.xgboost_fraud_prob, v.model_version, v.shap_features, v.shap_units, v.layer2_adjudicated
             FROM verification_events v WHERE v.transaction_id = e.transaction_id
            ORDER BY v.evaluated_at DESC, (v.kind = 'RESCORE') DESC, v.verification_id DESC LIMIT 1) v ON TRUE
        WHERE e.escrow_status = 'QUARANTINED'
        ORDER BY overdue DESC, (e.reviewed_at IS NULL) DESC, e.frozen_at NULLS LAST, e.escrow_id
        LIMIT $2`,
      [q.escrowHours, q.limit]
    ),
    db.query(
      `SELECT p.payout_id, a.agent_code, u.full_name, p.amount, p.msisdn, p.unresolved_at, p.sla_escalated_at,
              ${payoutOverdue} AS overdue, count(*) OVER ()::int AS total, (count(*) FILTER (WHERE ${payoutOverdue}) OVER ())::int AS total_overdue
         FROM payouts p
         JOIN sales_agents a ON a.agent_id = p.agent_id
         JOIN users u ON u.user_id = a.user_id
        WHERE p.status = 'UNRESOLVED'
        ORDER BY overdue DESC, p.unresolved_at NULLS LAST, p.payout_id
        LIMIT $2`,
      [q.payoutHours, q.limit]
    ),
  ]);
  return {
    escrows: e.rows.map((r) => ({
      escrowId: r.escrow_id,
      agentCode: r.agent_code,
      agentName: r.full_name,
      cents: Number(r.cents),
      quarantineReason: r.quarantine_reason,
      securityHold: r.security_hold,
      ufaaFrozen: r.ufaa_frozen,
      receipt: r.mpesa_receipt_id,
      frozenAt: r.frozen_at,
      escalatedAt: r.sla_escalated_at,
      reviewedAt: r.reviewed_at,
      overdue: r.overdue,
      risk: r.decision
        ? {
            decision: r.decision,
            isoScore: r.isolation_forest_score,
            xgbProb: r.xgboost_fraud_prob,
            modelVersion: r.model_version,
            shap: r.shap_features,
            units: r.shap_features ? r.shap_units : null,
          }
        : null,
    })),
    payouts: p.rows.map((r) => ({
      payoutId: r.payout_id,
      agentCode: r.agent_code,
      agentName: r.full_name,
      amount: r.amount,
      msisdn: r.msisdn,
      unresolvedAt: r.unresolved_at,
      escalatedAt: r.sla_escalated_at,
      overdue: r.overdue,
    })),
    totals: { escrows: e.rows[0]?.total ?? 0, payouts: p.rows[0]?.total ?? 0 },
    overdue: { escrows: e.rows[0]?.total_overdue ?? 0, payouts: p.rows[0]?.total_overdue ?? 0 },
  };
}

export type EscrowOverride = 'release' | 'keep';

export type OverrideResult =
  | { kind: 'not_found' }
  | { kind: 'security_hold' }
  /** No longer QUARANTINED (released, or promoted by the rescore), or already kept in this spell. */
  | { kind: 'already_decided'; status: string }
  | { kind: 'done'; status: 'HELD' | 'QUARANTINED'; receipt: string; releaseDueAt: Date; reviewedAt: Date | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An admin override of a QUARANTINED escrow (spec gh-14), state-guarded on the locked row and
 * committed with its ESCROW_OVERRIDE audit row (subject: the admin), so a double submit or a second
 * admin gets `already_decided` and exactly one row exists. Never moves money:
 *   release: QUARANTINED -> HELD, release_due_at = max(original, now), reason and rescore lease cleared
 *            (the normal claim path takes over);
 *   keep:    records the review and clears this spell's overdue flag (marks it escalated); stays queued.
 * Security holds are refused (they need an investigation, not an override).
 */
export async function overrideEscrow(
  db: TxDb,
  q: { escrowId: string; action: EscrowOverride; adminId: string; note: string }
): Promise<OverrideResult> {
  if (!UUID_RE.test(q.escrowId)) return { kind: 'not_found' };
  return withTransaction(db, async (tx) => {
    const { rows: [cur] } = await tx.query(
      `SELECT e.escrow_status, e.security_hold, e.reviewed_at, e.frozen_at, t.mpesa_receipt_id, (e.gross_commission * 100)::bigint AS cents
         FROM escrow_accounts e JOIN transactions t USING (transaction_id)
        WHERE e.escrow_id = $1 FOR UPDATE OF e`,
      [q.escrowId]
    );
    if (!cur) return { kind: 'not_found' } as const;
    if (cur.escrow_status !== 'QUARANTINED') return { kind: 'already_decided', status: cur.escrow_status } as const;
    if (cur.security_hold) return { kind: 'security_hold' } as const;
    if (q.action === 'keep' && cur.reviewed_at) return { kind: 'already_decided', status: cur.escrow_status } as const;
    const { rows: [upd] } =
      q.action === 'release'
        ? await tx.query(
            `UPDATE escrow_accounts
                SET escrow_status = 'HELD', release_due_at = GREATEST(release_due_at, NOW()), quarantine_reason = NULL,
                    rescore_claimed_at = NULL, rescore_claim_token = NULL
              WHERE escrow_id = $1 AND escrow_status = 'QUARANTINED' AND NOT security_hold
              RETURNING escrow_status, release_due_at, reviewed_at`,
            [q.escrowId]
          )
        : await tx.query(
            `UPDATE escrow_accounts SET reviewed_at = NOW(), sla_escalated_at = COALESCE(sla_escalated_at, NOW())
              WHERE escrow_id = $1 AND escrow_status = 'QUARANTINED' AND NOT security_hold AND reviewed_at IS NULL
              RETURNING escrow_status, release_due_at, reviewed_at`,
            [q.escrowId]
          );
    if (!upd) throw new Error(`guarded override matched no row: ${q.escrowId}`); // the row is locked above
    const kes = (Number(cur.cents) / 100).toFixed(2);
    const what = q.action === 'release' ? `released to HELD (due ${upd.release_due_at.toISOString()})` : 'kept held after review';
    // incoming_hash = action + spell: the dedup constraint backs the row-lock guard (one row per decision).
    await tx.query(
      `INSERT INTO security_events (event_type, mpesa_receipt_id, subject_user_id, incoming_hash, detail)
       VALUES ('ESCROW_OVERRIDE', $1, $2, $3, $4)`,
      [
        cur.mpesa_receipt_id,
        q.adminId,
        `${q.action}:${cur.frozen_at?.toISOString() ?? ''}`,
        `escrow ${q.escrowId} (receipt ${cur.mpesa_receipt_id}, KES ${kes}): ${what} by admin ${q.adminId}. Note: ${q.note}`.slice(0, 2000),
      ]
    );
    return { kind: 'done', status: upd.escrow_status, receipt: cur.mpesa_receipt_id, releaseDueAt: upd.release_due_at, reviewedAt: upd.reviewed_at } as const;
  });
}

/** Login phones of the active (not disabled) MERCHANT_ADMINs. */
export async function activeAdminPhones(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ phone_number: string }>(
    `SELECT phone_number FROM users WHERE role = 'MERCHANT_ADMIN' AND disabled_at IS NULL ORDER BY created_at`
  );
  return rows.map((r) => r.phone_number);
}
