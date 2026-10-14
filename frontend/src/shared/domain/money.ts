/** Currency Rule parts for `KES 45,250.00`: amounts are integer cents, never floats. */
export interface MoneyParts {
  readonly currency: 'KES';
  readonly negative: boolean;
  /** Grouped whole shillings, e.g. "45,250". */
  readonly integer: string;
  /** Always two digits with the separator, e.g. ".00". */
  readonly decimals: string;
}

export function moneyParts(cents: number | bigint): MoneyParts {
  if (typeof cents === 'number' && !Number.isSafeInteger(cents)) throw new RangeError('cents must be a safe integer');
  const value = BigInt(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, '0');
  return { currency: 'KES', negative, integer: whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','), decimals: `.${frac}` };
}

/** Plain-text rendering for screen readers and titles: "KES 45,250.00" / "-KES 1.50". */
export function formatMoney(cents: number | bigint): string {
  const p = moneyParts(cents);
  return `${p.negative ? '-' : ''}${p.currency} ${p.integer}${p.decimals}`;
}
