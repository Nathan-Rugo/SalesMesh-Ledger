import type { Metadata } from 'next';
import { AgentsView } from '@/features/admin-agents/presentation/components/agents-view';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Agents' };

export default function AdminAgentsPage() {
  return (
    <>
      <PageHeader title="Agents" purpose="The sales agents on your merchant account." />
      <AgentsView />
    </>
  );
}
