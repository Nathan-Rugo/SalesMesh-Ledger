/**
 * @file agent.repository.ts
 * @description Agent resolution (spec gh-6, B4): STK via the CheckoutRequestID record, C2B via
 * BillRefNumber = agent_code. Placeholder agents are never used. Also maps an authenticated
 * user to their sales_agents row (spec gh-5: the agent is never taken from a request body).
 */

import { toCents } from '../domain/callback';
import type { Db } from './db.types';
import type { StkStatus } from './stk.repository';

/** agent_id for a normalised (trimmed, upper-case) agent code, or null. */
export async function findAgentByCode(db: Db, agentCode: string): Promise<string | null> {
  const { rows } = await db.query<{ agent_id: string }>(
    'SELECT agent_id FROM sales_agents WHERE agent_code = $1',
    [agentCode]
  );
  return rows[0]?.agent_id ?? null;
}

/** The sales agent behind an authenticated user (token `user_id`), or null when not provisioned. */
export async function findAgentForUser(
  db: Db,
  userId: string
): Promise<{ agentId: string; agentCode: string | null; userDisabled: boolean } | null> {
  const { rows } = await db.query(
    `SELECT a.agent_id, a.agent_code, u.disabled_at IS NOT NULL AS disabled
       FROM sales_agents a JOIN users u ON u.user_id = a.user_id
      WHERE a.user_id = $1
      ORDER BY a.agent_code IS NULL, a.agent_id
      LIMIT 1`,
    [userId]
  );
  const r = rows[0];
  return r ? { agentId: r.agent_id, agentCode: r.agent_code, userDisabled: r.disabled === true } : null;
}

export interface StkRequest {
  stkRequestId: string;
  agentId: string;
  amountCents: number;
  status: StkStatus;
  consumedReceipt: string | null;
}

export async function findStkRequest(db: Db, checkoutRequestId: string): Promise<StkRequest | null> {
  const { rows } = await db.query<{ stk_request_id: string; agent_id: string; amount: string; status: StkStatus; consumed_receipt: string | null }>(
    `SELECT stk_request_id, agent_id, amount::text AS amount, status, consumed_receipt
       FROM stk_requests WHERE checkout_request_id = $1`,
    [checkoutRequestId]
  );
  const r = rows[0];
  if (!r) return null;
  const amountCents = toCents(r.amount);
  if (amountCents === null) throw new Error(`stk_requests amount for ${checkoutRequestId} is not a valid amount`);
  return { stkRequestId: r.stk_request_id, agentId: r.agent_id, amountCents, status: r.status, consumedReceipt: r.consumed_receipt };
}

/**
 * Binds the receipt to the STK request (UNIQUE consumed_receipt), by stk_request_id so that a
 * fallback-bound request is consumed the same way. Idempotent for the same receipt; false when a
 * different receipt already consumed it (replay).
 */
export async function consumeStkRequest(db: Db, stkRequestId: string, receipt: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE stk_requests SET consumed_receipt = $2, consumed_at = COALESCE(consumed_at, NOW()), updated_at = NOW()
      WHERE stk_request_id = $1 AND (consumed_receipt IS NULL OR consumed_receipt = $2)`,
    [stkRequestId, receipt]
  );
  return rowCount === 1;
}
