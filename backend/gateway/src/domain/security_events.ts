/**
 * @file security_events.ts
 * @description Security event types (security_events.event_type) and the receipt events that put a
 * receipt's escrow on security hold. A leaf module: the security and trust repositories both use it.
 */

export type SecurityEventType =
  | 'ADMIN_UNLOCK'
  | 'ADMIN_DISABLE'
  | 'ADMIN_PIN_RESET'
  | 'PAYLOAD_MUTATION'
  | 'STK_RECEIPT_REPLAY'
  | 'STK_CHANNEL_ECHO'
  | 'REFRESH_TOKEN_REUSE'
  | 'LOGIN_LOCKOUT'
  | 'PIN_CHANGED'
  // Reconciliation (spec gh-6-recon)
  | 'RECONCILE_AMOUNT_MISMATCH'
  | 'PAYMENT_REVERSED'
  | 'RECONCILED_CALLBACK_LATE'
  | 'RECONCILE_ATTRIBUTION_CONFLICT'
  | 'RECONCILE_NOT_ON_STATEMENT'
  | 'STK_STATUS_CONFLICT'
  // Payout destinations (spec gh-11): registration, activation, rejection, cancellation, expiry
  | 'PAYOUT_DESTINATION_CHANGED'
  // Agent-claimed payouts (spec gh-11, part 2): every payout state change; a paid name that differs from full_name
  | 'PAYOUT_STATUS_CHANGED'
  | 'PAYOUT_NAME_MISMATCH'
  // UFAA return (spec gh-11, part 3b): one per agent per step (notice, report, remit)
  | 'UFAA_NOTICE_SENT'
  | 'UFAA_REPORTED'
  | 'UFAA_REMITTED';

/**
 * Receipt events that put the receipt's escrow on security hold (QUARANTINED, never self-healed),
 * whether it is settled before or after the event is recorded.
 */
export const SECURITY_HOLD_EVENTS: readonly SecurityEventType[] = [
  'PAYLOAD_MUTATION',
  'PAYMENT_REVERSED',
  'RECONCILE_AMOUNT_MISMATCH',
  'RECONCILE_ATTRIBUTION_CONFLICT',
  'RECONCILE_NOT_ON_STATEMENT',
];
