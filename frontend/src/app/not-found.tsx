import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/shared/presentation/ui/button';
import { ReceiptScreen } from '@/shared/presentation/ui/receipt-screen';

export const metadata: Metadata = { title: 'Receipt not found', robots: { index: false } };

export default function NotFound() {
  return (
    <ReceiptScreen
      eyebrow="Receipt not found"
      code="404"
      title="Nothing printed at this address"
      actions={
        <>
          <Link href="/" className={buttonClasses('primary', true)}>
            Go to the home page
          </Link>
          <Link href="/login" className={buttonClasses('secondary', true)}>
            Sign in
          </Link>
        </>
      }
    >
      <p>The link may be old or mistyped. Your money isn&rsquo;t affected; everything on your ledger is where you left it.</p>
    </ReceiptScreen>
  );
}
