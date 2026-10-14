/** Every failure the app can show, normalised from gateway responses and the network. */
export type PinErrorReason =
  | 'pin_format'
  | 'pin_repeated'
  | 'pin_sequence'
  | 'pin_common'
  | 'pin_unchanged'
  | 'current_pin_missing'
  | 'pin_mismatch';

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
    case 'unexpected':
      return 'Something went wrong. Try again.';
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
