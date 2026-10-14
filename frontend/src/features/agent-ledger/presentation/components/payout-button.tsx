'use client';

import { useState } from 'react';
import { errorMessage, type AppError } from '@/core/domain/app-error';
import { FormAlert } from '@/features/auth/presentation/components/form-feedback';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import { formatMoney } from '@/shared/domain/money';
import { Button } from '@/shared/presentation/ui/button';
import { ReceiptRule } from '@/shared/presentation/ui/receipt';
import { openPayout, type LedgerSnapshot } from '../../domain/entities/ledger';
import { PinConfirm } from './pin-confirm';

/** Why a claim can't start right now, or null when it can. */
export function claimBlocker(s: LedgerSnapshot, offline: boolean): string | null {
  if (offline) return 'Claiming needs a connection. Your balance will refresh when you are back online.';
  if (openPayout(s)) return 'A payout is on its way. You can claim again once it finishes.';
  if (!s.destination) return 'Verify your M-Pesa line below to claim.';
  if (s.destinationChanging) return 'Your payout number is being changed. Claims open again once that completes.';
  if (s.balance.payableNowCents < s.balance.minAmountCents) {
    return s.balance.cents === 0 ? null : `Payouts start at ${formatMoney(s.balance.minAmountCents)}. Keep selling and claim once you reach it.`;
  }
  return null;
}

type Step = 'idle' | 'disclosure' | 'pin';

/**
 * Claim the whole balance: Fuliza disclosure first, then PIN, then one POST. A refusal shows its
 * next step inline; `payout_in_progress` just refetches (the open payout then shows on the slip).
 */
export function PayoutButton({ snapshot, offline, onChanged }: { snapshot: LedgerSnapshot; offline: boolean; onChanged: () => Promise<void> }) {
  const { container } = useSession();
  const [step, setStep] = useState<Step>('idle');
  const [accepted, setAccepted] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const blocker = claimBlocker(snapshot, offline);
  const amount = snapshot.balance.payableNowCents;
  if (snapshot.balance.cents === 0 && !openPayout(snapshot) && step === 'idle' && !message) return null;

  function close() {
    setStep('idle');
    setAccepted(null);
    setNotice(null);
  }

  function onError(e: AppError) {
    if (e.kind === 'payout_refused' && e.code === 'disclosure_changed') {
      // Show the new text and ask again: the refetch brings it in.
      setAccepted(null);
      setNotice(errorMessage(e));
      setStep('disclosure');
      void onChanged();
      return;
    }
    if (e.kind === 'payout_refused' && e.code === 'payout_in_progress') {
      close();
      setMessage(null);
      void onChanged();
      return;
    }
    close();
    setMessage(e.kind === 'unavailable' ? "Can't reach SalesMesh. If the payout went through it will show here in a moment." : errorMessage(e));
    void onChanged();
  }

  return (
    <div className="flex flex-col gap-3">
      {message ? <FormAlert>{message}</FormAlert> : null}
      {step === 'idle' ? (
        <>
          <Button
            block
            disabled={blocker !== null || amount === 0}
            onClick={() => {
              setMessage(null);
              setStep('disclosure');
            }}
          >
            Claim {formatMoney(amount)}
          </Button>
          {blocker ? <p className="text-sm text-ink-muted">{blocker}</p> : null}
        </>
      ) : null}

      {step === 'disclosure' ? (
        <section aria-labelledby="disclosure-heading" className="flex flex-col gap-3">
          <ReceiptRule className="my-1" />
          <h3 id="disclosure-heading" className="text-[15px] font-bold text-ink">
            Before you claim
          </h3>
          {notice ? <FormAlert>{notice}</FormAlert> : null}
          <p className="text-[15px] whitespace-pre-line text-ink">{snapshot.disclosure.text}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              block
              disabled={blocker !== null}
              onClick={() => {
                setAccepted(snapshot.disclosure.version);
                setNotice(null);
                setStep('pin');
              }}
            >
              I understand, continue
            </Button>
            <Button variant="secondary" block onClick={close}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'pin' ? (
        <section aria-label="Confirm payout" className="flex flex-col gap-3">
          <ReceiptRule className="my-1" />
          <p className="text-[15px] text-ink">
            Send <span className="font-mono font-semibold tabular-nums">{formatMoney(amount)}</span> to{' '}
            <span className="font-mono tabular-nums">{snapshot.destination}</span>.
          </p>
          <PinConfirm
            id="claim-pin"
            submitLabel={`Send ${formatMoney(amount)}`}
            disabled={blocker !== null}
            submit={(pin) => container.claimPayout.execute({ pin, acceptedDisclosure: accepted })}
            onDone={() => {
              close();
              setMessage(null);
              void onChanged();
            }}
            onError={onError}
          />
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </section>
      ) : null}
    </div>
  );
}
