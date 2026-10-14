'use client';

import { Money } from '@/shared/presentation/ui/money';
import { Receipt } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';
import { formatHold, holdRemaining, type CommissionAccrual } from '../../domain/entities/ledger';
import { useNow } from '../state/use-ledger';

const REASONS: Record<string, string> = {
  security_hold: 'Held for a security check on the payment.',
  fail_safe: 'Held while the risk check is unavailable.',
  model_decision: 'Flagged by the risk check for review.',
  trust_below_threshold: 'Held for review: new or unusual activity.',
  trust_input_invalid: 'Held for review: payment details incomplete.',
};
const reasonText = (r: string | null) => (r && REASONS[r]) || 'Held for review by your merchant.';

/**
 * Commission not yet clear, soonest first. Countdowns tick from the server's release_due_at; at
 * zero the row reads "Clearing…" until the refetch (owned by useLedger) moves it into the balance.
 */
export function AccrualTimeline({ accruals, pendingCount }: { accruals: readonly CommissionAccrual[]; pendingCount: number }) {
  const holding = accruals.filter((a) => a.status === 'ESCROW_HOLD').length;
  const now = useNow(holding > 0);
  const more = pendingCount - holding;
  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
      <h2 id="timeline-heading" className="text-lg font-bold tracking-[-0.01em] text-ink">
        On its way to your balance
      </h2>
      <Receipt torn="none" className="rounded-2xl">
        <ol className="flex flex-col divide-y divide-dashed divide-line-strong">
          {accruals.map((a) => {
            const left = holdRemaining(now, a.releaseDueAt);
            return (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-col items-start gap-1.5">
                  <Money cents={a.amountCents} className="text-lg" />
                  {a.status === 'QUARANTINED' ? <p className="text-sm text-ink-muted">{reasonText(a.quarantineReason)}</p> : null}
                  {a.status === 'CLEAR' ? <p className="text-sm text-ink-muted">In your payout</p> : null}
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <StatusPill status={a.status} />
                  {a.status === 'ESCROW_HOLD' ? (
                    <p className="text-sm text-ink-muted">
                      {left > 0 ? (
                        <>
                          Clears in{' '}
                          <time dateTime={new Date(a.releaseDueAt).toISOString()} className="font-mono text-ink tabular-nums">
                            {formatHold(left)}
                          </time>
                        </>
                      ) : (
                        'Clearing…'
                      )}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {more > 0 ? <p className="mt-3 text-sm text-ink-muted">and {more} more held, shown as the earliest ones clear.</p> : null}
      </Receipt>
    </section>
  );
}
