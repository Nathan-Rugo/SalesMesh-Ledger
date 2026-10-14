import Link from 'next/link';
import { cn } from './cn';
import { Logo } from './logo';

const LINKS = [
  { href: '/login', label: 'Sign in' },
  { href: '/register', label: 'Activate your account' },
] as const;

/** Public footer (landing + auth). Links only to pages that exist. */
export function SiteFooter({ className }: { className?: string }) {
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
      <p className="mt-6 text-sm text-ink-muted">
        Payouts are sent over M-Pesa through Safaricom&rsquo;s Daraja API. M-Pesa is a trademark of Safaricom PLC; SalesMesh is not affiliated
        with Safaricom.
      </p>
    </footer>
  );
}
