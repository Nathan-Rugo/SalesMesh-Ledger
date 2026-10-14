'use client';

import { useEffect } from 'react';
import { Button, buttonClasses } from './button';
import { ReceiptScreen } from './receipt-screen';

/** Crash slip shared by the route error boundaries. Never shows the error text or stack; the digest
 *  (only when Next provides one) lets SalesMesh support find the server log. */
export function CrashReceipt({ error, reset, inline = false }: { error: Error & { digest?: string }; reset: () => void; inline?: boolean }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const ref = error.digest?.slice(0, 10);
  return (
    <ReceiptScreen
      inline={inline}
      eyebrow="Didn’t print"
      code={ref ? `REF ${ref}` : undefined}
      title="Something went wrong on this page"
      actions={
        <>
          <Button block onClick={reset}>
            Try again
          </Button>
          {/* Plain <a> on purpose: a full page load after a crash, and keeps a second next/link copy (~3 KB gz) out of the error chunk every route loads. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className={buttonClasses('secondary', true)}>
            Go to the home page
          </a>
        </>
      }
    >
      <p>
        Nothing was sent or changed. Try again
        {ref ? '; if it keeps happening, give SalesMesh support the reference above.' : '.'}
      </p>
    </ReceiptScreen>
  );
}
