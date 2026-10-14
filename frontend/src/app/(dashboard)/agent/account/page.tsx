import type { Metadata } from 'next';
import { AccountPanel } from '@/features/auth/presentation/components/account-panel';
import { PageHeader } from '@/shared/presentation/ui/page-header';

export const metadata: Metadata = { title: 'Account' };

export default function AgentAccountPage() {
  return (
    <>
      <PageHeader title="Account" purpose="Who is signed in on this phone, and how to sign out." />
      <AccountPanel />
    </>
  );
}
