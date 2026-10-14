import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Receipt } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';
import type { EscrowStatus } from '@/shared/domain/escrow-status';

const LIFECYCLE: ReadonlyArray<{ status: EscrowStatus; text: string }> = [
  { status: 'ESCROW_HOLD', text: 'A customer pays by M-Pesa. Your commission is held while the payment settles.' },
  { status: 'CLEAR', text: 'The payment checks out. Your commission is cleared for payout.' },
  { status: 'RELEASED', text: 'The money is sent to your M-Pesa number.' },
];

/** How commission moves: shown on the agent home before the first sale. */
export function CommissionLifecycle() {
  return (
    <section aria-labelledby="lifecycle-heading" className="flex flex-col gap-3">
      <h2 id="lifecycle-heading" className="text-lg font-bold tracking-[-0.01em] text-ink">
        How your commission moves
      </h2>
      <Receipt torn="none" className="rounded-2xl">
        <ol className="flex flex-col">
          {LIFECYCLE.map((step, i) => (
            <li key={step.status} className="relative flex gap-4 pb-5 last:pb-0">
              {i < LIFECYCLE.length - 1 ? <span aria-hidden className="absolute top-7 bottom-0 left-[0.6875rem] border-l-[1.5px] border-dashed border-line-strong" /> : null}
              <span aria-hidden className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface font-mono text-xs font-bold text-ink">
                {i + 1}
              </span>
              <div className="flex flex-1 flex-col items-start gap-1.5">
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  <StatusPill status={step.status} />
                  {step.status === 'CLEAR' ? <ClearedSeal size="sm" tilt="-6deg" /> : null}
                </div>
                <p className="text-[15px] text-ink">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Receipt>
    </section>
  );
}
