'use client';

import { Money } from '@/shared/presentation/ui/money';
import { Receipt, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';
import { formatAge, type FrozenItem, type UnresolvedPayout } from '../../domain/entities/oversight';
import { OverrideSheet } from './override-sheet';
import { reasonText, SHAPWaterfallCard } from './shap-waterfall-card';

const ago = (now: number, at: number) => `${formatAge(now - at)} ago`;

function Overdue({ hours }: { hours: number }) {
  return (
    <span className="inline-flex items-center rounded-full border border-danger bg-danger-soft px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap text-danger">
      Overdue<span className="sr-only">: waiting longer than {hours} h</span>
    </span>
  );
}

function Agent({ name, code }: { name: string; code: string | null }) {
  return (
    <p className="text-[15px] font-semibold text-ink">
      {name}
      {code ? <span className="ml-2 font-mono text-[13px] font-medium text-ink-muted">{code}</span> : null}
    </p>
  );
}

const capped = (shown: number, total: number) =>
  shown < total ? <p className="text-sm text-ink-muted">Showing {shown} of {total}, most urgent first. The rest appear as these are decided.</p> : null;

export interface QueueListProps {
  now: number;
  slaHours: number;
  total: number;
  offline: boolean;
  onChanged: () => Promise<void>;
}

/** Quarantined commission, overdue first (server order): who, how much, why, how long, and the model's reasons. */
export function RiskQueueTable({ items, now, slaHours, total, offline, onChanged }: QueueListProps & { items: readonly FrozenItem[] }) {
  return (
    <section aria-labelledby="queue-escrows" className="flex flex-col gap-3">
      <h2 id="queue-escrows" className="text-lg font-bold tracking-[-0.01em] text-ink">
        Frozen commission <span className="font-mono text-ink-muted tabular-nums">({total})</span>
      </h2>
      {capped(items.length, total)}
      <ol className="flex flex-col gap-5" aria-label="Frozen commission">
        {items.map((e) => (
          <li key={e.id}>
            <Receipt torn="none" className="flex flex-col gap-4 rounded-2xl">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <Agent name={e.agentName} code={e.agentCode} />
                  <Money cents={e.amountCents} className="text-[1.5rem] leading-none" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {e.overdue ? <Overdue hours={slaHours} /> : null}
                  <StatusPill status="QUARANTINED" />
                </div>
              </div>
              <dl>
                <ReceiptRow label="Why">
                  <span className="font-sans">{e.securityHold ? 'Security hold' : reasonText(e.reason)}</span>
                </ReceiptRow>
                <ReceiptRow label="Frozen">
                  <time dateTime={new Date(e.frozenAt).toISOString()}>{ago(now, e.frozenAt)}</time>
                </ReceiptRow>
                <ReceiptRow label="M-Pesa receipt">{e.receipt}</ReceiptRow>
              </dl>
              {e.reviewedAt ? (
                <p className="text-sm text-ink-muted">
                  Reviewed by an admin <time dateTime={new Date(e.reviewedAt).toISOString()}>{ago(now, e.reviewedAt)}</time>; kept held.
                </p>
              ) : null}
              <ReceiptRule className="my-0" />
              <SHAPWaterfallCard item={e} />
              {e.securityHold ? null : <OverrideSheet kind="escrow" id={e.id} offline={offline} onChanged={onChanged} />}
            </Receipt>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Payouts M-Pesa never confirmed: settle each from the org portal or a statement line. Masked numbers only. */
export function UnresolvedPayouts({ payouts, now, slaHours, total, offline, onChanged }: QueueListProps & { payouts: readonly UnresolvedPayout[] }) {
  return (
    <section aria-labelledby="queue-payouts" className="flex flex-col gap-3">
      <h2 id="queue-payouts" className="text-lg font-bold tracking-[-0.01em] text-ink">
        Unconfirmed payouts <span className="font-mono text-ink-muted tabular-nums">({total})</span>
      </h2>
      <p className="max-w-prose text-sm text-ink-muted">M-Pesa never confirmed these. Check the B2C org portal, then record what happened. Nothing is sent again.</p>
      {capped(payouts.length, total)}
      <ol className="flex flex-col gap-5" aria-label="Unconfirmed payouts">
        {payouts.map((p) => (
          <li key={p.id}>
            <Receipt torn="none" className="flex flex-col gap-4 rounded-2xl">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <Agent name={p.agentName} code={p.agentCode} />
                  <Money cents={p.amountCents} className="text-[1.5rem] leading-none" />
                </div>
                {p.overdue ? <Overdue hours={slaHours} /> : null}
              </div>
              <dl>
                <ReceiptRow label="To">{p.msisdn}</ReceiptRow>
                {p.unresolvedAt ? (
                  <ReceiptRow label="Unconfirmed">
                    <time dateTime={new Date(p.unresolvedAt).toISOString()}>{ago(now, p.unresolvedAt)}</time>
                  </ReceiptRow>
                ) : null}
              </dl>
              <OverrideSheet kind="payout" id={p.id} offline={offline} onChanged={onChanged} />
            </Receipt>
          </li>
        ))}
      </ol>
    </section>
  );
}
