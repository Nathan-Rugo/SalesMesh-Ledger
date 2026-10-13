import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/shared/presentation/ui/button';
import { Icon } from '@/shared/presentation/ui/icon';
import { Logo } from '@/shared/presentation/ui/logo';

export const metadata: Metadata = { title: 'Offline', robots: { index: false } };

/** Served by the service worker for any navigation made without a connection. */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6">
      <Logo />
      <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-ink">
        <Icon name="offline" />
      </span>
      <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-ink">You&rsquo;re offline</h1>
      <p className="text-ink-muted">
        Balances and payouts are always fetched live, so they aren&rsquo;t stored on this phone. Reconnect, then try again.
      </p>
      <Link href="/" className={buttonClasses('primary', true)}>
        Try again
      </Link>
    </main>
  );
}
