/**
 * @file agent.repository.ts
 * @description Agent resolution (spec gh-6, B4): STK via the CheckoutRequestID record, C2B via
 * BillRefNumber = agent_code. Placeholder agents are never used.
 */

import { toCents } from '../domain/callback';
import type { Db } from './db.types';

/** agent_id for a normalised (trimmed, upper-case) agent code, or null. */
export async function findAgentByCode(db: Db, agentCode: string): Promise<string | null> {
  const { rows } = await db.query<{ agent_id: string }>(
    'SELECT agent_id FROM sales_agents WHERE agent_code = $1',
    [agentCode]
  );
  return rows[0]?.agent_id ?? null;
}

export interface StkRequest {
  agentId: string;
  amountCents: number;
  consumedReceipt: string | null;
}

export async function findStkRequest(db: Db, checkoutRequestId: string): Promise<StkRequest | null> {
  const { rows } = await db.query<{ agent_id: string; amount: string; consumed_receipt: string | null }>(
    'SELECT agent_id, amount::text AS amount, consumed_receipt FROM stk_requests WHERE checkout_request_id = $1',
    [checkoutRequestId]
  );
  const r = rows[0];
  if (!r) return null;
  const amountCents = toCents(r.amount);
  if (amountCents === null) throw new Error(`stk_requests amount for ${checkoutRequestId} is not a valid amount`);
  return { agentId: r.agent_id, amountCents, consumedReceipt: r.consumed_receipt };
}

/**
 * Binds the receipt to the STK request (UNIQUE consumed_receipt). Idempotent for the same
 * receipt; false when a different receipt already consumed it (replay).
 */
export async function consumeStkRequest(db: Db, checkoutRequestId: string, receipt: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests SET consumed_receipt = $2, consumed_at = COALESCE(consumed_at, NOW())
      WHERE checkout_request_id = $1 AND (consumed_receipt IS NULL OR consumed_receipt = $2)`,
    [checkoutRequestId, receipt]
  );
  return rowCount === 1;
}
