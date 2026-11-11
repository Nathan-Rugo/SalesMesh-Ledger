'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError } from '@/core/domain/app-error';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import type { DirectoryAgent } from '../../domain/entities/agent';

export interface AgentsState {
  readonly agents: DirectoryAgent[] | null;
  readonly error: AppError | null;
  readonly loaded: boolean;
  refresh(): Promise<void>;
}

/** Loads the directory once on mount (it changes rarely; no polling) and again on demand. */
export function useAgents(): AgentsState {
  const { container } = useSession();
  const [state, setState] = useState<Omit<AgentsState, 'refresh'>>({ agents: null, error: null, loaded: false });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const r = await container.listAgents.execute();
    if (!alive.current) return;
    setState(r.ok ? { agents: r.value, error: null, loaded: true } : { agents: null, error: r.error, loaded: true });
  }, [container]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  return { ...state, refresh };
}
