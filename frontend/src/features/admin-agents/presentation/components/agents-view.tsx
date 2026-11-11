'use client';

import { errorMessage } from '@/core/domain/app-error';
import { AgentsEmptyState } from '@/features/admin-oversight/presentation/agents-empty-state';
import { Button } from '@/shared/presentation/ui/button';
import { Receipt, ReceiptEmpty } from '@/shared/presentation/ui/receipt';
import type { DirectoryAgent } from '../../domain/entities/agent';
import { useAgents } from '../state/use-agents';

const PAYOUT_LABEL: Record<string, string> = { ACTIVE: 'Active', PENDING_VERIFICATION: 'Verifying', COOLING_OFF: 'Cooling off' };

// Literal class strings so Tailwind's scanner emits them.
const TONES = {
  ok: 'border-escrow-clear-border bg-escrow-clear-bg text-escrow-clear-ink',
  wait: 'border-escrow-hold-border bg-escrow-hold-bg text-escrow-hold-ink',
  off: 'border-escrow-quarantined-border bg-escrow-quarantined-bg text-escrow-quarantined-ink',
};

function Badge({ tone, children }: { tone: keyof typeof TONES; children: string }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

function AgentRow({ a }: { a: DirectoryAgent }) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-semibold text-ink">
          <span className="font-mono">{a.agentCode ?? 'No code'}</span> <span className="font-normal text-ink-muted">{a.name}</span>
        </p>
        <p className="text-[15px] text-ink-muted">
          <span className="font-mono tabular-nums">{a.msisdn}</span>
          {a.payout ? ` · Payout ${a.payout.msisdn} (${PAYOUT_LABEL[a.payout.status] ?? a.payout.status})` : ' · No payout number yet'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {a.disabled ? <Badge tone="off">Disabled</Badge> : null}
        <Badge tone={a.activated ? 'ok' : 'wait'}>{a.activated ? 'Activated' : 'Not activated'}</Badge>
      </div>
    </li>
  );
}

const Loading = () => <div role="status" aria-label="Loading agents" className="h-44 animate-pulse rounded-2xl bg-inset" />;

/** /admin/agents: the merchant's sales agents (read-only). */
export function AgentsView() {
  const { agents, error, loaded, refresh } = useAgents();
  if (!loaded || error?.kind === 'unauthenticated') return <Loading />; // unauthenticated: the role guard is redirecting to sign-in
  if (!agents) {
    return (
      <ReceiptEmpty eyebrow="Agents" icon="alert" title="The agents didn't load">
        <p>{error ? errorMessage(error) : 'Something went wrong. Try again.'}</p>
        <div>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </ReceiptEmpty>
    );
  }
  if (agents.length === 0) return <AgentsEmptyState />;
  return (
    <Receipt>
      <ul aria-label="Sales agents" className="divide-y divide-line">
        {agents.map((a, i) => (
          <AgentRow key={a.agentCode ?? `n${i}`} a={a} />
        ))}
      </ul>
    </Receipt>
  );
}
