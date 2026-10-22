import type { Metadata } from 'next';
import { CollectView } from '@/features/collect-payment/presentation/components/collect-view';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Request payment' };

export default function AgentCollectPage() {
  return (
    <>
      <PageHeader title="Request payment" purpose="Send an M-Pesa prompt to the customer's phone and watch it get paid." />
      <CollectView />
    </>
  );
}
