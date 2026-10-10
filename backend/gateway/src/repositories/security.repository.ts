/**
 * @file security.repository.ts
 * @description Persistent security alarms. Subject-generic (spec gh-5): a receipt (payload
 * mutation, STK receipt replay, STK/C2B cross-channel echo) or a user / refresh-token family
 * (refresh token reuse, login lockout, PIN change).
 */

import type { Db, TxDb } from './db.types';
import { withTransaction } from './db.types';

export type SecurityEventType =
  | 'ADMIN_UNLOCK'
  | 'ADMIN_DISABLE'
  | 'ADMIN_PIN_RESET'
  | 'PAYLOAD_MUTATION'
  | 'STK_RECEIPT_REPLAY'
  | 'STK_CHANNEL_ECHO'
  | 'REFRESH_TOKEN_REUSE'
  | 'LOGIN_LOCKOUT'
  | 'PIN_CHANGED';

/** Receipt-subject alarm; deduplicated on (type, receipt, incoming hash). */
export async function insertSecurityEvent(
  db: Db,
  e: { type: SecurityEventType; receipt: string; originalHash: string | null; incomingHash: string; detail: string }
): Promise<void> {
  await db.query(
    `INSERT INTO security_events (event_type, mpesa_receipt_id, original_hash, incoming_hash, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [e.type, e.receipt, e.originalHash, e.incomingHash, e.detail.slice(0, 2000)]
  );
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
    await client.query(
      `UPDATE escrow_accounts e
          SET escrow_status = 'QUARANTINED', security_hold = TRUE,
              rescore_claimed_at = NULL, rescore_claim_token = NULL
         FROM transactions t
        WHERE t.transaction_id = e.transaction_id AND t.mpesa_receipt_id = $1
          AND e.escrow_status <> 'RELEASED'`,
      [receipt]
    );
  });
}

/** True when a payload mutation was recorded for this receipt. */
export async function hasPayloadMutation(db: Db, receipt: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM security_events WHERE mpesa_receipt_id = $1 AND event_type = 'PAYLOAD_MUTATION' LIMIT 1`,
    [receipt]
  );
  return rows.length > 0;
}
