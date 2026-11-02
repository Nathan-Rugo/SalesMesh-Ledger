'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError } from '@/core/domain/app-error';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import { formatMsisdnLocal } from '@/shared/domain/msisdn';
import { isStkOpen, maskMsisdn, newIdempotencyKey, type PaymentAttempt, type StkRequest } from '../../domain/entities/stk-request';
import { validatePaymentForm, type PaymentForm } from '../../domain/usecases/collect-usecases';

export const STK_POLL_MS = 3_000;
export const STK_POLL_WINDOW_MS = 3 * 60_000;
const ENDS_SESSION: readonly AppError['kind'][] = ['unauthenticated', 'forbidden', 'pin_change_required'];

export type CollectPhase =
  /** The form. `error` is the last send's failure (network, throttle, refusal, field errors). */
  | { readonly kind: 'form'; readonly error: AppError | null }
  | { readonly kind: 'sending' }
  /** 409 possible_duplicate: the agent must confirm before a second prompt. */
  | { readonly kind: 'duplicate' }
  | {
      readonly kind: 'tracking';
      readonly request: StkRequest;
      /** Masked customer phone and whole shillings, for the slip (the full phone is not kept here). */
      readonly who: string;
      readonly amount: number;
      /** Polling stopped after the window without a final answer. */
      readonly timedOut: boolean;
      /** The last poll failed (the shown status may be behind). */
      readonly stale: boolean;
    };

export interface CollectState {
  readonly phase: CollectPhase;
  /** Values to prefill a fresh form with ("Try again"), or null for an empty one. */
  readonly draft: PaymentForm | null;
  /** Bumped whenever the form must remount (new request / try again). */
  readonly formKey: number;
  submit(form: PaymentForm): Promise<void>;
  /** Resend the unresolved attempt with the same Idempotency-Key (never a second prompt). */
  retry(): Promise<void>;
  confirmDuplicate(): Promise<void>;
  cancelDuplicate(): void;
  /** Restart polling for another window. */
  checkAgain(): void;
  /** Back to an empty form: forgets the customer's phone. */
  newRequest(): void;
  /** Back to the form, prefilled with the last phone and amount. */
  tryAgain(): void;
}

/**
 * Request-payment state machine: form → sending → (duplicate confirm →) tracking, which polls GET
 * status every 3 s for up to 3 min while the page is visible. One Idempotency-Key per attempt: a
 * network failure keeps the attempt (and its key) for Retry, so a retry replays rather than prompts.
 */
export function useCollect(pollMs = STK_POLL_MS, windowMs = STK_POLL_WINDOW_MS): CollectState {
  const { container } = useSession();
  const [phase, setPhase] = useState<CollectPhase>({ kind: 'form', error: null });
  const [draft, setDraft] = useState<PaymentForm | null>(null);
  const [formKey, setFormKey] = useState(0);
  /** The attempt whose outcome is still unknown (network failure / key in flight / duplicate prompt). */
  const attempt = useRef<PaymentAttempt | null>(null);
  /** The last sent phone + amount, memory only, for "Try again". */
  const last = useRef<{ msisdn: string; amount: number } | null>(null);
  const inflight = useRef(false);
  const deadline = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(
    async (a: PaymentAttempt) => {
      if (inflight.current) return;
      inflight.current = true;
      attempt.current = a;
      last.current = { msisdn: a.msisdn, amount: a.amount };
      setPhase({ kind: 'sending' });
      const r = await container.requestPayment.execute(a);
      inflight.current = false;
      if (!alive.current) return;
      if (r.ok) {
        attempt.current = null;
        deadline.current = Date.now() + windowMs;
        setPhase({ kind: 'tracking', request: r.value, who: maskMsisdn(a.msisdn), amount: a.amount, timedOut: false, stale: false });
        return;
      }
      const e = r.error;
      if (e.kind === 'stk_refused' && e.code === 'possible_duplicate') {
        // The form unmounts behind the sheet: keep what was typed for Cancel / a failed confirm.
        setDraft({ phone: formatMsisdnLocal(a.msisdn), amount: String(a.amount) });
        return setPhase({ kind: 'duplicate' });
      }
      // Outcome unknown: keep the attempt so Retry (or the same submit) reuses its key.
      const unresolved = e.kind === 'unavailable' || (e.kind === 'stk_refused' && e.code === 'idempotency_in_progress');
      if (!unresolved) attempt.current = null;
      setPhase({ kind: 'form', error: e });
    },
    [container, windowMs]
  );

  const submit = useCallback(
    async (form: PaymentForm) => {
      const v = validatePaymentForm(form);
      if (!v.ok) return setPhase({ kind: 'form', error: v.error });
      const prev = attempt.current;
      const same = prev && prev.msisdn === v.value.msisdn && prev.amount === v.value.amount;
      await send(same ? prev : { ...v.value, idempotencyKey: newIdempotencyKey(), confirmDuplicate: false });
    },
    [send]
  );

  const retry = useCallback(async () => {
    if (attempt.current) await send(attempt.current);
  }, [send]);

  const confirmDuplicate = useCallback(async () => {
    const prev = attempt.current;
    if (prev) await send({ ...prev, idempotencyKey: newIdempotencyKey(), confirmDuplicate: true });
  }, [send]);

  const cancelDuplicate = useCallback(() => {
    attempt.current = null;
    setPhase({ kind: 'form', error: null });
  }, []);

  const toForm = useCallback((prefill: boolean) => {
    attempt.current = null;
    const l = last.current;
    setDraft(prefill && l ? { phone: formatMsisdnLocal(l.msisdn), amount: String(l.amount) } : null);
    if (!prefill) last.current = null;
    setFormKey((k) => k + 1);
    setPhase({ kind: 'form', error: null });
  }, []);
  const newRequest = useCallback(() => toForm(false), [toForm]);
  const tryAgain = useCallback(() => toForm(true), [toForm]);

  const checkAgain = useCallback(() => {
    deadline.current = Date.now() + windowMs;
    setPhase((p) => (p.kind === 'tracking' ? { ...p, timedOut: false } : p));
  }, [windowMs]);

  // Poll while the request is open, the window is not over and the page is visible.
  const trackingId = phase.kind === 'tracking' ? phase.request.id : null;
  const polling = phase.kind === 'tracking' && isStkOpen(phase.request.status) && !phase.timedOut;
  useEffect(() => {
    if (!polling || trackingId === null) return;
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      // Past the window: one last look (the customer may have paid while the page was hidden), then stop.
      const last = Date.now() >= deadline.current;
      busy = true;
      const r = await container.getPaymentStatus.execute(trackingId);
      busy = false;
      if (stopped) return;
      setPhase((p) => {
        if (p.kind !== 'tracking' || p.request.id !== trackingId) return p;
        if (r.ok) return { ...p, request: r.value, stale: false, timedOut: last };
        // A session-ending failure (the shell signs out) or a request that is gone: polling cannot recover.
        const fatal = ENDS_SESSION.includes(r.error.kind) || (r.error.kind === 'unexpected' && r.error.status === 404);
        return { ...p, stale: true, timedOut: last || fatal };
      });
    };
    const t = setInterval(() => void poll(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [polling, trackingId, container, pollMs]);

  return { phase, draft, formKey, submit, retry, confirmDuplicate, cancelDuplicate, checkAgain, newRequest, tryAgain };
}
