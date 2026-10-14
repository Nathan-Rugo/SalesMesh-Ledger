import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/shared/presentation/ui/logo';
import { Receipt } from '@/shared/presentation/ui/receipt';
import { SiteFooter } from '@/shared/presentation/ui/site-footer';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-md items-center px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <Link href="/" className="-ml-1 inline-flex min-h-11 items-center rounded-lg px-1" aria-label="SalesMesh home">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-8 pb-12">
        {/* The form is the slip: printed from the top edge of the counter. */}
        <Receipt torn="bottom" className="flex flex-col px-5 pt-7 pb-8 sm:px-7">
          {children}
        </Receipt>
      </main>
      <SiteFooter className="max-w-md" />
    </div>
  );
}
