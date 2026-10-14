'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppError } from '@/core/domain/app-error';
import { errorMessage } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import { getContainer, type Container } from '@/core/di/container';
import { useToast } from '@/shared/presentation/ui/toast';
import type { Session } from '../../domain/entities/session';
import type { ChangePinInput } from '../../domain/usecases/change-pin';
import type { LoginInput } from '../../domain/usecases/login';

export type SessionStatus = 'resolving' | 'authenticated' | 'anonymous' | 'unreachable' | 'misconfigured';

export interface SessionContextValue {
  readonly status: SessionStatus;
  readonly session: Session | null;
  /** True once a silent refresh has been attempted in this page load. */
  readonly probed: boolean;
  resolve(): Promise<void>;
  login(input: LoginInput): Promise<Result<Session, AppError>>;
  changePin(input: ChangePinInput): Promise<Result<Session, AppError>>;
  /** Fails (and keeps the session) when the gateway couldn't revoke the refresh cookie. */
  logout(): Promise<Result<void, AppError>>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const CHANNEL = 'salesmesh-auth';
type AuthBroadcast = { type: 'signed_out' };

/** Proactive refresh lead time before `expires_in` runs out. */
const REFRESH_LEAD_MS = 60_000;

let originErrorLogged = false;

export function SessionProvider({ children, container: injected }: { children: ReactNode; container?: Container }) {
  const container = useMemo(() => injected ?? getContainer(), [injected]);
  const repo = container.authRepository;
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<{ status: SessionStatus; session: Session | null; probed: boolean }>({
    status: 'resolving',
    session: null,
    probed: false,
  });
  const channel = useRef<BroadcastChannel | null>(null);

  const resolve = useCallback(async () => {
    setState((s) => ({ ...s, status: 'resolving' }));
    const r = await container.refreshSession.execute();
    if (r.ok) {
      setState({ status: 'authenticated', session: r.value, probed: true });
      return;
    }
    let status: SessionStatus = 'anonymous';
    if (r.error.kind === 'origin_not_allowed') {
      status = 'misconfigured';
      if (!originErrorLogged) {
        originErrorLogged = true;
        console.error('[SalesMesh] /api/v1/auth/refresh refused this origin (origin_not_allowed): add it to the gateway CORS_ORIGINS.');
      }
    } else if (r.error.kind === 'unavailable' || r.error.kind === 'unexpected') {
      status = 'unreachable';
    }
    setState({ status, session: null, probed: true });
  }, [container]);

  // Bootstrap: reuse an in-memory session, else refresh only when this browser has signed in before
  // (avoids a guaranteed-401 request on every public page view). The dashboard guard always probes.
  useEffect(() => {
    // Synced after mount on purpose: the server render can't know the session, so the first client
    // render must match it ('resolving') before reading the in-memory session / storage hint.
    /* eslint-disable react-hooks/set-state-in-effect */
    const existing = repo.current();
    if (existing) setState({ status: 'authenticated', session: existing, probed: true });
    else if (repo.hasSessionHint()) void resolve();
    else setState({ status: 'anonymous', session: null, probed: false });
    /* eslint-enable react-hooks/set-state-in-effect */
    return repo.subscribe((session) =>
      setState({ status: session ? 'authenticated' : 'anonymous', session, probed: true })
    );
  }, [repo, resolve]);

  // Proactive refresh ~60 s before the access token expires.
  const expiresAt = state.session?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Math.max(expiresAt - Date.now() - REFRESH_LEAD_MS, 5_000);
    const t = setTimeout(() => void container.refreshSession.execute(), delay);
    return () => clearTimeout(t);
  }, [expiresAt, container]);

  // Cross-tab sign-out (logout, or a PIN change revoking every other session).
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e: MessageEvent<AuthBroadcast>) => {
      if (e.data?.type === 'signed_out') repo.clear();
    };
    channel.current = bc;
    return () => {
      bc.close();
      channel.current = null;
    };
  }, [repo]);

  // Errors from Bearer routes: forced PIN change redirects; forbidden / bad request toast, never sign out.
  // A 401 that survived the refresh + retry ends the session (idempotent if the refresh already did).
  useEffect(
    () =>
      container.http.onError((e) => {
        if (e.kind === 'unauthenticated') repo.clear();
        else if (e.kind === 'pin_change_required') router.replace('/register');
        else if (e.kind === 'forbidden' || e.kind === 'invalid_request') toast(errorMessage(e));
      }),
    [container, repo, router, toast]
  );

  const broadcastSignOut = useCallback(() => channel.current?.postMessage({ type: 'signed_out' } satisfies AuthBroadcast), []);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      resolve,
      login: (input) => container.login.execute(input),
      changePin: async (input) => {
        const r = await container.changePin.execute(input);
        if (r.ok) broadcastSignOut();
        return r;
      },
      logout: async () => {
        const r = await container.logout.execute();
        if (r.ok) broadcastSignOut();
        return r;
      },
    }),
    [state, resolve, container, broadcastSignOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
