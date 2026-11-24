import { Icon, type IconName } from '@/shared/presentation/ui/icon';

// One sample sale (KES 90,500 at 5 % = the hero slip's KES 4,525 commission).
const HOPS: readonly { title: string; text: string; icon: IconName; chip: string }[] = [
  { title: 'Customer’s M-Pesa', text: 'Pays KES 90,500 for the sale. SalesMesh records it when Safaricom confirms.', icon: 'check', chip: 'Confirmed' },
  { title: 'Escrow', text: 'Your KES 4,525 commission waits here until the payment settles.', icon: 'wallet', chip: 'Held' },
  { title: 'Risk check', text: 'Scored before release. A payout the model is unsure of waits for your merchant.', icon: 'shield', chip: 'Passed' },
  { title: 'Your M-Pesa', text: 'Sent to your number. The M-Pesa SMS confirms it on your phone.', icon: 'download', chip: 'Sent' },
];

/**
 * Dark band "How a shilling travels": four hops joined by beams (Magic UI animated-beam, rebuilt).
 * Server-rendered in its final state (every chip lit); landing-motion.tsx plays one pass of a pulse
 * along each beam, lighting the chips in turn, the first time the band enters view.
 */
export function BeamFlow() {
  return (
    <section id="how" data-band="night" aria-labelledby="flow-heading" className="relative scroll-mt-16 overflow-hidden bg-canvas text-ink">
      <div aria-hidden className="grid-lines absolute inset-0" />
      <div className="relative mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
        <h2 id="flow-heading" className="max-w-[26ch] text-[1.9rem] leading-[1.12] font-medium tracking-[-0.03em] text-balance sm:text-[2.75rem]">
          How a shilling travels. <span className="text-ink-muted">From the customer&rsquo;s M-Pesa to yours, checked at every hop.</span>
        </h2>

        <ol data-flow="" className="mt-12 grid gap-8 lg:mt-16 lg:grid-cols-4 lg:gap-10">
          {HOPS.map((h, i) => (
            <li key={h.title} className="relative">
              <div className="sm-surface flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-soft">
                <div className="flex items-center justify-between gap-3">
                  <span aria-hidden data-hop-icon="" className="flex size-10 items-center justify-center rounded-xl border border-line text-accent">
                    <Icon name={h.icon} />
                  </span>
                  <span
                    data-chip={h.chip}
                    data-on=""
                    className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[13px] font-medium whitespace-nowrap text-ink-muted data-on:border-accent data-on:text-ink"
                  >
                    <span aria-hidden className="size-1.5 rounded-full bg-line-strong in-data-on:bg-beam" />
                    {/* The visible label reads "Waiting" mid-animation; AT always gets the real state. */}
                    <span aria-hidden data-chip-label="">
                      {h.chip}
                    </span>
                    <span className="sr-only">{h.chip}</span>
                  </span>
                </div>
                <h3 className="text-[17px] font-medium text-ink">{h.title}</h3>
                <p className="text-[15px] leading-relaxed text-ink-muted">{h.text}</p>
              </div>
              {i < HOPS.length - 1 ? (
                // The beam to the next hop: down on phones, across on desktop. The pulse rides it by transform only.
                <span
                  aria-hidden
                  data-beam=""
                  className="absolute top-full left-10 h-8 w-px overflow-hidden bg-line-strong lg:top-1/2 lg:left-full lg:h-px lg:w-10"
                >
                  <span data-pulse="" className="absolute inset-0 bg-linear-to-b from-transparent via-beam to-transparent opacity-0 lg:bg-linear-to-r" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
