import { Logo } from '@/shared/presentation/ui/logo';
import { Money } from '@/shared/presentation/ui/money';
import { ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

/**
 * The agent ledger on a phone, drawn from the real BalanceSlip / AccrualTimeline visuals (copied,
 * not imported: those need data hooks), with the M-Pesa payout SMS sliding in (landing-motion.tsx).
 * Sample figures, labelled as such.
 */
function StatusIcons() {
  return (
    <span className="flex items-center gap-1 text-ink">
      {/* Signal */}
      <svg viewBox="0 0 17 11" className="h-[9px] w-auto" fill="currentColor">
        <rect x="0" y="7" width="3" height="4" rx="0.7" />
        <rect x="4.5" y="5" width="3" height="6" rx="0.7" />
        <rect x="9" y="2.5" width="3" height="8.5" rx="0.7" />
        <rect x="13.5" y="0" width="3" height="11" rx="0.7" />
      </svg>
      <span className="font-sans text-[10px] font-semibold">4G</span>
      {/* Battery */}
      <svg viewBox="0 0 25 12" className="h-[10px] w-auto">
        <rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.4" />
        <rect x="2" y="2" width="15" height="8" rx="1.6" fill="currentColor" />
        <path d="M23 4v4c.8-.3 1.3-1.1 1.3-2S23.8 4.3 23 4Z" fill="currentColor" fillOpacity="0.45" />
      </svg>
    </span>
  );
}

export function PhoneMock() {
  return (
    <div role="group" aria-label="Sample: the agent app as an M-Pesa payout SMS arrives" data-tilt="phone" className="relative mx-auto w-full max-w-[16rem]">
      {/* Side buttons: action + volume on the left, power on the right. */}
      <span aria-hidden className="absolute top-20 -left-[3px] h-6 w-[3px] rounded-l-sm bg-[#3a403d]" />
      <span aria-hidden className="absolute top-30 -left-[3px] h-10 w-[3px] rounded-l-sm bg-[#3a403d]" />
      <span aria-hidden className="absolute top-42 -left-[3px] h-10 w-[3px] rounded-l-sm bg-[#3a403d]" />
      <span aria-hidden className="absolute top-32 -right-[3px] h-14 w-[3px] rounded-r-sm bg-[#3a403d]" />
      {/* Titanium frame around a black bezel. */}
      <div
        data-phone=""
        className="relative rounded-[2.75rem] bg-linear-to-br from-[#5b625f] via-[#2c312f] to-[#4a514e] p-[3px] shadow-lift"
      >
        <div className="rounded-[2.6rem] bg-black p-[7px]">
          <div className="relative aspect-[9/19.2] overflow-hidden rounded-[2.1rem] bg-canvas">
            {/* Status bar around the camera island. */}
            <div aria-hidden className="flex h-9 items-center justify-between px-6 pt-1 text-[11px] font-semibold text-ink tabular-nums">
              <span className="font-sans">16:06</span>
              <StatusIcons />
            </div>
            <span aria-hidden className="absolute top-2 left-1/2 h-[22px] w-[74px] -translate-x-1/2 rounded-full bg-black" />

            <div className="flex flex-col gap-3 px-3 pt-1 pb-5">
              <Logo className="origin-left scale-90 self-start" />
              <p className="pb-6 text-[19px] font-semibold tracking-[-0.02em] text-ink">Ledger</p>
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

            {/* The payout SMS as a lock-screen style banner, worded the way M-Pesa words it. */}
            <div
              data-sms=""
              className="absolute inset-x-2 top-10 flex gap-2.5 rounded-[1.15rem] bg-white/80 p-2.5 text-left shadow-[0_10px_30px_-8px_rgb(10_31_22/0.45),0_0_0_0.5px_rgb(10_31_22/0.08)] backdrop-blur-xl"
            >
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[0.55rem] bg-linear-to-b from-[#34c759] to-[#1f9e44]">
                <svg viewBox="0 0 24 24" className="size-[18px]" fill="#fff">
                  <path d="M12 3.5c-5 0-9 3.3-9 7.4 0 2.3 1.3 4.4 3.3 5.8l-.7 3.3 3.6-2c.9.2 1.8.3 2.8.3 5 0 9-3.3 9-7.4s-4-7.4-9-7.4Z" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline justify-between gap-2 text-[12px] leading-tight font-semibold text-[#0a1f16]">
                  M-PESA <span className="text-[11px] font-normal text-[#3d5248]">now</span>
                </p>
                <p className="mt-0.5 line-clamp-3 text-[11.5px] leading-snug text-[#0a1f16]">
                  <span className="font-mono">TJR8MD2K5W</span> Confirmed. You have received Ksh4,525.00 from SALESMESH on 15/10/26 at 4:06 PM.
                </p>
              </div>
            </div>

            <span aria-hidden className="absolute bottom-1.5 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-ink/70" />
            {/* Glass glare. */}
            <span aria-hidden className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/15 via-transparent to-transparent" />
          </div>
        </div>
      </div>
    </div>
  );
}
