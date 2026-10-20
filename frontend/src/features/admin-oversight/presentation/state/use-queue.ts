'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError } from '@/core/domain/app-error';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import type { OversightQueue } from '../../domain/entities/oversight';

export const POLL_MS = 15_000;
/** Failures after which no queue may stay on screen; any other keeps the last data, marked stale. */
const ENDS_SESSION: readonly AppError['kind'][] = ['unauthenticated', 'forbidden', 'pin_change_required'];

export interface QueueState {
  readonly data: OversightQueue | null;
  readonly error: AppError | null;
  readonly loaded: boolean;
  /** `data` is older than the last attempt (offline / gateway unreachable). */
  readonly stale: boolean;
  refresh(): Promise<void>;
}

/**
 * The risk queue by visibility-aware polling (same rules as the agent ledger, #13): every 15 s while
 * visible, at once on focus or `online`, nothing while hidden. A failed refresh keeps the last data
 * (stale), except a session-ending one, which drops it.
 */
export function useQueue(pollMs: number = POLL_MS): QueueState {
  const { container } = useSession();
  const [state, setState] = useState<Omit<QueueState, 'refresh'>>({ data: null, error: null, loaded: false, stale: false });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const r = await container.getQueue.execute();
    if (!alive.current) return;
    setState((s) => {
      if (r.ok) return { data: r.value, error: null, loaded: true, stale: false };
      if (ENDS_SESSION.includes(r.error.kind)) return { data: null, error: r.error, loaded: true, stale: false };
      return { data: s.data, error: r.error, loaded: true, stale: s.data !== null };
    });
  }, [container]);

  useEffect(() => {
    alive.current = true;
    const wake = () => {
      if (document.visibilityState === 'visible') void refresh();
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

  return { ...state, refresh };
}
