import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Money } from '@/shared/presentation/ui/money';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import type { Payout } from '../../domain/entities/ledger';
import { PayoutsEmptyState } from '../payouts-empty-state';
import { PAYOUT_STATUS_LABEL } from './balance-slip';

const when = (ms: number) => new Date(ms).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });

/** Payout history as M-Pesa receipts, newest first. Only PAID carries the Cleared seal and receipt code. */
export function PayoutHistory({ payouts }: { payouts: readonly Payout[] }) {
  if (payouts.length === 0) return <PayoutsEmptyState />;
  return (
    <ol className="flex flex-col gap-6" aria-label="Payout history">
      {payouts.map((p) => (
        <li key={p.id}>
          <Receipt>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-2">
                <ReceiptEyebrow>M-Pesa payout</ReceiptEyebrow>
                <Money cents={p.amountCents} className="text-[1.75rem] leading-none" />
              </div>
              {p.status === 'PAID' ? <ClearedSeal size="sm" /> : null}
            </div>
            <ReceiptRule />
            <dl>
              <ReceiptRow label="Status">
                <span className={p.status === 'FAILED' ? 'font-sans font-semibold text-danger' : 'font-sans'}>{PAYOUT_STATUS_LABEL[p.status]}</span>
              </ReceiptRow>
              {p.status === 'PAID' && p.receipt ? <ReceiptRow label="M-Pesa receipt">{p.receipt}</ReceiptRow> : null}
              <ReceiptRow label="To">{p.msisdn}</ReceiptRow>
              <ReceiptRow label="Claimed">
                <time dateTime={new Date(p.createdAt).toISOString()}>{when(p.createdAt)}</time>
              </ReceiptRow>
              {p.resolvedAt ? (
                <ReceiptRow label={p.status === 'PAID' ? 'Paid' : 'Closed'}>
                  <time dateTime={new Date(p.resolvedAt).toISOString()}>{when(p.resolvedAt)}</time>
                </ReceiptRow>
              ) : null}
            </dl>
            {p.status === 'FAILED' ? <p className="mt-3 text-sm text-ink-muted">Nothing was deducted. The amount is back in your balance.</p> : null}
            {p.status === 'UNRESOLVED' ? <p className="mt-3 text-sm text-ink-muted">M-Pesa hasn&rsquo;t confirmed this one. Support is checking it; it is never sent twice.</p> : null}
          </Receipt>
        </li>
      ))}
    </ol>
  );
}
