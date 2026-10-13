import Link from 'next/link';
import { SessionRedirect } from '@/features/auth/presentation/components/session-redirect';
import { buttonClasses } from '@/shared/presentation/ui/button';
import { Card } from '@/shared/presentation/ui/card';
import { InstallPrompt } from '@/shared/presentation/ui/install-prompt';
import { Logo } from '@/shared/presentation/ui/logo';
import { Money } from '@/shared/presentation/ui/money';
import { StatusPill } from '@/shared/presentation/ui/status-pill';

const STATIONS = [
  { label: 'Customer pays', detail: 'M-Pesa' },
  { label: 'Held', detail: 'Escrow' },
  { label: 'You’re paid', detail: 'M-Pesa' },
] as const;

/** The M-Pesa rails motif: one sale travelling from the customer's payment to the agent's phone. */
function SettlementRails() {
  return (
    <Card className="w-full max-w-md p-5 shadow-[0_1px_2px_rgb(15_23_42/0.04),0_12px_32px_-12px_rgb(15_23_42/0.12)] sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          Receipt <span className="font-mono tabular-nums text-ink">TJK4QX7Z1P</span>
        </p>
        <StatusPill status="ESCROW_HOLD" />
      </div>
      <Money cents={4_525_000} roll className="mt-3 text-[2.25rem] leading-none sm:text-[2.75rem]" />
      <p className="mt-2 text-sm text-ink-muted">
        Commission on a sale to <span className="font-mono tabular-nums text-ink">0712 345 678</span>
      </p>

      <div className="mt-6" aria-hidden>
        <div className="relative h-6 overflow-hidden">
          <span className="absolute inset-x-0 top-[7px] h-px bg-line" />
          <span className="absolute inset-x-0 top-[15px] h-px bg-line" />
          <span className="absolute inset-0 animate-rail">
            <span className="absolute top-[3px] right-0 size-4 rounded-full border-2 border-surface bg-mpesa shadow-[0_0_0_4px_rgb(0_168_89/0.18)]" />
          </span>
        </div>
      </div>
      <ol className="mt-2 grid grid-cols-3 text-sm">
        {STATIONS.map((s, i) => (
          <li key={s.label} className={i === 1 ? 'text-center' : i === 2 ? 'text-right' : ''}>
            <span className="block font-semibold text-ink">{s.label}</span>
            <span className="text-ink-muted">{s.detail}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SessionRedirect />
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <Logo />
        <div className="flex items-center gap-1">
          <InstallPrompt className="px-3" />
          <Link href="/login" className={buttonClasses('ghost')}>
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:py-16">
        <div className="flex flex-col items-start gap-6">
          <h1 className="max-w-[16ch] text-[2.5rem] leading-[1.05] font-extrabold tracking-[-0.035em] text-balance text-ink sm:text-6xl">
            Commission you can trace to the shilling.
          </h1>
          <p className="max-w-[46ch] text-lg leading-relaxed text-ink-muted">
            Every sale you close is held in escrow until the customer&rsquo;s M-Pesa payment settles, then paid to your phone. Each step is
            written to a ledger nobody can quietly edit.
          </p>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link href="/login" className={buttonClasses('primary', false, 'w-full sm:w-auto sm:min-w-40')}>
              Sign in
            </Link>
            <Link href="/register" className={buttonClasses('secondary', false, 'w-full sm:w-auto')}>
              Activate your account
            </Link>
          </div>
          <p className="text-sm text-ink-muted">New agents: your merchant gives you a one-time PIN to activate.</p>
        </div>

        <div className="flex justify-center lg:justify-end">
          <SettlementRails />
        </div>
      </main>

      <footer className="mx-auto w-full max-w-6xl border-t border-line px-4 py-6 text-sm text-ink-muted sm:px-6">
        SalesMesh Ledger. Commission payouts over M-Pesa.
      </footer>
    </div>
  );
}
