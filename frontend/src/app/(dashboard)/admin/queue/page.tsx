import type { Metadata } from 'next';
import { RiskQueueView } from '@/features/admin-oversight/presentation/components/oversight-views';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Risk queue' };

export default function AdminQueuePage() {
  return (
    <>
      <PageHeader title="Risk queue" purpose="Commission the risk model froze and payouts M-Pesa never confirmed, waiting for a person to decide." />
      <RiskQueueView />
    </>
  );
}
