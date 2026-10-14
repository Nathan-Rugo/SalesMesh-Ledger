import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Icon, type IconName } from './icon';

const TORN = { none: '', bottom: 'torn-bottom mb-2', top: 'torn-top mt-2', both: 'torn-top torn-bottom my-2' } as const;

/** Thermal-paper slip: the surface every money moment sits on. Torn edges follow the shell theme. */
export function Receipt({ className, torn = 'bottom', ...rest }: HTMLAttributes<HTMLDivElement> & { torn?: keyof typeof TORN }) {
  return <div {...rest} className={cn('sm-surface paper-shadow relative bg-surface px-5 py-5 sm:px-6', TORN[torn], className)} />;
}

/** Dashed printer rule between receipt blocks. */
export function ReceiptRule({ className }: { className?: string }) {
  return <hr className={cn('rule-dashed my-4', className)} />;
}

/** Quiet sentence-case label at the top of a slip (e.g. "Available to pay out"). */
export function ReceiptEyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-[13px] font-medium text-ink-muted', className)}>{children}</p>;
}

/** One "label ........ value" line. Render inside a <dl>. */
export function ReceiptRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-1 text-[15px]', className)}>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-mono text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/** Honest empty state on a slip: what will appear here, and when. */
export function ReceiptEmpty({
  eyebrow,
  icon,
  title,
  children,
  className,
}: {
  eyebrow: string;
  icon: IconName;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Receipt className={cn('flex flex-col gap-4 md:px-8 md:py-7', className)}>
      <div className="flex items-center justify-between gap-3">
        <ReceiptEyebrow>{eyebrow}</ReceiptEyebrow>
        <span className="flex size-11 items-center justify-center rounded-xl border border-line text-ink">
          <Icon name={icon} />
        </span>
      </div>
      <ReceiptRule className="my-0" />
      <h2 className="text-xl font-bold tracking-[-0.01em] text-ink">{title}</h2>
      <div className="flex max-w-prose flex-col gap-3 text-[15px] text-ink-muted">{children}</div>
    </Receipt>
  );
}
