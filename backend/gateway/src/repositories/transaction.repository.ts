/**
 * @file transaction.repository.ts
 * @description The agent-history query that feeds ml-engine raw mode (spec gh-6, B1).
 *
 * Anchored to the payment time t: rows in (t − 30 d, t] of the SAME agent, excluding this
 * receipt, most recent first (time, then receipt DESC), at most `limit` rows. Receipts are the
 * transaction_id on both sides of the ml-engine request. One extra row is fetched to detect
 * truncation, which is recorded on the verification event.
 */

import type { HistoryRow } from '../services/risk_client.service';
import type { Db } from './db.types';

export const HISTORY_LOOKBACK_DAYS = 30;

export interface HistoryQuery {
  agentId: string;
  at: Date;
  excludeReceipt: string;
  limit: number;
  /** Re-score, legacy fallback: only rows ingested by this transaction's INITIAL evaluation. */
  asOfInitialOf?: string;
  /** Re-score: exactly the receipts the INITIAL request carried (exact replay). */
  receipts?: string[];
}

export async function fetchHistory(db: Db, q: HistoryQuery): Promise<{ rows: HistoryRow[]; truncated: boolean }> {
  const params: unknown[] = [q.agentId, q.at.toISOString(), q.excludeReceipt, q.limit + 1, HISTORY_LOOKBACK_DAYS];
  let asOf = '';
  if (q.receipts) {
    params.push(q.receipts);
    asOf = 'AND mpesa_receipt_id = ANY($6::text[])';
  } else if (q.asOfInitialOf) {
    params.push(q.asOfInitialOf);
    asOf = `AND ingested_at <= (SELECT evaluated_at FROM verification_events
                                 WHERE transaction_id = $6 AND kind = 'INITIAL')`;
  }
  const { rows } = await db.query<{ receipt: string; ts: Date; amount: string; counterparty_hash: string }>(
    `SELECT mpesa_receipt_id AS receipt, timestamp AS ts, amount::text AS amount, counterparty_hash
       FROM transactions
      WHERE agent_id = $1
        AND timestamp > $2::timestamptz - make_interval(days => $5)
        AND timestamp <= $2::timestamptz
        AND mpesa_receipt_id <> $3
        ${asOf}
      ORDER BY timestamp DESC, mpesa_receipt_id DESC
      LIMIT $4`,
    params
  );
  const truncated = rows.length > q.limit;
  return {
    truncated,
    rows: rows.slice(0, q.limit).map((r) => ({
      transaction_id: r.receipt,
      agent_id: q.agentId,
      timestamp: new Date(r.ts).toISOString(),
      amount: Number(r.amount),
      counterparty_id: r.counterparty_hash,
    })),
  };
}
