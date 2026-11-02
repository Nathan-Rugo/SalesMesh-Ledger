'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, type AppError } from '@/core/domain/app-error';
import { FormAlert, formatCountdown, UnreachableBanner, useRetryCountdown } from '@/features/auth/presentation/components/form-feedback';
import { Button, buttonClasses } from '@/shared/presentation/ui/button';
import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Field } from '@/shared/presentation/ui/field';
import { Money } from '@/shared/presentation/ui/money';
import { PhoneInput } from '@/shared/presentation/ui/phone-input';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { failureReason, isStkOpen, STK_MAX_AMOUNT, type StkRequest } from '../../domain/entities/stk-request';
import type { PaymentForm } from '../../domain/usecases/collect-usecases';
import { useCollect, type CollectPhase } from '../state/use-collect';

const AMOUNT_HINT = `Whole shillings, 1 to ${STK_MAX_AMOUNT.toLocaleString('en-KE')}.`;

/** The agent's "Request payment" screen: form → (duplicate confirm) → live status slip. */
export function CollectView() {
  const s = useCollect();
  const { phase } = s;
  if (phase.kind === 'tracking') return <StatusSlip phase={phase} onCheckAgain={s.checkAgain} onNew={s.newRequest} onTryAgain={s.tryAgain} />;
  if (phase.kind === 'duplicate') {
    return (
      <Receipt className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-ink">Prompt again?</h2>
        <p className="text-[15px] text-ink">You asked this customer for the same amount less than a minute ago. If they did not get that prompt, send a new one.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button block onClick={() => void s.confirmDuplicate()}>
            Send another prompt
          </Button>
          <Button variant="secondary" block onClick={s.cancelDuplicate}>
            Cancel
          </Button>
        </div>
      </Receipt>
    );
  }
  return (
    <RequestForm
      key={s.formKey}
      draft={s.draft}
      sending={phase.kind === 'sending'}
      error={phase.kind === 'form' ? phase.error : null}
      onSubmit={(f) => void s.submit(f)}
      onRetry={() => void s.retry()}
    />
  );
}

function RequestForm({
  draft,
  sending,
  error,
  onSubmit,
  onRetry,
}: {
  draft: PaymentForm | null;
  sending: boolean;
  error: AppError | null;
  onSubmit: (f: PaymentForm) => void;
  onRetry: () => void;
}) {
  const [phone, setPhone] = useState(draft?.phone ?? '');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const { waitS, startCountdown } = useRetryCountdown();
  const retryAfterS = error?.kind === 'throttled' ? error.retryAfterS : null;
  useEffect(() => {
    if (retryAfterS) startCountdown(retryAfterS);
  }, [error, retryAfterS, startCountdown]);
  const throttled = waitS > 0;
  const fields = error?.kind === 'invalid_payment_input' ? error : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!sending && !throttled) onSubmit({ phone, amount });
  }

  let alert: string | null = null;
  if (error && !fields && error.kind !== 'unavailable') {
    if (error.kind !== 'throttled') alert = errorMessage(error);
    else if (throttled) alert = `Too many requests. Try again in ${waitS} s.`;
    else if (!error.retryAfterS) alert = errorMessage({ kind: 'throttled', retryAfterS: null });
  }

  return (
    <Receipt className="flex flex-col gap-4">
      <ReceiptEyebrow>Ask a customer to pay by M-Pesa</ReceiptEyebrow>
      {error?.kind === 'unavailable' ? <UnreachableBanner onRetry={onRetry} busy={sending} /> : null}
      {alert ? <FormAlert>{alert}</FormAlert> : null}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field id="collect-phone" label="Customer's phone" error={fields?.phone ? errorMessage({ kind: 'invalid_phone' }) : null}>
          {(aria) => <PhoneInput {...aria} name="phone" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} required />}
        </Field>
        <Field id="collect-amount" label="Amount (KES)" hint={AMOUNT_HINT} error={fields?.amount ? `Enter ${AMOUNT_HINT.toLowerCase()}` : null}>
          {(aria) => (
            <input
              {...aria}
              name="amount"
              inputMode="numeric"
              autoComplete="off"
              maxLength={9}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              className="min-h-13 w-full rounded-xl border border-field-edge bg-surface px-4 font-mono text-lg tabular-nums text-ink aria-invalid:border-danger"
            />
          )}
        </Field>
        <Button type="submit" block loading={sending} disabled={throttled}>
          {throttled ? (
            <span>
              Try again in <span className="font-mono tabular-nums">{formatCountdown(waitS)}</span>
            </span>
          ) : (
            'Send payment prompt'
          )}
        </Button>
      </form>
      <p className="text-sm text-ink-muted">The customer gets an M-Pesa prompt on their phone and confirms with their own PIN.</p>
    </Receipt>
  );
}

