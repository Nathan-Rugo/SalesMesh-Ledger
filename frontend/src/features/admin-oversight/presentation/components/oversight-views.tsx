'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { errorMessage } from '@/core/domain/app-error';
import { useNow } from '@/features/agent-ledger/presentation/state/use-ledger';
import { buttonClasses, Button } from '@/shared/presentation/ui/button';
import { Icon } from '@/shared/presentation/ui/icon';
import { Receipt, ReceiptEmpty, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import type { OversightQueue } from '../../domain/entities/oversight';
import { AdminEmptyState } from '../admin-empty-state';
import { RiskQueueEmptyState } from '../risk-queue-empty-state';
import { useQueue, type QueueState } from '../state/use-queue';
import { RiskQueueTable, UnresolvedPayouts } from './risk-queue-table';

function Skeleton() {
  return (
    <div role="status" aria-label="Loading the risk queue" className="flex flex-col gap-6">
      <div className="h-44 animate-pulse rounded-2xl bg-inset" />
      <div className="h-28 animate-pulse rounded-2xl bg-inset" />
    </div>
  );
}

/** Loading, error-with-retry and the stale banner around a queue snapshot (same states as the agent ledger). */
function QueueFrame({ queue, children }: { queue: QueueState; children: (q: OversightQueue, offline: boolean) => ReactNode }) {
  const { data, error, loaded, stale, refresh } = queue;
  if (!loaded) return <Skeleton />;
  if (!data) {
    if (error?.kind === 'unauthenticated') return <Skeleton />; // the role guard is already redirecting to sign-in
    return (
      <ReceiptEmpty eyebrow="Risk queue" icon="alert" title="The queue didn't load">
        <p>{error ? errorMessage(error) : 'Something went wrong. Try again.'}</p>
        <div>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </ReceiptEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {stale ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-escrow-hold-border bg-escrow-hold-bg p-3 text-sm font-medium text-escrow-hold-ink">
          <Icon name="offline" className="size-4 shrink-0" />
          Can&rsquo;t reach SalesMesh. Showing the last update; decisions wait until you&rsquo;re back online.
        </p>
      ) : null}
      {children(data, stale)}
    </div>
  );
}

const isEmpty = (q: OversightQueue) => q.totals.escrows === 0 && q.totals.payouts === 0;

/** /admin/queue: frozen commission with the model's reasons and the override actions, then unconfirmed payouts. */
export function RiskQueueView() {
  const queue = useQueue();
  const now = useNow(true, 60_000);
  return (
    <QueueFrame queue={queue}>
      {(q, offline) =>
        isEmpty(q) ? (
          <RiskQueueEmptyState />
        ) : (
          <>
            {q.totals.escrows > 0 ? (
              <RiskQueueTable items={q.escrows} now={now} slaHours={q.slaHours.escrow} total={q.totals.escrows} offline={offline} onChanged={queue.refresh} />
            ) : null}
            {q.totals.payouts > 0 ? (
              <UnresolvedPayouts payouts={q.payouts} now={now} slaHours={q.slaHours.payout} total={q.totals.payouts} offline={offline} onChanged={queue.refresh} />
            ) : null}
          </>
        )
      }
    </QueueFrame>
  );
}

/** /admin: what waits for a decision and what is overdue, linking to the queue. */
export function OversightSummary() {
  const queue = useQueue();
  return (
    <QueueFrame queue={queue}>
      {(q) =>
        isEmpty(q) ? (
          <AdminEmptyState />
        ) : (
          <Receipt className="flex flex-col gap-4">
            <ReceiptEyebrow>Waiting for a decision</ReceiptEyebrow>
            <p className="text-[2.5rem] leading-none font-bold tracking-tight text-ink tabular-nums">{q.totals.escrows + q.totals.payouts}</p>
            <ReceiptRule className="my-0" />
            <dl>
              <ReceiptRow label="Frozen commission">{q.totals.escrows}</ReceiptRow>
              <ReceiptRow label={`Overdue (over ${q.slaHours.escrow} h)`}>
                <span className={q.overdue.escrows ? 'font-semibold text-danger' : undefined}>{q.overdue.escrows}</span>
              </ReceiptRow>
              <ReceiptRow label="Unconfirmed payouts">{q.totals.payouts}</ReceiptRow>
              <ReceiptRow label={`Overdue (over ${q.slaHours.payout} h)`}>
                <span className={q.overdue.payouts ? 'font-semibold text-danger' : undefined}>{q.overdue.payouts}</span>
              </ReceiptRow>
            </dl>
            <Link href="/admin/queue" className={buttonClasses('primary', true)}>
              Open the risk queue
            </Link>
          </Receipt>
        )
      }
    </QueueFrame>
  );
}
