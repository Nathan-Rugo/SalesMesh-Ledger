import type { Metadata } from 'next';
import { AgentDashboard } from '@/features/agent-ledger/presentation/components/ledger-views';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Ledger' };

export default function AgentPage() {
  return (
    <>
      <PageHeader title="Your ledger" purpose="Commission from every sale, from the customer's payment to your phone." />
      <AgentDashboard />
    </>
  );
}
