/**
 * @file payout_destination.ts
 * @description Pure rules for verified payout destinations (spec gh-11): the M-Pesa registered-name
 * match and phone masking.
 */

export type DestinationStatus = 'PENDING_VERIFICATION' | 'COOLING_OFF' | 'ACTIVE' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/**
 * Upper-case, accents folded (NFKD, combining marks dropped), "-", "_" and "." split words, any
 * other non-letter dropped, split on whitespace ("O'Brien-Kamau" → ["OBRIEN", "KAMAU"]).
 */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[-_.]/g, ' ')
    .replace(/[^\p{L}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The M-Pesa registered name matches `fullName` when at least 2 of its (distinct) tokens appear in
 * `fullName`, or all of them when it has only one. No name, no match.
 */
export function namesMatch(mpesaName: string | null, fullName: string): boolean {
  if (!mpesaName) return false;
  const mpesa = [...new Set(nameTokens(mpesaName))];
  const full = new Set(nameTokens(fullName));
  const hits = mpesa.filter((t) => full.has(t)).length;
  return mpesa.length === 1 ? hits === 1 : hits >= 2;
}

/** "254712345678" → "2547******78": the only form a phone takes in APIs and logs. */
export function maskMsisdn(msisdn: string): string {
  if (msisdn.length <= 6) return '*'.repeat(msisdn.length);
  return `${msisdn.slice(0, 4)}${'*'.repeat(msisdn.length - 6)}${msisdn.slice(-2)}`;
}
