/** Every failure the app can show, normalised from gateway responses and the network. */
export type PinErrorReason =
  | 'pin_format'
  | 'pin_repeated'
  | 'pin_sequence'
  | 'pin_common'
  | 'pin_unchanged'
  | 'current_pin_missing'
  | 'pin_mismatch';

/** Gateway refusals of a payout claim or payout-line verification (gh-11), read from the response body. */
export const PAYOUT_REFUSALS = [
  'payout_in_progress',
  'below_minimum',
  'above_maximum',
  'no_active_destination',
  'destination_changing',
  'disclosure_changed',
  'temporarily_unavailable',
  'balance_under_review',
  'payout_failed',
  'payouts_disabled',
  'agent_not_provisioned',
  'already_active',
  'destination_pending',
  'phone_not_payable',
  'verification_failed',
] as const;
export type PayoutRefusal = (typeof PAYOUT_REFUSALS)[number];
export const isPayoutRefusal = (v: unknown): v is PayoutRefusal => typeof v === 'string' && (PAYOUT_REFUSALS as readonly string[]).includes(v);

/** Gateway refusals of an admin override (gh-14), read from the response body; `invalid_note` is also checked locally. */
export const OVERRIDE_REFUSALS = ['already_decided', 'security_hold', 'not_unresolved', 'not_found', 'invalid_note'] as const;
export type OverrideRefusal = (typeof OVERRIDE_REFUSALS)[number];
export const isOverrideRefusal = (v: unknown): v is OverrideRefusal => typeof v === 'string' && (OVERRIDE_REFUSALS as readonly string[]).includes(v);

export type AppError =
  | { readonly kind: 'invalid_credentials' }
  | { readonly kind: 'throttled'; readonly retryAfterS: number | null }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'pin_change_required' }
  | { readonly kind: 'invalid_pin'; readonly reason: PinErrorReason; readonly field: 'pin' | 'current_pin' | 'new_pin' | 'confirm_pin' }
  | { readonly kind: 'invalid_phone' }
  | { readonly kind: 'origin_not_allowed' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'invalid_request' }
  | { readonly kind: 'payout_refused'; readonly code: PayoutRefusal }
  | { readonly kind: 'override_refused'; readonly code: OverrideRefusal }
  | { readonly kind: 'unexpected'; readonly status?: number };

/** Stable, user-facing copy for an error (no enumeration hints). */
export function errorMessage(e: AppError): string {
  switch (e.kind) {
    case 'invalid_credentials':
      return 'Phone or PIN is incorrect.';
    case 'throttled':
      return e.retryAfterS === null ? 'Too many attempts. Wait a few minutes, then try again.' : `Too many attempts. Try again in ${e.retryAfterS} s.`;
    case 'unavailable':
      return "Can't reach SalesMesh. Check your connection and try again.";
    case 'unauthenticated':
      return 'Your session has ended. Sign in again.';
    case 'pin_change_required':
      return 'Set a new PIN to continue.';
    case 'invalid_pin':
      return pinReasonMessage(e.reason);
    case 'invalid_phone':
      return 'Enter a Safaricom or Airtel number, like 0712 345 678.';
    case 'origin_not_allowed':
      return 'This app is not allowed to talk to the SalesMesh gateway. Ask your administrator to add this address to CORS_ORIGINS.';
    case 'forbidden':
      return "Your role can't do that.";
    case 'invalid_request':
      return 'That request was not accepted. Check the details and try again.';
    case 'payout_refused':
      return payoutRefusalMessage(e.code);
    case 'override_refused':
      return overrideRefusalMessage(e.code);
    case 'unexpected':
      return 'Something went wrong. Try again.';
  }
}

/** What a refused claim / line verification means, and the next step. */
export function payoutRefusalMessage(code: PayoutRefusal): string {
  switch (code) {
    case 'payout_in_progress':
      return 'A payout is already on its way. Wait for it to finish before claiming again.';
    case 'below_minimum':
      return 'Your cleared balance is below the payout minimum. Keep selling and claim once it reaches the minimum.';
    case 'above_maximum':
      return 'One cleared amount is above the payout maximum. Ask your merchant to pay it out.';
    case 'no_active_destination':
      return 'Verify your M-Pesa line first, then claim.';
    case 'destination_changing':
      return 'Your payout number is being changed. Claims open again once the change completes or is cancelled.';
    case 'disclosure_changed':
      return 'The payout notice has changed. Read it and accept it again.';
    case 'temporarily_unavailable':
      return 'Not sent, nothing deducted. Try again in a few minutes.';
    case 'balance_under_review':
      return 'Part of your balance is under review, so nothing was sent or deducted. Claim again to receive the rest.';
    case 'payout_failed':
      return 'M-Pesa did not accept the payout. Nothing was deducted: your balance is back.';
    case 'payouts_disabled':
      return 'Payouts are switched off for now. Your commission stays safe on your ledger.';
    case 'agent_not_provisioned':
      return 'Your agent account is not set up yet. Ask your merchant.';
    case 'already_active':
      return 'Your M-Pesa line is already verified.';
    case 'destination_pending':
      return 'A verification is already in progress. Watch for a small M-Pesa payment on your phone.';
    case 'phone_not_payable':
      return 'Your registered number can’t receive M-Pesa payouts. Ask your merchant to update it.';
    case 'verification_failed':
      return 'M-Pesa refused the verification payment. Check your line is active, then try again.';
  }
}

/** What a refused admin override means. */
export function overrideRefusalMessage(code: OverrideRefusal): string {
  switch (code) {
    case 'already_decided':
      return 'Already decided: another admin acted on it, or it cleared on its own. The queue is up to date.';
    case 'security_hold':
      return 'This one is on a security hold. It needs an investigation, not an override.';
    case 'not_unresolved':
      return 'This payout is no longer waiting: it was already resolved. The queue is up to date.';
    case 'not_found':
      return 'This item is no longer in the queue.';
    case 'invalid_note':
      return 'Write a reason between 10 and 280 characters.';
  }
}

export function pinReasonMessage(reason: PinErrorReason): string {
  switch (reason) {
    case 'pin_format':
      return 'Use 4 to 6 digits.';
    case 'pin_repeated':
      return "Don't repeat one digit, like 1111.";
    case 'pin_sequence':
      return "Don't use a run, like 1234 or 9876.";
    case 'pin_common':
      return 'That PIN is too common. Pick another.';
    case 'pin_unchanged':
      return 'Your new PIN must be different from the current one.';
    case 'current_pin_missing':
      return 'Enter your current PIN.';
    case 'pin_mismatch':
      return "The PINs don't match.";
  }
}
