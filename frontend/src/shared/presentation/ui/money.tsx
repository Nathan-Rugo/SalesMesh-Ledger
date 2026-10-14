import { formatMoney, moneyParts } from '@/shared/domain/money';
import { cn } from './cn';

export interface MoneyProps {
  /** Integer cents. */
  cents: number | bigint;
  className?: string;
  /** Digits roll in on mount (disabled under reduced motion by the global rule). */
  roll?: boolean;
}

/**
 * Currency Rule: `KES` at 70 % medium, bold mono integer, muted decimals in --sm-ink-muted
 * (AAA on both the receipt paper and the admin night shell). Read as one string by AT.
 */
export function Money({ cents, className, roll = false }: MoneyProps) {
  const p = moneyParts(cents);
  return (
    <span className={cn('inline-flex items-baseline gap-[0.3em] font-mono tabular-nums whitespace-nowrap', className)}>
      <span className="sr-only">{formatMoney(cents)}</span>
      <span aria-hidden className="text-[0.7em] font-medium uppercase text-ink">
        {p.negative ? '-' : ''}
        {p.currency}
      </span>
      <span aria-hidden className="inline-flex items-baseline">
        <span className="inline-flex overflow-hidden font-bold tracking-tight text-ink">
          {roll
            ? [...p.integer].map((ch, i) => (
                <span key={i} className="inline-block animate-roll-in" style={{ animationDelay: `${i * 45}ms` }}>
                  {ch}
                </span>
              ))
            : p.integer}
        </span>
        <span className="text-ink-muted">{p.decimals}</span>
      </span>
    </span>
  );
}
