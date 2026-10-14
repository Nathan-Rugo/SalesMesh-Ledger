import Link from 'next/link';
import { SessionRedirect } from '@/features/auth/presentation/components/session-redirect';
import { buttonClasses } from '@/shared/presentation/ui/button';
import { cn } from '@/shared/presentation/ui/cn';
import { InstallPrompt } from '@/shared/presentation/ui/install-prompt';
import { Logo } from '@/shared/presentation/ui/logo';
import { SiteFooter } from '@/shared/presentation/ui/site-footer';
import { HeroReceipt } from './_landing/hero-receipt';
import { LandingMotion } from './_landing/landing-motion';
import { LedgerSection } from './_landing/ledger-section';
import { MOTION_BOOT } from './_landing/motion-boot';
import { RailSection } from './_landing/rail-section';

function Ctas({ className }: { className?: string }) {
  return (
    <div className={cn('flex w-full flex-col gap-3 sm:w-auto sm:flex-row', className)}>
      <Link href="/login" className={buttonClasses('primary', false, 'w-full sm:w-auto sm:min-w-40')}>
        Sign in
      </Link>
      <Link href="/register" className={buttonClasses('secondary', false, 'w-full sm:w-auto')}>
        Activate your account
      </Link>
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT }} />
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

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:py-20">
          <div className="flex flex-col items-start gap-6">
            <p className="inline-flex items-center gap-2 rounded-full bg-highlighter px-3 py-1 font-mono text-[12px] font-medium tracking-[0.1em] text-receipt-ink uppercase">
              Commission over M-Pesa
            </p>
            <h1 className="max-w-[15ch] text-[2.6rem] leading-[1.02] font-extrabold tracking-[-0.04em] text-balance text-ink sm:text-[4rem]">
              Commission you can trace to the shilling.
            </h1>
            <p className="max-w-[46ch] text-lg leading-relaxed text-ink-muted">
              Every sale you close is held in escrow until the customer&rsquo;s M-Pesa payment settles, then paid to your phone. Each step is
              written to a ledger nobody can quietly edit.
            </p>
            <Ctas />
            <p className="text-sm text-ink-muted">New agents: your merchant gives you a one-time PIN to activate.</p>
          </div>
          <div className="flex justify-center lg:justify-end">
            <HeroReceipt />
          </div>
        </section>

        <RailSection />
        <LedgerSection />

        <section aria-labelledby="cta-heading" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="sm-surface paper-shadow torn-top torn-bottom relative my-2 flex flex-col items-start gap-6 bg-surface px-6 py-10 sm:px-10 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-2">
              <h2 id="cta-heading" className="max-w-[20ch] text-[1.75rem] leading-[1.1] font-extrabold tracking-[-0.03em] text-ink sm:text-4xl">
                Your next commission, on a receipt you can check.
              </h2>
              <p className="text-ink-muted">Sign in with your phone number and PIN, or activate with the PIN from your merchant.</p>
            </div>
            <Ctas className="lg:shrink-0" />
          </div>
        </section>
      </main>

      <SiteFooter />
      <LandingMotion />
    </div>
  );
}
