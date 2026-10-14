import type { Metadata } from 'next';
import { PayoutsEmptyState } from '@/features/agent-ledger/presentation/payouts-empty-state';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Payouts' };

export default function AgentPayoutsPage() {
  return (
    <>
      <PageHeader title="Payouts" purpose="Cleared commission sent to your M-Pesa number." />
      <PayoutsEmptyState />
    </>
  );
}
