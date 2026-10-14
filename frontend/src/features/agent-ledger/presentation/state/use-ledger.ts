'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError } from '@/core/domain/app-error';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import { nextMaturity, type LedgerSnapshot } from '../../domain/entities/ledger';

export const POLL_MS = 15_000;
/** Refetch this long after a hold's release_due_at, so the server's NOW() has passed it too. */
const MATURITY_GRACE_MS = 1_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Failures after which no balance may stay on screen; any other keeps the last data, marked stale. */
const ENDS_SESSION: readonly AppError['kind'][] = ['unauthenticated', 'forbidden', 'pin_change_required'];

export interface LedgerState {
  /** The last good snapshot (memory only), or null. */
  readonly data: LedgerSnapshot | null;
  /** The last refresh's failure, or null. */
  readonly error: AppError | null;
  /** The first fetch has answered (either way). */
  readonly loaded: boolean;
  /** `data` is older than the last attempt (offline / gateway unreachable). */
  readonly stale: boolean;
  refresh(): Promise<void>;
}

/**
 * Live ledger by visibility-aware polling: every 15 s while the tab is visible, at once on focus,
 * `online` or a hold's maturity; nothing while hidden. A failed refresh keeps the last data (stale),
 * except a session-ending one, which drops it so no balance stays on screen.
 */
export function useLedger(pollMs: number = POLL_MS): LedgerState {
  const { container } = useSession();
  const [state, setState] = useState<Omit<LedgerState, 'refresh'>>({ data: null, error: null, loaded: false, stale: false });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const r = await container.getLedger.execute();
    if (!alive.current) return;
    setState((s) => {
      if (r.ok) return { data: r.value, error: null, loaded: true, stale: false };
      if (ENDS_SESSION.includes(r.error.kind)) return { data: null, error: r.error, loaded: true, stale: false };
      return { data: s.data, error: r.error, loaded: true, stale: s.data !== null };
    });
  }, [container]);

  useEffect(() => {
    alive.current = true;
    const visible = () => document.visibilityState === 'visible';
    const wake = () => {
      if (visible()) void refresh();
    };
    void refresh();
    const poll = setInterval(wake, pollMs);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      alive.current = false;
      clearInterval(poll);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [refresh, pollMs]);

  // A countdown reaching zero refetches; the row's state only ever comes from the server.
  const data = state.data;
  useEffect(() => {
    if (!data) return;
    const next = nextMaturity(data, Date.now());
    if (next === null) return;
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') void refresh(); // hidden: visibilitychange refetches on return
    }, Math.min(next - Date.now() + MATURITY_GRACE_MS, MAX_TIMEOUT_MS));
    return () => clearTimeout(t);
  }, [data, refresh]);

  return { ...state, refresh };
}

/** A clock that ticks every `ms` while `active` (countdowns). */
export function useNow(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const start = setTimeout(tick, 0); // the mount-time clock may be stale by the time ticking starts
    const t = setInterval(tick, ms);
    return () => {
      clearTimeout(start);
      clearInterval(t);
    };
  }, [active, ms]);
  return now;
}
