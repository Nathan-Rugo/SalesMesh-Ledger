import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(2_6_23/0.22)]',
  secondary: 'bg-surface text-ink border border-line hover:border-ink-muted',
  ghost: 'bg-transparent text-link hover:bg-inset',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  block?: boolean;
}

/** Button look, also for links that navigate (`<Link className={buttonClasses()}>`). */
export const buttonClasses = (variant: Variant = 'primary', block = false, className?: string): string =>
  cn(
    'press inline-flex min-h-12 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold',
    'disabled:cursor-not-allowed disabled:opacity-60',
    VARIANTS[variant],
    block && 'w-full',
    className
  );

/** 48 px tall (>= 44 px touch target), spring press, `aria-busy` while loading. */
export function Button({ variant = 'primary', loading = false, block = false, className, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, block, className)}
    >
      {loading ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : null}
      {children}
    </button>
  );
}
