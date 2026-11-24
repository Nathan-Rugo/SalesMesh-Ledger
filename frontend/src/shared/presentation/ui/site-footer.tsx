import Link from 'next/link';
import { cn } from './cn';
import { Logo } from './logo';

const LINKS = [
  { href: '/login', label: 'Sign in' },
  { href: '/register', label: 'Activate your account' },
] as const;

const REPO = 'https://github.com/Nathan-Rugo/SalesMesh-Ledger';

// Landing footer columns. Every link goes to a page or section that exists.
const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/#how', label: 'How it works' },
      { href: '/#security', label: 'Security' },
      { href: '/login', label: 'Sign in' },
      { href: '/register', label: 'Activate your account' },
    ],
  },
  {
    title: 'Project',
    links: [
      { href: REPO, label: 'Source code' },
      { href: `${REPO}#readme`, label: 'Setup guide' },
    ],
  },
] as const;

const DISCLAIMER =
  'Payouts are sent over M-Pesa through Safaricom’s Daraja API. M-Pesa is a trademark of Safaricom PLC; SalesMesh is not affiliated with Safaricom.';

/** Public footer. `full` (landing): a dark band with link columns and a legal bar. Default (auth pages): one compact block. */
export function SiteFooter({ className, full = false }: { className?: string; full?: boolean }) {
  if (full) {
    return (
      <footer data-band="night" className={cn('bg-canvas text-ink', className)}>
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-16 pb-10 sm:px-6 md:grid-cols-[1.6fr_1fr_1fr]">
          <div className="flex flex-col gap-3">
            <Logo />
            <p className="max-w-[36ch] text-[15px] leading-relaxed text-ink-muted">
              Commission held until the customer&rsquo;s payment settles, then paid to your phone. Every step on a ledger nobody can quietly edit.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2 className="font-mono text-[12px] font-medium tracking-[0.12em] text-ink-muted uppercase">{col.title}</h2>
              <ul className="mt-3 flex flex-col">
                {col.links.map((l) => (
                  <li key={l.href}>
                    {l.href.startsWith('http') ? (
                      <a href={l.href} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[15px] text-ink underline-offset-4 hover:underline">
                        {l.label}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link href={l.href} className="inline-flex min-h-11 items-center text-[15px] text-ink underline-offset-4 hover:underline">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="border-t border-line">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-[13px] text-ink-muted sm:px-6 md:flex-row md:items-start md:justify-between md:gap-10">
            <p className="shrink-0">&copy; {new Date().getFullYear()} SalesMesh. All rights reserved.</p>
            <p className="max-w-[70ch] md:text-right">{DISCLAIMER}</p>
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className={cn('mx-auto w-full max-w-6xl px-4 pt-10 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6', className)}>
      <hr className="rule-dashed mb-8" />
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Logo />
          <p className="max-w-[40ch] text-[15px] text-ink-muted">Commission held until the customer&rsquo;s payment settles, then paid to your phone.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-col gap-1 sm:items-end">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="inline-flex min-h-11 items-center font-semibold text-link underline-offset-4 hover:underline">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <p className="mt-6 text-sm text-ink-muted">{DISCLAIMER}</p>
    </footer>
  );
}
