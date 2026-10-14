import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/shared/presentation/ui/button';
import { ReceiptScreen } from '@/shared/presentation/ui/receipt-screen';
import { ReloadButton } from '@/shared/presentation/ui/reload-button';

export const metadata: Metadata = { title: 'Offline', robots: { index: false } };

/** Served by the service worker for any navigation made without a connection. */
export default function OfflinePage() {
  return (
    <ReceiptScreen
      eyebrow="No signal"
      code="— — —"
      title="You’re offline"
      actions={
        <>
          <ReloadButton />
          <Link href="/" className={buttonClasses('secondary', true)}>
            Go to the home page
          </Link>
        </>
      }
    >
      <p>Balances and payouts are always fetched live, so they aren&rsquo;t stored on this phone. Reconnect, then try again.</p>
    </ReceiptScreen>
  );
}
