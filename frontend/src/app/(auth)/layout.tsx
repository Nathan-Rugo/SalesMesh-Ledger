import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/shared/presentation/ui/logo';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-md items-center px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <Link href="/" className="-ml-1 inline-flex min-h-11 items-center rounded-lg px-1" aria-label="SalesMesh home">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-8 pb-12">{children}</main>
    </div>
  );
}
