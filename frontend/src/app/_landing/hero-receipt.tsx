import { formatMoney, moneyParts } from '@/shared/domain/money';
import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

const SAMPLE_CENTS = 452_500;

/**
 * A countertop thermal printer drawn in CSS: a top face tilted back in perspective (with the paper
 * roll showing through its window), a front face with the status light, and the slot the slip feeds
 * from. Decorative only; landing-motion.tsx blinks the light and judders the body while it prints.
 */
function ThermalPrinter() {
  return (
    <div aria-hidden data-printer="" className="relative z-10 -mx-3 sm:-mx-5">
      {/* Top face, leaning away from the viewer. */}
      <div className="mx-3 h-9 origin-bottom rounded-t-[1.35rem] bg-linear-to-b from-[#3a4a42] to-[#24312b] [transform:perspective(520px)_rotateX(42deg)]">
        <div className="mx-auto h-full w-2/3 pt-2">
          <div className="h-4 rounded-full bg-linear-to-b from-[#f7f4ea] to-[#d9d3c2] shadow-[inset_0_-2px_3px_rgb(0_0_0/0.25)]" />
        </div>
      </div>
      {/* Front face. */}
      <div className="relative h-16 rounded-t-md rounded-b-2xl bg-linear-to-b from-[#2b3832] via-[#1f2a25] to-[#16201b] shadow-[0_1px_0_rgb(255_255_255/0.08)_inset,0_18px_30px_-12px_rgb(10_31_22/0.55),0_4px_8px_-2px_rgb(10_31_22/0.35)]">
        <span className="absolute top-3 left-5 font-mono text-[10px] font-medium tracking-[0.18em] text-white/45 uppercase">SalesMesh · TM-80</span>
        <span className="absolute top-3 right-5 flex items-center gap-1.5">
          <span data-printer-led="" className="size-2 rounded-full bg-[#00d26a] shadow-[0_0_8px_2px_rgb(0_210_106/0.55)]" />
          <span className="size-2 rounded-full bg-white/15" />
        </span>
        {/* The paper slot: a dark groove with a lit lip. */}
        <span className="absolute inset-x-5 bottom-3 h-2 rounded-full bg-black/85 shadow-[inset_0_2px_3px_rgb(0_0_0/0.9),0_1px_0_rgb(255_255_255/0.12)]" />
      </div>
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
    <div className="relative w-full max-w-[26rem]">
      <ThermalPrinter />
      {/* Tucked under the slot lip so the slip reads as feeding out of the printer. */}
      <Receipt data-hero-receipt="" role="group" aria-label="Sample commission receipt" className="relative z-0 mx-3 -mt-2 pt-7 pb-7 sm:px-7">
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
