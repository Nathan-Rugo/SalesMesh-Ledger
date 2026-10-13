import { Card } from '@/shared/presentation/ui/card';
import { Icon } from '@/shared/presentation/ui/icon';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

/** Admin cockpit before anything needs attention. */
export function AdminEmptyState() {
  return (
    <Card className="flex flex-col items-start gap-4 p-6 md:p-8">
      <span className="flex size-11 items-center justify-center rounded-xl border border-line text-ink">
        <Icon name="radar" />
      </span>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-bold tracking-[-0.01em] text-ink">No payouts need review</h2>
        <p className="max-w-prose text-[15px] text-ink-muted">
          Payouts the risk model flags land here with the reasons behind each score. Everything else clears on its own.
        </p>
      </div>
      <div role="group" className="flex flex-wrap gap-2" aria-label="States that need a decision">
        <StatusPill status="QUARANTINED" />
        <StatusPill status="CANARY_VERIFYING" />
      </div>
    </Card>
  );
}
