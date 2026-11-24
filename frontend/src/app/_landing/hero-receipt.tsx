import { formatMoney, moneyParts } from '@/shared/domain/money';
import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

const SAMPLE_CENTS = 452_500;

/**
 * A simple countertop thermal printer. Its mouth is the bottom edge: the slip sits inside a clipping
 * box that starts there, so when landing-motion.tsx feeds it down it comes out of the printer.
 */
function ThermalPrinter() {
  return (
    <div aria-hidden data-printer="" className="relative z-10 -mx-4 sm:-mx-6">
      <div className="relative h-14 rounded-[1.25rem] bg-linear-to-b from-[#34433c] to-[#17211c] shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_16px_26px_-14px_rgb(10_31_22/0.55)]">
        <span data-printer-led="" className="absolute top-1/2 right-5 size-2 -translate-y-1/2 rounded-full bg-[#00d26a] shadow-[0_0_8px_2px_rgb(0_210_106/0.55)]" />
      </div>
      {/* The mouth: a dark lip just wider than the paper. */}
      <span className="absolute inset-x-6 -bottom-1 h-2 rounded-full bg-[#0b120f] shadow-[inset_0_1px_2px_rgb(0_0_0/0.9)]" />
    </div>
  );
}

/**
 * A sample commission slip in the shape of an M-Pesa confirmation. Server-rendered in its final,
 * stamped state; landing-motion.tsx prints it in when motion is allowed. Labelled as a sample.
 */
export function HeroReceipt() {
  const amount = moneyParts(SAMPLE_CENTS);
  return (
    <div data-tilt="hero" className="relative w-full max-w-[26rem] will-change-transform">
      <ThermalPrinter />
      {/* Clipped at the mouth (padding keeps the paper's side and bottom shadow visible). */}
      <div className="relative -mx-4 -mt-1 overflow-hidden px-4 pb-10 sm:-mx-6 sm:px-6">
        {/* The lip's shadow on the paper as it leaves the mouth. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 z-10 h-3 bg-linear-to-b from-black/25 to-transparent" />
      <Receipt data-hero-receipt="" role="group" aria-label="Sample commission receipt" className="mx-3 pt-6 pb-7 sm:px-7">
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
          <span data-stamp="" className="relative inline-block">
            <ClearedSeal size="lg" />
            {/* Ink ring that spreads once as the stamp lands. */}
            <span aria-hidden data-stamp-ink="" className="pointer-events-none absolute inset-0 rounded-xl border-2 border-[var(--sm-stamp)] opacity-0" />
          </span>
        </div>
      </Receipt>
      </div>
    </div>
  );
}
