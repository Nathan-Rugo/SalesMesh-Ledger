import { Logo } from '@/shared/presentation/ui/logo';
import { Money } from '@/shared/presentation/ui/money';
import { ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

/**
 * The agent ledger on a phone, drawn from the real BalanceSlip / AccrualTimeline visuals (copied,
 * not imported: those need data hooks), with the M-Pesa payout SMS sliding in (landing-motion.tsx).
 * Sample figures, labelled as such.
 */
export function PhoneMock() {
  return (
    <div role="group" aria-label="Sample: the agent app as an M-Pesa payout SMS arrives" className="relative mx-auto w-full max-w-[15.5rem]">
      <div className="relative overflow-hidden rounded-[2.4rem] border-[7px] border-receipt-ink bg-canvas shadow-lift">
        <div aria-hidden className="flex items-center justify-between px-5 pt-2.5 pb-1 font-mono text-[11px] font-medium text-ink tabular-nums">
          <span>16:06</span>
          <span className="h-4 w-14 rounded-full bg-receipt-ink" />
          <span>4G</span>
        </div>
        <div className="flex flex-col gap-3 px-3 pt-2 pb-5">
          {/* App header; the SMS banner lands over it, as a real notification would. */}
          <Logo className="origin-left scale-90 self-start" />
          <p className="pb-8 text-[19px] font-semibold tracking-[-0.02em] text-ink">Ledger</p>
          <div className="sm-surface rounded-xl border border-line bg-surface p-3">
            <ReceiptEyebrow className="text-[12px]!">Available to pay out</ReceiptEyebrow>
            <Money cents={0} className="mt-1.5 text-[1.6rem] leading-none" />
            <ReceiptRule className="my-2.5" />
            <dl className="[&_dd]:shrink-0 [&_div]:py-0.5 [&_div]:text-[12px]">
              <ReceiptRow label="In escrow (1)">
                <Money cents={180_000} />
              </ReceiptRow>
            </dl>
          </div>
          <ol className="sm-surface flex flex-col divide-y divide-dashed divide-line-strong rounded-xl border border-line bg-surface px-3 py-1">
            <li className="flex items-center justify-between gap-2 py-2">
              <Money cents={180_000} className="shrink-0 text-[13px]" />
              <StatusPill status="ESCROW_HOLD" className="text-[11px]!" />
            </li>
            <li className="flex items-center justify-between gap-2 py-2">
              <Money cents={452_500} className="shrink-0 text-[13px]" />
              <StatusPill status="RELEASED" className="text-[11px]!" />
            </li>
          </ol>
        </div>

        {/* The payout SMS, as M-Pesa words it. */}
        <div
          data-sms=""
          className="sm-surface absolute inset-x-2 top-9 rounded-2xl border border-line bg-surface/95 p-3 text-left shadow-lift backdrop-blur"
        >
          <p className="flex items-center justify-between text-[12px] font-semibold text-ink">
            M-PESA <span className="font-normal text-ink-muted">now</span>
          </p>
          <p className="mt-1 text-[12px] leading-snug text-ink">
            <span className="font-mono">TJR8MD2K5W</span> Confirmed. You have received Ksh4,525.00 from SALESMESH on 15/10/26 at 4:06 PM.
          </p>
        </div>
      </div>
    </div>
  );
}
