import type { ReactNode } from 'react';
import { Logo } from './logo';
import { Receipt, ReceiptEyebrow, ReceiptRule } from './receipt';

interface ReceiptScreenProps {
  eyebrow: string;
  code?: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Render inside an existing page (e.g. the dashboard shell) instead of as a full screen. */
  inline?: boolean;
}

/** Torn slip for system moments (offline, not found, errors): full screen, or inline in a shell. */
export function ReceiptScreen({ eyebrow, code, title, children, actions, inline = false }: ReceiptScreenProps) {
  const slip = (
    <Receipt torn="both" className="flex flex-col gap-4 pt-6 pb-7">
        <div className="flex items-center justify-between gap-3">
          <ReceiptEyebrow>{eyebrow}</ReceiptEyebrow>
          {code ? <span className="font-mono text-[13px] text-ink-muted tabular-nums">{code}</span> : null}
        </div>
        <ReceiptRule className="my-0" />
        <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-ink">{title}</h1>
        <div className="flex flex-col gap-3 text-ink-muted">{children}</div>
        <ReceiptRule className="my-1" />
        <div className="flex flex-col gap-3">{actions}</div>
      </Receipt>
  );
  if (inline) return <div className="max-w-md">{slip}</div>;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-4 py-10">
      <Logo />
      {slip}
    </main>
  );
}
