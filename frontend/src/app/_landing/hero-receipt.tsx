import { formatMoney, moneyParts } from '@/shared/domain/money';
import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

const SAMPLE_CENTS = 452_500;

/**
 * A sample commission slip in the shape of an M-Pesa confirmation. Server-rendered in its final,
 * stamped state; landing-motion.tsx prints it in when motion is allowed. Labelled as a sample.
 */
export function HeroReceipt() {
  const amount = moneyParts(SAMPLE_CENTS);
  return (
    <div className="relative w-full max-w-[26rem]">
      {/* The printer slot the slip feeds out of. */}
      <div aria-hidden className="h-2.5 rounded-full bg-receipt-ink" />
      <Receipt data-hero-receipt="" role="group" aria-label="Sample commission receipt" className="mx-2 pt-6 pb-7 sm:px-7">
        <div data-hero-line="" className="flex items-center justify-between gap-3">
          <ReceiptEyebrow>Sample receipt</ReceiptEyebrow>
          <span className="font-mono text-[13px] font-medium text-ink tabular-nums">TJK4QX7Z1P</span>
        </div>
        <p data-hero-line="" className="mt-4 text-[15px] text-ink">
          <span className="font-semibold">Confirmed.</span> Commission on a sale to <span className="font-mono whitespace-nowrap tabular-nums">0712 345 678</span>
        </p>
        <p data-hero-line="" className="mt-3 font-mono leading-none whitespace-nowrap tabular-nums">
          <span className="sr-only">{formatMoney(SAMPLE_CENTS)}</span>
          <span aria-hidden className="mr-2 text-[1.25rem] font-medium text-ink">
            KES
          </span>
          <span aria-hidden data-count={SAMPLE_CENTS / 100} className="text-[2.5rem] font-bold tracking-tight text-ink sm:text-[3.25rem]">
            {amount.integer}
          </span>
          <span aria-hidden className="text-[1.5rem] text-ink-muted">
            {amount.decimals}
          </span>
        </p>
        <ReceiptRule />
        <dl data-hero-line="">
          <ReceiptRow label="Customer paid">M-Pesa</ReceiptRow>
          <ReceiptRow label="Held in escrow">until it settles</ReceiptRow>
          <ReceiptRow label="Paid to">0722 ••• 104</ReceiptRow>
        </dl>
        <ReceiptRule />
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-3">
          <span data-hero-line="">
            <StatusPill status="CLEAR" />
          </span>
          <span data-stamp="" className="inline-block">
            <ClearedSeal size="lg" />
          </span>
        </div>
      </Receipt>
    </div>
  );
}
