import { Receipt, ReceiptEyebrow, ReceiptRule } from '@/shared/presentation/ui/receipt';

// Illustrative entries (labelled "Sample" on the slip). The fingerprints are made-up hex, not real data.
const SAMPLE_ENTRIES = [
  { time: '10:42', event: 'Customer payment confirmed', print: '9f3a·c1e0' },
  { time: '10:42', event: 'Commission held in escrow', print: '41d7·08b2' },
  { time: '16:05', event: 'Payment settled, cleared', print: 'e6b0·5a9c' },
  { time: '16:06', event: 'Sent to agent’s M-Pesa', print: '2c58·f71d' },
] as const;

const POINTS = [
  {
    title: 'Written as it happens',
    text: 'Every M-Pesa callback is stored with a keyed hash of exactly what Safaricom sent. A stored record that is later changed no longer matches its fingerprint.',
  },
  {
    title: 'Retries can’t pay twice',
    text: 'The same M-Pesa receipt arriving again is recognised and recorded once, so a network retry never doubles a payment.',
  },
  {
    title: 'Risky payouts wait for a person',
    text: 'Payouts the risk model is unsure about are held for your merchant to review, with the reasons shown, instead of going out blind.',
  },
] as const;

/** Why the record can be trusted: the tamper-evident ledger, in plain words. No stats, no claims beyond the system. */
export function LedgerSection() {
  return (
    <section aria-labelledby="ledger-heading" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
        <div className="flex flex-col gap-6">
          <p className="font-mono text-[12px] font-medium tracking-[0.12em] text-ink-muted uppercase">On the ledger</p>
          <h2 id="ledger-heading" className="max-w-[18ch] text-[2rem] leading-[1.1] font-extrabold tracking-[-0.03em] text-balance text-ink sm:text-5xl">
            A record nobody can quietly edit.
          </h2>
          <ul className="flex flex-col gap-5">
            {POINTS.map((p) => (
              <li key={p.title} className="border-l-2 border-accent pl-4">
                <h3 className="text-lg font-bold text-ink">{p.title}</h3>
                <p className="mt-1 text-[15px] text-ink-muted">{p.text}</p>
              </li>
            ))}
          </ul>
        </div>

        <Receipt torn="both" className="mx-auto w-full max-w-[28rem] lg:mt-14">
          <div className="flex items-center justify-between gap-3">
            <ReceiptEyebrow>Ledger · sample</ReceiptEyebrow>
            <span className="font-mono text-[12px] text-ink-muted">TJK4QX7Z1P</span>
          </div>
          <ReceiptRule />
          <table className="w-full text-left text-[14px]">
            <caption className="sr-only">Sample ledger entries for one sale</caption>
            <thead>
              <tr className="font-mono text-[11px] tracking-[0.1em] text-ink-muted uppercase">
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
              {SAMPLE_ENTRIES.map((e) => (
                <tr key={e.print} className="border-t border-dashed border-line align-top">
                  <td className="py-2.5 pr-3 font-mono text-ink tabular-nums">{e.time}</td>
                  <td className="py-2.5 pr-3 text-ink">{e.event}</td>
                  <td className="py-2.5 text-right font-mono whitespace-nowrap text-ink-muted">{e.print}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Receipt>
      </div>
    </section>
  );
}
