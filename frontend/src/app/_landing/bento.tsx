import type { ReactNode } from 'react';
import { Icon } from '@/shared/presentation/ui/icon';
import { StatusPill } from '@/shared/presentation/ui/status-pill';
import { cn } from '@/shared/presentation/ui/cn';
import { PhoneMock } from './phone-mock';
import { clock, HOLD_LEFT_S, HOLD_TOTAL_S, isoDuration } from './sample-hold';

// Illustrative entries for one sale. The fingerprints are made-up hex, not real data.
const LEDGER = [
  { time: '10:42', event: 'Customer payment confirmed', print: '9f3a·c1e0' },
  { time: '10:42', event: 'Commission held in escrow', print: '41d7·08b2' },
  { time: '16:05', event: 'Payment settled, cleared', print: 'e6b0·5a9c' },
  { time: '16:06', event: 'Sent to agent’s M-Pesa', print: '2c58·f71d' },
] as const;

// Signals the risk model actually scores (ml-engine/engine/features.py), in plain words. Sample weights.
const REASONS = [
  { label: 'Amount vs this agent’s usual', value: 0.46 },
  { label: 'How fast sales are coming in', value: 0.27 },
  { label: 'Payout number reused', value: 0.15 },
  { label: 'Payment split into parts', value: 0.08 },
] as const;
const MAX_REASON = Math.max(...REASONS.map((r) => r.value));

function Tile({ title, text, className, children }: { title: string; text: ReactNode; className?: string; children: ReactNode }) {
  return (
    <article data-tile="" className={cn('sm-surface flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 shadow-soft sm:p-6', className)}>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[17px] font-medium text-ink">{title}</h3>
        <p className="max-w-[52ch] text-[15px] leading-relaxed text-ink-muted">{text}</p>
      </div>
      {children}
    </article>
  );
}

/**
 * Bento grid (Aceternity layout, rebuilt): each tile is a small working piece of the product, in its
 * final state on the server. landing-motion.tsx reveals the tiles and plays each mini-UI once in view.
 */
export function Bento() {
  return (
    <section id="security" aria-labelledby="bento-heading" className="scroll-mt-16 mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
      <h2 id="bento-heading" className="max-w-[28ch] font-display text-[2.1rem] leading-[1.08] font-normal tracking-[-0.015em] text-balance text-ink sm:text-[3rem]">
        A record nobody can quietly edit.{' '}
        <span className="text-ink-muted">Every callback fingerprinted, every retry caught, every risky payout held for a person.</span>
      </h2>

      <div className="mt-12 grid grid-flow-dense gap-4 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3">
        <Tile
          title="The fingerprint ledger"
          text="Each M-Pesa callback is stored with a keyed hash of exactly what Safaricom sent. Change a stored record and it stops matching."
          className="sm:col-span-2"
        >
          <table className="w-full text-left text-[14px]">
            <caption className="pb-2 text-left text-[13px] text-ink-muted">Sample entries for one sale</caption>
            <thead>
              <tr className="text-[13px] text-ink-muted">
                <th scope="col" className="pb-2 font-medium">
                  Time
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Entry
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  Fingerprint
                </th>
              </tr>
            </thead>
            <tbody>
              {LEDGER.map((e) => (
                <tr key={e.print} data-ledger-row="" className="border-t border-line align-top">
                  <td className="py-2.5 pr-3 font-mono text-ink tabular-nums">{e.time}</td>
                  <td className="py-2.5 pr-3 text-ink">{e.event}</td>
                  <td className="py-2.5 text-right font-mono whitespace-nowrap text-ink-muted">{e.print}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tile>

        <Tile title="Your agent app" text="Balance, escrow and payouts on your phone. The M-Pesa SMS lands as the money does." className="sm:row-span-2 lg:row-span-3">
          <div className="dot-grid -mx-2 mt-auto flex flex-1 items-center rounded-xl px-2 py-6">
            <PhoneMock />
          </div>
        </Tile>

        <Tile title="A retry can’t pay twice" text="The same M-Pesa receipt arriving again is recognised and recorded once.">
          <ul className="flex flex-col gap-2 text-[14px]">
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
              <span className="flex flex-col">
                <span className="font-mono text-ink">TJK4QX7Z1P</span>
                <span className="text-ink-muted">Callback received</span>
              </span>
              <StatusPill status="CLEAR" />
            </li>
            <li
              data-dup=""
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-escrow-quarantined-border bg-escrow-quarantined-bg px-3 py-2.5"
            >
              <span className="flex flex-col">
                <span className="font-mono text-escrow-quarantined-ink">TJK4QX7Z1P</span>
                <span className="text-escrow-quarantined-ink">Same receipt again</span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-escrow-quarantined-border bg-surface px-2.5 py-0.5 text-[13px] font-semibold text-escrow-quarantined-ink">
                <Icon name="close" className="size-3.5" />
                Refused
              </span>
            </li>
          </ul>
        </Tile>

        <Tile title="Held until it settles" text="Commission waits in escrow until the payment settles, so a reversal can’t claw it back later.">
          <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
            <div className="flex items-center justify-between gap-3">
              <StatusPill status="ESCROW_HOLD" />
              <span className="text-[13px] text-ink-muted">Sample</span>
            </div>
            <p className="text-[14px] text-ink-muted">
              Clears in{' '}
              <time data-countdown="" dateTime={isoDuration(HOLD_LEFT_S)} className="block font-mono text-[2rem] leading-tight font-medium text-ink tabular-nums">
                {clock(HOLD_LEFT_S)}
              </time>
            </p>
            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-inset">
              <div
                data-countdown-bar=""
                className="h-full origin-left rounded-full bg-escrow-hold"
                style={{ transform: `scaleX(${1 - HOLD_LEFT_S / HOLD_TOTAL_S})` }}
              />
            </div>
          </div>
        </Tile>

        <Tile
          title="Risky payouts wait for a person"
          text="When the risk model is unsure, the payout is held for your merchant with the reasons behind the score."
          className="sm:col-span-2"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusPill status="QUARANTINED" />
              <span className="text-[13px] text-ink-muted">Sample reasons, by weight</span>
            </div>
            <ul className="flex flex-col gap-2">
              {REASONS.map((r) => (
                <li key={r.label} className="flex items-center gap-3 text-[14px]">
                  <span className="relative flex h-9 flex-1 items-center overflow-hidden rounded-lg">
                    <span
                      aria-hidden
                      data-bar=""
                      className="absolute inset-y-0 left-0 origin-left rounded-lg bg-escrow-quarantined-border"
                      style={{ width: `${Math.round((r.value / MAX_REASON) * 100)}%` }}
                    />
                    <span className="relative px-3 text-ink">{r.label}</span>
                  </span>
                  <span className="w-10 text-right font-mono text-ink tabular-nums">{r.value.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Tile>
      </div>
    </section>
  );
}
