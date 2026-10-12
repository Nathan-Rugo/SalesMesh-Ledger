/**
 * @file security.repository.ts
 * @description Persistent security alarms. Subject-generic (spec gh-5): a receipt (payload
 * mutation, STK receipt replay, STK/C2B cross-channel echo) or a user / refresh-token family
 * (refresh token reuse, login lockout, PIN change).
 */

import { SECURITY_HOLD_EVENTS, type SecurityEventType } from '../domain/security_events';
import type { Db, TxDb } from './db.types';
import { withTransaction } from './db.types';
import { penaliseReceipt } from './trust.repository';

// The event types live in a leaf module (trust.repository needs them too, without an import cycle).
export { SECURITY_HOLD_EVENTS, type SecurityEventType } from '../domain/security_events';

/** Receipt-subject alarm; deduplicated on (type, receipt, incoming hash). */
export async function insertSecurityEvent(
  db: Db,
  e: { type: SecurityEventType; receipt: string; originalHash: string | null; incomingHash: string; detail: string; stkRequestId?: string | null }
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO security_events (event_type, mpesa_receipt_id, original_hash, incoming_hash, detail, stk_request_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [e.type, e.receipt, e.originalHash, e.incomingHash, e.detail.slice(0, 2000), e.stkRequestId ?? null]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Forces the receipt's escrow to QUARANTINED with security_hold (self-heal never touches it).
 * A RELEASED (or REMITTED: transferred to UFAA) escrow is never changed (nothing is clawed back automatically): it is returned so
 * the caller can record an exception for an operator. A CLAIMED escrow (its payout is in flight)
 * keeps its status but gets security_hold, and is returned too: if the payout is PAID the money is
 * gone (CLAWBACK_DUE); if it FAILS the escrow becomes QUARANTINED. The agent's rating is penalised once per
 * security-hold event on the receipt (spec gh-23), whatever the escrow's status; the agent row is
 * locked last.
 */
export async function securityHoldReceipt(
  db: Db,
  receipt: string
): Promise<{ held: number; released: Array<{ escrowId: string; amount: string }> }> {
  const { rowCount } = await db.query(
    `UPDATE escrow_accounts e
        SET escrow_status = CASE WHEN e.escrow_status = 'CLAIMED' THEN 'CLAIMED' ELSE 'QUARANTINED' END,
            quarantine_reason = CASE WHEN e.escrow_status = 'CLAIMED' THEN e.quarantine_reason ELSE 'security_hold' END,
            security_hold = TRUE, rescore_claimed_at = NULL, rescore_claim_token = NULL
       FROM transactions t
      WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1
        AND e.escrow_status NOT IN ('RELEASED', 'REMITTED') AND NOT (e.escrow_status IN ('QUARANTINED', 'CLAIMED') AND e.security_hold)`,
    [receipt]
  );
  const { rows } = await db.query<{ escrow_id: string; amount: string }>(
    `SELECT e.escrow_id, t.amount::text AS amount FROM escrow_accounts e JOIN transactions t USING (transaction_id)
      WHERE t.mpesa_receipt_id = $1 AND e.escrow_status IN ('RELEASED', 'CLAIMED', 'REMITTED')`,
    [receipt]
  );
  await penaliseReceipt(db, receipt);
  return { held: rowCount ?? 0, released: rows.map((r) => ({ escrowId: r.escrow_id, amount: r.amount })) };
}

/**
 * A receipt-subject alarm that also security-holds the receipt's escrow, serialised with a worker
 * settling the same receipt (the intake row is locked first; the worker re-checks the events).
 */
export async function recordReceiptHold(
  db: TxDb,
  e: { type: SecurityEventType; receipt: string; originalHash: string | null; incomingHash: string; detail: string }
): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query('SELECT 1 FROM mpesa_callbacks WHERE mpesa_receipt_id = $1 FOR UPDATE', [e.receipt]);
    await insertSecurityEvent(client, e);
    await securityHoldReceipt(client, e.receipt);
  });
}

/** User / refresh-family alarm; one REFRESH_TOKEN_REUSE per family (partial unique index). */
export async function insertSubjectSecurityEvent(
  db: Db,
  e: { type: SecurityEventType; userId: string | null; familyId?: string | null; detail: string }
): Promise<void> {
  await db.query(
    `INSERT INTO security_events (event_type, subject_user_id, family_id, detail)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [e.type, e.userId, e.familyId ?? null, e.detail.slice(0, 2000)]
  );
}

/**
 * Same receipt, same amount, other channel: Safaricom delivered one payment as both an STK
 * callback and a C2B confirmation. An audit row only — no settlement, no security hold.
 */
export async function recordChannelEcho(
  db: Db,
  receipt: string,
  storedHash: string,
  incomingHash: string,
  detail: string
): Promise<void> {
  await insertSecurityEvent(db, { type: 'STK_CHANNEL_ECHO', receipt, originalHash: storedHash, incomingHash, detail });
}

/**
 * Same receipt, different payload: persist the alarm and force that receipt's escrow to
 * QUARANTINED with security_hold (self-heal never touches it). The intake row is locked first
 * so this serialises with a worker settling the same receipt: either the worker sees the
 * event (and quarantines), or this update sees the worker's escrow. The original is kept.
 */
export async function recordPayloadMutation(
  db: TxDb,
  receipt: string,
  originalHash: string | null,
  incomingHash: string
): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query('SELECT 1 FROM mpesa_callbacks WHERE mpesa_receipt_id = $1 FOR UPDATE', [receipt]);
    await insertSecurityEvent(client, {
      type: 'PAYLOAD_MUTATION',
      receipt,
      originalHash,
      incomingHash,
      detail: 'same receipt delivered with a different payload hash; original kept',
    });
    await securityHoldReceipt(client, receipt);
  });
}

/**
 * True when a security-hold event (payload mutation, or a reconciliation alarm: reversal, amount
 * mismatch, attribution conflict, missing from the statement) was recorded for this receipt.
 */
export async function hasSecurityHold(db: Db, receipt: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM security_events WHERE mpesa_receipt_id = $1 AND event_type = ANY($2::text[]) LIMIT 1`,
    [receipt, SECURITY_HOLD_EVENTS]
  );
  return rows.length > 0;
}
