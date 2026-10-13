import { Card } from '@/shared/presentation/ui/card';
import { Money } from '@/shared/presentation/ui/money';
import { StatusPill } from '@/shared/presentation/ui/status-pill';
import type { EscrowStatus } from '@/shared/domain/escrow-status';

const LIFECYCLE: ReadonlyArray<{ status: EscrowStatus; text: string }> = [
  { status: 'ESCROW_HOLD', text: 'A customer pays by M-Pesa. Your commission is held while the payment settles.' },
  { status: 'CLEAR', text: 'The payment checks out. Your commission is cleared for payout.' },
  { status: 'RELEASED', text: 'The money is sent to your M-Pesa number.' },
];

/** Agent home before the first sale: the balance at zero and how commission moves. */
export function AgentEmptyState() {
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <p className="text-[15px] font-medium text-ink-muted">Available to pay out</p>
        <Money cents={0} roll className="mt-2 text-[2.5rem] leading-none" />
        <p className="mt-4 text-[15px] text-ink-muted">Nothing yet. Commission from your sales appears here as customers pay.</p>
      </Card>

      <section aria-labelledby="lifecycle-heading" className="flex flex-col gap-3">
        <h2 id="lifecycle-heading" className="text-lg font-bold tracking-[-0.01em] text-ink">
          How your commission moves
        </h2>
        <ol className="flex flex-col">
          {LIFECYCLE.map((step, i) => (
            <li key={step.status} className="relative flex gap-4 pb-5 last:pb-0">
              {i < LIFECYCLE.length - 1 ? <span aria-hidden className="absolute top-7 bottom-0 left-[0.6875rem] w-px bg-line" /> : null}
              <span aria-hidden className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface font-mono text-xs font-bold text-ink">
                {i + 1}
              </span>
              <div className="flex flex-col items-start gap-1.5">
                <StatusPill status={step.status} />
                <p className="text-[15px] text-ink">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
