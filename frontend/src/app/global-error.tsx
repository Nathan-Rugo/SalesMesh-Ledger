'use client';

import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { buttonClasses } from '@/shared/presentation/ui/button';
import './globals.css';

/** Last-resort screen when the root layout itself fails: own <html>, no providers, no stack. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    // No root layout here, so no next/font variables: point the font tokens at system fonts.
    <html lang="en-KE" style={{ '--font-bricolage': 'system-ui', '--font-jetbrains': 'ui-monospace' } as CSSProperties}>
      <body className="min-h-dvh bg-canvas text-ink">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
          <div className="sm-surface paper-shadow torn-top torn-bottom relative flex flex-col gap-4 bg-surface px-5 py-7">
            <p className="font-mono text-[12px] font-medium tracking-[0.12em] text-ink-muted uppercase">SalesMesh · Didn&rsquo;t print</p>
            <hr className="rule-dashed" />
            <h1 className="text-3xl font-extrabold tracking-[-0.03em]">SalesMesh couldn&rsquo;t load</h1>
            <p className="text-ink-muted">
              Nothing was sent or changed. Try again{error.digest ? `; reference ${error.digest.slice(0, 10)}` : ''}.
            </p>
            <button
              type="button"
              onClick={reset}
              className={buttonClasses('primary', true)}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
