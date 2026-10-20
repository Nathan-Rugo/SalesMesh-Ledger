import { ReceiptEmpty } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

/** Empty risk queue (#14): nothing frozen and no unconfirmed payout. Says what will appear and when. */
export function RiskQueueEmptyState() {
  return (
    <ReceiptEmpty eyebrow="Risk queue" icon="queue" title="Held payouts will queue here">
      <p>
        When the risk model holds a payout, it lands here with its score and the reasons behind it, so you can release it or keep it
        held.
      </p>
      <div role="group" className="flex flex-wrap gap-2" aria-label="States that queue for a decision">
        <StatusPill status="QUARANTINED" />
        <StatusPill status="CANARY_VERIFYING" />
      </div>
    </ReceiptEmpty>
  );
}
