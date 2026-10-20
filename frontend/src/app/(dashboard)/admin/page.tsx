import type { Metadata } from 'next';
import { OversightSummary } from '@/features/admin-oversight/presentation/components/oversight-views';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Oversight' };

export default function AdminPage() {
  return (
    <>
      <PageHeader title="Oversight" purpose="What needs a decision across your agents' commission." />
      <OversightSummary />
    </>
  );
}
