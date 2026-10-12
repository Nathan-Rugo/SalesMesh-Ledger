/**
 * @file frozen.repository.ts
 * @description Frozen-payout SLA (spec gh-11, part 3c): QUARANTINED escrows (any reason, UFAA-frozen
 * included) and UNRESOLVED payouts waiting for an admin. The freeze clocks are escrow_accounts.frozen_at
 * (kept by the escrow_accounts_freeze_clock trigger) and payouts.unresolved_at.
 */

import type { Db } from './db.types';

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
  overdue: boolean;
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
): Promise<{ escrows: FrozenEscrow[]; payouts: FrozenPayout[]; totals: { escrows: number; payouts: number } }> {
  const [e, p] = await Promise.all([
    db.query(
      `SELECT e.escrow_id, a.agent_code, u.full_name, (e.gross_commission * 100)::bigint AS cents, e.quarantine_reason, e.security_hold,
              e.ufaa_return_id IS NOT NULL AS ufaa_frozen, t.mpesa_receipt_id, e.frozen_at, e.sla_escalated_at,
              COALESCE(e.frozen_at <= NOW() - make_interval(hours => $1::int), FALSE) AS overdue, count(*) OVER ()::int AS total
         FROM escrow_accounts e
         JOIN transactions t USING (transaction_id)
         JOIN sales_agents a ON a.agent_id = t.agent_id
         JOIN users u ON u.user_id = a.user_id
        WHERE e.escrow_status = 'QUARANTINED'
        ORDER BY overdue DESC, e.frozen_at NULLS LAST, e.escrow_id
        LIMIT $2`,
      [q.escrowHours, q.limit]
    ),
    db.query(
      `SELECT p.payout_id, a.agent_code, u.full_name, p.amount, p.msisdn, p.unresolved_at, p.sla_escalated_at,
              COALESCE(p.unresolved_at <= NOW() - make_interval(hours => $1::int), FALSE) AS overdue, count(*) OVER ()::int AS total
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
      overdue: r.overdue,
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
  };
}

/** Login phones of the active (not disabled) MERCHANT_ADMINs. */
export async function activeAdminPhones(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ phone_number: string }>(
    `SELECT phone_number FROM users WHERE role = 'MERCHANT_ADMIN' AND disabled_at IS NULL ORDER BY created_at`
  );
  return rows.map((r) => r.phone_number);
}
