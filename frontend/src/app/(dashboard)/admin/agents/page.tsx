import type { Metadata } from 'next';
import { AgentsEmptyState } from '@/features/admin-oversight/presentation/agents-empty-state';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Agents' };

export default function AdminAgentsPage() {
  return (
    <>
      <PageHeader title="Agents" purpose="The sales agents on your merchant account." />
      <AgentsEmptyState />
    </>
  );
}
