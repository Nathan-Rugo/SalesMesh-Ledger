'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/shared/presentation/ui/button';
import { Icon } from '@/shared/presentation/ui/icon';

/**
 * Throttle countdown. `startCountdown(s)` anchors both the deadline and `now` at the same instant
 * (no stale first frame); the interval stops once the deadline passes.
 */
export function useRetryCountdown(): { waitS: number; startCountdown: (seconds: number) => void } {
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (retryAt === null) return;
    const t = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [retryAt]);
  const startCountdown = useCallback((seconds: number) => {
    const t = Date.now();
    setNow(t);
    setRetryAt(t + seconds * 1000);
  }, []);
  return { waitS: retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000)), startCountdown };
}

export const formatCountdown = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Gateway unreachable: keeps the form intact and offers a retry. */
export function UnreachableBanner({ onRetry, busy }: { onRetry: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl border border-escrow-hold-border bg-escrow-hold-bg p-3 text-escrow-hold-ink">
      <Icon name="offline" className="shrink-0" />
      <div className="flex flex-1 flex-col">
        <p className="text-[15px] font-semibold">Can&rsquo;t reach SalesMesh</p>
        <p className="text-sm">Check your connection. What you typed is kept.</p>
      </div>
      <Button variant="secondary" className="shrink-0 px-4" onClick={onRetry} loading={busy}>
        Retry
      </Button>
    </div>
  );
}

/** Form-level message that isn't tied to one field. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft p-3 text-sm font-medium text-danger">
      <Icon name="alert" className="mt-px size-4 shrink-0" />
      {children}
    </p>
  );
}
