'use client';

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, type AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import { FormAlert } from '@/features/auth/presentation/components/form-feedback';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import { Button } from '@/shared/presentation/ui/button';
import { Receipt, ReceiptEyebrow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import type { LedgerSnapshot, PayoutLine } from '../../domain/entities/ledger';
import { PinConfirm } from './pin-confirm';

const when = (ms: number) => new Date(ms).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * "Verify my M-Pesa line": registers the agent's login phone as the payout line (the gateway sends
 * a small verification payment to it). Shown while no line is ACTIVE or a replacement is in flight.
 */
export function PayoutLineCard({ snapshot, offline, onChanged }: { snapshot: LedgerSnapshot; offline: boolean; onChanged: () => Promise<void> }) {
  const { container } = useSession();
  const [lines, setLines] = useState<readonly PayoutLine[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const apply = useCallback((r: Result<readonly PayoutLine[], AppError>) => {
    if (r.ok) {
      setLines(r.value);
      setLoadError(null);
    } else setLoadError(r.error);
  }, []);
  const load = useCallback(async () => apply(await container.getPayoutLines.execute()), [container, apply]);

  // Reloaded with every ledger refresh, so a pending check that fails or expires doesn't linger.
  useEffect(() => {
    void container.getPayoutLines.execute().then(apply);
  }, [container, apply, snapshot]);

  const pending = lines?.find((l) => l.status === 'PENDING_VERIFICATION');
  const cooling = lines?.find((l) => l.status === 'COOLING_OFF');
  // Newest first: the last check didn't go through.
  const rejected = ['REJECTED', 'EXPIRED', 'CANCELLED'].includes(lines?.[0]?.status ?? '');

  function onError(e: AppError) {
    setVerifying(false);
    setMessage(errorMessage(e));
    void load();
    void onChanged();
  }

  return (
    <Receipt aria-labelledby="line-heading">
      <ReceiptEyebrow>Payout line · M-Pesa</ReceiptEyebrow>
      <h2 id="line-heading" className="mt-2 text-xl font-bold tracking-[-0.01em] text-ink">
        Verify my M-Pesa line
      </h2>
      <ReceiptRule />
      <div className="flex flex-col gap-3 text-[15px]">
        {message ? <FormAlert>{message}</FormAlert> : null}
        {lines === null && !loadError ? <div role="status" aria-label="Loading" className="h-12 animate-pulse rounded-xl bg-inset" /> : null}
        {loadError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-ink-muted">{errorMessage(loadError)}</p>
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : null}
        {pending ? (
          <p className="text-ink">
            Verification sent to <span className="font-mono tabular-nums">{pending.msisdn}</span>. Watch for a small M-Pesa payment on your
            phone; claims open once it confirms.
          </p>
        ) : null}
        {cooling ? (
          <p className="text-ink">
            Your new number <span className="font-mono tabular-nums">{cooling.msisdn}</span> becomes your payout line on{' '}
            {cooling.coolingOffUntil ? <time dateTime={new Date(cooling.coolingOffUntil).toISOString()}>{when(cooling.coolingOffUntil)}</time> : 'soon'}.
            This wait protects you from SIM-swap fraud.
          </p>
        ) : null}
        {lines !== null && !pending && !cooling ? (
          <>
            <p className="text-ink-muted">
              Payouts go only to your own registered number. We send a small payment to check the line is yours, then you can claim.
            </p>
            {rejected ? <p className="text-ink-muted">The last check didn&rsquo;t go through. You can try again.</p> : null}
            {verifying ? (
              <PinConfirm
                id="line-pin"
                submitLabel="Verify my line"
                disabled={offline}
                submit={(pin) => container.verifyPayoutLine.execute({ pin })}
                onDone={() => {
                  setVerifying(false);
                  setMessage(null);
                  void load();
                  void onChanged();
                }}
                onError={onError}
              />
            ) : (
              <Button
                block
                disabled={offline}
                onClick={() => {
                  setMessage(null);
                  setVerifying(true);
                }}
              >
                Verify my M-Pesa line
              </Button>
            )}
          </>
        ) : null}
      </div>
    </Receipt>
  );
}
