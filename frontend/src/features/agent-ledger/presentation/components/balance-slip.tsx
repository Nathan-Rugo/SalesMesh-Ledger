import type { ReactNode } from 'react';
import { Money } from '@/shared/presentation/ui/money';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { openPayout, type LedgerSnapshot, type PayoutStatus } from '../../domain/entities/ledger';

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  SENT: 'Sent to M-Pesa',
  UNKNOWN: 'Checking with M-Pesa',
  UNRESOLVED: 'Under review',
  PAID: 'Paid',
  FAILED: 'Failed, nothing deducted',
};

/** Claimable balance slip: what is clear now, what is still held, and a payout in flight. */
export function BalanceSlip({ snapshot, children }: { snapshot: LedgerSnapshot; children?: ReactNode }) {
  const open = openPayout(snapshot);
  const { balance } = snapshot;
  return (
    <Receipt>
      <ReceiptEyebrow>Available to pay out</ReceiptEyebrow>
      <Money cents={balance.cents} roll className="mt-3 text-[2.5rem] leading-none" />
      <ReceiptRule />
      <dl>
        <ReceiptRow label={`In escrow${snapshot.pendingCount ? ` (${snapshot.pendingCount})` : ''}`}>
          <Money cents={snapshot.pendingCents} />
        </ReceiptRow>
        {balance.payableNowCents !== balance.cents && balance.cents > 0 ? (
          <ReceiptRow label="Pays now (whole shillings)">
            <Money cents={balance.payableNowCents} />
          </ReceiptRow>
        ) : null}
        <ReceiptRow label="Payout line">{snapshot.destination ?? <span className="font-sans text-ink-muted">Not verified</span>}</ReceiptRow>
      </dl>
      {open ? (
        <div role="status" className="mt-3 rounded-xl border border-escrow-hold-border bg-escrow-hold-bg p-3 text-escrow-hold-ink">
          <p className="text-[15px] font-semibold">
            Payout {PAYOUT_STATUS_LABEL[open.status].toLowerCase()}: <Money cents={open.amountCents} /> to <span className="font-mono">{open.msisdn}</span>
          </p>
          <p className="text-sm">It updates here on its own. The M-Pesa SMS on your phone confirms it.</p>
        </div>
      ) : null}
      {balance.cents === 0 && !open ? <p className="mt-3 text-[15px] text-ink-muted">Nothing clear yet. Held commission appears below until it clears.</p> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </Receipt>
  );
}
