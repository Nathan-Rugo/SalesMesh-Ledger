import { ClearedSeal } from '@/shared/presentation/ui/cleared-seal';
import { Icon } from '@/shared/presentation/ui/icon';

const STEPS = [
  { key: 'Paid', title: 'The customer pays', text: 'Your customer pays by M-Pesa. SalesMesh records the payment as soon as Safaricom confirms it.' },
  {
    key: 'Held',
    title: 'Your commission is held',
    text: 'It waits in escrow until the payment settles and the checks pass, so a reversed payment can’t claw money back from you later.',
  },
  { key: 'Yours', title: 'It’s yours', text: 'Cleared commission is sent to your M-Pesa number, and the SMS lands on your phone.' },
] as const;

/**
 * "How a shilling travels": a payment rail with three stations, ending on the Cleared stamp.
 * Server-rendered complete (every station reached, seal stamped); landing-motion.tsx rides a coin
 * down the rail as the reader scrolls and stamps the seal when it arrives.
 */
export function RailSection() {
  return (
    <section aria-labelledby="rail-heading" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div className="flex flex-col gap-3 lg:sticky lg:top-24">
          <p className="font-mono text-[12px] font-medium tracking-[0.12em] text-ink-muted uppercase">How a shilling travels</p>
          <h2 id="rail-heading" className="max-w-[16ch] text-[2rem] leading-[1.1] font-extrabold tracking-[-0.03em] text-balance text-ink sm:text-5xl">
            Paid, held, then yours. No guesswork in between.
          </h2>
        </div>

        <div data-rail="" className="relative">
          {/* The coin that rides the rail; only shown while motion runs. */}
          <span
            data-coin=""
            aria-hidden
            className="invisible absolute top-0 left-0 z-10 flex size-10 items-center justify-center rounded-full border-4 border-surface bg-mpesa shadow-[0_6px_14px_-4px_rgb(10_31_22/0.45)]"
          >
            <span className="size-3 rounded-full bg-receipt-ink" />
          </span>
          <ol className="flex flex-col">
            {STEPS.map((s, i) => (
              <li key={s.key} data-step="" data-reached="" className="group relative flex gap-4 pb-6 last:pb-0 sm:gap-6">
                {i < STEPS.length - 1 ? (
                  <span aria-hidden className="absolute top-10 bottom-0 left-[19px] border-l-2 border-dashed border-line-strong" />
                ) : null}
                <span
                  data-marker=""
                  aria-hidden
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-surface font-mono text-sm font-bold text-ink transition-colors duration-300 group-data-reached:border-accent group-data-reached:bg-accent group-data-reached:text-on-accent"
                >
                  <span className="group-data-reached:hidden">{i + 1}</span>
                  <Icon name="check" className="hidden size-5 group-data-reached:block" />
                </span>
                <div className="sm-surface paper-shadow flex flex-1 flex-col gap-1.5 bg-surface p-5 sm:p-6">
                  <p className="font-mono text-[12px] font-medium tracking-[0.12em] text-ink-muted uppercase">
                    Step {i + 1} · {s.key}
                  </p>
                  <h3 className="text-xl font-bold tracking-[-0.01em] text-ink">{s.title}</h3>
                  <p className="text-[15px] text-ink-muted">{s.text}</p>
                  {i === STEPS.length - 1 ? (
                    <span data-rail-seal="" className="mt-3 inline-block self-start">
                      <ClearedSeal tilt="-5deg" />
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
