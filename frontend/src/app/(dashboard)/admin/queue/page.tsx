import type { Metadata } from 'next';
import { RiskQueueEmptyState } from '@/features/admin-oversight/presentation/risk-queue-empty-state';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Risk queue' };

export default function AdminQueuePage() {
  return (
    <>
      <PageHeader title="Risk queue" purpose="Payouts held by the risk model, waiting for a person to decide." />
      <RiskQueueEmptyState />
    </>
  );
}
