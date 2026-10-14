/**
 * Mirror of the gateway's `normaliseKenyanMsisdn` (backend/gateway/src/domain/callback.ts):
 * a Kenyan mobile number in Daraja's format (2547XXXXXXXX / 2541XXXXXXXX), or null.
 * Accepts 07.. / 01.., 7.. / 1.., 2547.. / 2541.., with or without "+", spaces, dashes, parentheses.
 */
export function normaliseKenyanMsisdn(raw: unknown): string | null {
  const digits = (typeof raw === 'string' ? raw : '').trim().replace(/[\s+()-]/g, '');
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  return null;
}

/** "254712345678" → "0712 345 678" (local display; input that isn't a normalised MSISDN is returned as-is). */
export function formatMsisdnLocal(msisdn: string): string {
  const m = /^254(\d{3})(\d{3})(\d{3})$/.exec(msisdn);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : msisdn;
}
