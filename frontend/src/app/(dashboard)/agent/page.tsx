import type { Metadata } from 'next';
import { AgentEmptyState } from '@/features/agent-ledger/presentation/agent-empty-state';

export const metadata: Metadata = { title: 'Ledger' };

export default function AgentPage() {
  return (
    <>
      <h1 className="mb-6 text-3xl font-extrabold tracking-[-0.03em] text-ink">Your ledger</h1>
      <AgentEmptyState />
    </>
  );
}
