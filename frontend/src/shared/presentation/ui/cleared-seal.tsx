import type { CSSProperties } from 'react';
import { cn } from './cn';

/** Mark A "Cleared" (docs/brand/logo/cleared-mark.svg, 256 grid): an M whose middle stroke is a tick. */
export const CLEARED_MARK = 'M52 212V124l52 52L204 52v160';

export const CLEARED_SEAL_LABEL = 'Cleared · on the ledger';

const SIZES = {
  sm: { box: 'gap-1.5 px-2 py-1 rounded-md', mark: 16, title: 'text-[13px]', sub: 'text-[10px]' },
  md: { box: 'gap-2 px-3 py-1.5 rounded-lg', mark: 24, title: 'text-[17px]', sub: 'text-[11px]' },
  lg: { box: 'gap-3 px-4 py-2.5 rounded-xl', mark: 36, title: 'text-[24px]', sub: 'text-[13px]' },
} as const;

export interface ClearedSealProps {
  size?: keyof typeof SIZES;
  /** Stamp it on mount (the global reduced-motion rule lands it instantly). */
  animate?: boolean;
  /** Resting tilt, e.g. "-8deg". */
  tilt?: string;
  className?: string;
}

/**
 * The stamp put on money that has cleared. Seal ink (--sm-stamp) is AAA on paper only, so place it
 * on a surface/receipt, never on the bare canvas. Read by AT as one label; the mark is paths only.
 */
export function ClearedSeal({ size = 'md', animate = false, tilt = '-8deg', className }: ClearedSealProps) {
  const s = SIZES[size];
  return (
    <span
      role="img"
      aria-label={CLEARED_SEAL_LABEL}
      data-seal=""
      style={{ '--stamp-tilt': tilt, transform: `rotate(${tilt})` } as CSSProperties}
      className={cn(
        'inline-flex shrink-0 items-center border-[2.5px] border-stamp text-stamp select-none',
        'shadow-[inset_0_0_0_2px_var(--sm-surface),inset_0_0_0_3.5px_var(--sm-stamp)]',
        s.box,
        animate && 'animate-stamp',
        className
      )}
    >
      <svg viewBox="0 0 256 256" width={s.mark} height={s.mark} aria-hidden>
        <path d={CLEARED_MARK} fill="none" stroke="currentColor" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span aria-hidden className="flex flex-col leading-none">
        <span className={cn('font-extrabold tracking-[0.08em] uppercase', s.title)}>Cleared</span>
        <span className={cn('mt-0.5 font-mono font-medium tracking-[0.04em] uppercase', s.sub)}>on the ledger</span>
      </span>
    </span>
  );
}
