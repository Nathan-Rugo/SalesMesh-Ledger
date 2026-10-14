/**
 * Mirror of the gateway's `pinPolicyViolation` and `COMMON_PINS`
 * (backend/gateway/src/auth/credentials.ts). Keep the two lists identical.
 */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '1212', '1122', '1313', '1010', '2000', '2001', '2020', '2580', '0852', '1004', '6969', '4545',
  '1357', '2468', '1984', '1990', '0007', '5683', '1478', '3690', '1236', '1100',
  '121212', '112233', '123123', '123321', '159753', '147258', '258369', '520520', '696969',
  '111222', '100100', '131313', '101010', '007007', '202020', '147369', '789456', '456789',
]);

export type PinViolation = 'pin_format' | 'pin_repeated' | 'pin_sequence' | 'pin_common';

/** Why a PIN is refused, or null when acceptable: 4–6 digits, not all the same, not a run, not common. */
export function pinPolicyViolation(pin: unknown): PinViolation | null {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) return 'pin_format';
  if (/^(\d)\1+$/.test(pin)) return 'pin_repeated';
  const d = [...pin].map(Number);
  const run = (step: number) => d.every((x, i) => i === 0 || x === d[i - 1]! + step);
  if (run(1) || run(-1)) return 'pin_sequence';
  if (COMMON_PINS.has(pin)) return 'pin_common';
  return null;
}

/** Shape-only check for an existing PIN (login, current PIN): the gateway set it under the policy. */
export const isPinShaped = (pin: string): boolean => /^\d{4,6}$/.test(pin);
