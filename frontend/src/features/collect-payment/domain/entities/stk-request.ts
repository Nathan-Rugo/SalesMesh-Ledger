/**
 * An STK Push payment request as the agent sees it. `PAID` is the gateway's `paid: true` (settlement
 * consumed a receipt), whatever the raw status says. PENDING / PAID_UNCONFIRMED / RECONCILE_EXHAUSTED
 * all read as `UNKNOWN`: an answer is still coming, and resending could charge twice.
 */
export type StkStatus = 'ACCEPTED' | 'UNKNOWN' | 'FAILED' | 'REJECTED' | 'EXPIRED' | 'PAID';

export interface StkRequest {
  readonly id: string;
  readonly status: StkStatus;
  /** Daraja's ResultCode of a FAILED request (e.g. "1032" cancelled), or null. */
  readonly resultCode: string | null;
  /** The M-Pesa receipt once paid, or null. */
  readonly receipt: string | null;
}

/** One send to the gateway. The key is reused on a network retry, never across attempts. */
export interface PaymentAttempt {
  /** Normalised 2547XXXXXXXX / 2541XXXXXXXX. */
  readonly msisdn: string;
  /** Whole shillings. */
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly confirmDuplicate: boolean;
}

export const STK_MIN_AMOUNT = 1;
export const STK_MAX_AMOUNT = 250_000;

/** Statuses that will still change: keep polling. */
export const isStkOpen = (s: StkStatus): boolean => s === 'ACCEPTED' || s === 'UNKNOWN';

/** Whole shillings from the form, as the gateway accepts them (1..250,000, digits only), or null. */
export function parseStkAmount(raw: string): number | null {
  const t = raw.trim();
  // Thousands grouping only: "1,00" (a decimal comma) must not become 100.
  if (!/^(\d{1,7}|\d{1,3}(,\d{3}){1,2})$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return n >= STK_MIN_AMOUNT && n <= STK_MAX_AMOUNT ? n : null;
}

/** 128 random bits as hex: fits the gateway's key charset; getRandomValues works outside secure contexts too. */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `stk-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** "254712345678" → "0712 ••• 678": enough for the agent to recognise, never the full number. */
export function maskMsisdn(msisdn: string): string {
  const m = /^254(\d{3})\d{3}(\d{3})$/.exec(msisdn);
  return m ? `0${m[1]} ••• ${m[2]}` : '•••';
}

/** What a FAILED request's ResultCode means for the agent (Daraja's documented codes). */
export function failureReason(resultCode: string | null): string {
  switch (resultCode) {
    case '1032':
      return 'Customer cancelled the prompt.';
    case '1037':
      return "The customer's phone could not be reached, or they did not answer in time.";
    case '1':
      return "The customer's M-Pesa balance is too low.";
    case '2001':
      return 'The customer entered a wrong M-Pesa PIN.';
    case '1025':
    case '9999':
      return 'M-Pesa could not send the prompt.';
    default:
      return 'The payment was not completed.';
  }
}
