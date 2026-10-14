import { ReceiptEmpty } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

/** Admin cockpit before anything needs attention. */
export function AdminEmptyState() {
  return (
    <ReceiptEmpty eyebrow="Oversight" icon="radar" title="No payouts need review">
      <p>Payouts the risk model flags land here with the reasons behind each score. Everything else clears on its own.</p>
      <div role="group" className="flex flex-wrap gap-2" aria-label="States that need a decision">
        <StatusPill status="QUARANTINED" />
        <StatusPill status="CANARY_VERIFYING" />
      </div>
    </ReceiptEmpty>
  );
}