/** Headline and next step for each status (spec gh-60 status table). */
function statusCopy(r: StkRequest): { title: string; body: string } {
  switch (r.status) {
    case 'ACCEPTED':
      return { title: 'Check the customer’s phone…', body: 'Waiting for them to enter their M-Pesa PIN.' };
    case 'UNKNOWN':
      return { title: 'Pending confirmation', body: 'M-Pesa has not answered yet. Do not resend: the payment is matched as soon as it confirms.' };
    case 'FAILED':
      return { title: 'Not paid', body: failureReason(r.resultCode) };
    case 'REJECTED':
      return { title: 'No prompt was sent', body: 'M-Pesa did not accept the request. Try again.' };
    case 'EXPIRED':
      return { title: 'No answer from M-Pesa', body: 'Check with the customer whether they paid before asking again.' };
    case 'PAID':
      return { title: 'Paid', body: 'Your commission on this sale is now in escrow on your ledger.' };
  }
}

function StatusSlip({
  phase,
  onCheckAgain,
  onNew,
  onTryAgain,
}: {
  phase: Extract<CollectPhase, { kind: 'tracking' }>;
  onCheckAgain: () => void;
  onNew: () => void;
  onTryAgain: () => void;
}) {
  const { request, who, amount, timedOut, stale } = phase;
  const open = isStkOpen(request.status);
  const waiting = open && timedOut;
  const copy = statusCopy(request);
  const retryable = request.status === 'FAILED' || request.status === 'REJECTED';
  return (
    <Receipt className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div role="status" aria-live="polite" className="flex flex-col gap-1">
          <h2 className="text-xl font-bold text-ink">{waiting ? 'Still waiting' : copy.title}</h2>
          <p className="text-[15px] text-ink">{waiting ? 'No answer after 3 minutes. Check again, or ask the customer.' : copy.body}</p>
          {stale && open ? <p className="text-sm text-ink-muted">Can&rsquo;t reach SalesMesh right now; still trying.</p> : null}
        </div>
        {request.status === 'PAID' ? <ClearedSeal animate /> : null}
        {open && !timedOut ? <span className="mt-1 size-5 shrink-0 animate-spin rounded-full border-2 border-ink-muted border-r-transparent" aria-hidden /> : null}
      </div>
      <ReceiptRule className="my-0" />
      <dl>
        <ReceiptRow label="Amount">
          <Money cents={amount * 100} />
        </ReceiptRow>
        <ReceiptRow label="Customer">{who}</ReceiptRow>
        {request.receipt ? <ReceiptRow label="M-Pesa receipt">{request.receipt}</ReceiptRow> : null}
      </dl>
      <div className="flex flex-col gap-2 sm:flex-row">
        {waiting ? (
          <Button block onClick={onCheckAgain}>
            Check again
          </Button>
        ) : null}
        {retryable ? (
          <Button block onClick={onTryAgain}>
            Try again
          </Button>
        ) : null}
        {request.status === 'PAID' ? (
          <Link href="/agent" className={buttonClasses('secondary', true)}>
            See it in your ledger
          </Link>
        ) : null}
        {!open || waiting ? (
          <Button variant={retryable || waiting ? 'secondary' : 'primary'} block onClick={onNew}>
            New request
          </Button>
        ) : null}
      </div>
    </Receipt>
  );
}
