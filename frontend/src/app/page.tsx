import Link from 'next/link';
import { SessionRedirect } from '@/features/auth/presentation/components/session-redirect';
import { buttonClasses } from '@/shared/presentation/ui/button';
import { cn } from '@/shared/presentation/ui/cn';
import { InstallPrompt } from '@/shared/presentation/ui/install-prompt';
import { Logo } from '@/shared/presentation/ui/logo';
import { SiteFooter } from '@/shared/presentation/ui/site-footer';
import { BeamFlow } from './_landing/beam-flow';
import { Bento } from './_landing/bento';
import { HeroReceipt } from './_landing/hero-receipt';
import { LandingMotion } from './_landing/landing-motion';
import { MOTION_BOOT } from './_landing/motion-boot';

const SECTIONS = [
  { href: '#how', label: 'How it works' },
  { href: '#security', label: 'Security' },
] as const;

// What the system is built on: each one is in this repo, nothing aspirational.
const STACK = [
  { k: 'Payments', v: 'M-Pesa Daraja STK Push' },
  { k: 'Ledger', v: 'Hyperledger Fabric' },
  { k: 'Risk', v: 'Explainable ML scores' },
  { k: 'App', v: 'Installable, works offline' },
] as const;

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
      {/* Frosts once the page scrolls (data-scrolled, set by landing-motion.tsx): the frost layer fades in by opacity only. */}
      <header data-nav="" className="group/nav sticky top-0 z-30 pt-[env(safe-area-inset-top)]">
        <span
          aria-hidden
          className="absolute inset-0 -z-10 border-b border-line bg-canvas/85 opacity-0 backdrop-blur-md transition-opacity duration-300 group-data-scrolled/nav:opacity-100"
        />
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav aria-label="Sections" className="hidden items-center gap-1 sm:flex">
            {SECTIONS.map((l) => (
              <a key={l.href} href={l.href} className="inline-flex min-h-11 items-center rounded-lg px-3 text-[15px] font-medium text-ink-muted transition-colors hover:text-ink">
                {l.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <InstallPrompt className="px-3" />
            <Link href="/login" className={buttonClasses('ghost', false, 'whitespace-nowrap')}>
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto w-full max-w-6xl px-4 pt-10 pb-16 sm:px-6 lg:pt-16 lg:pb-24">
          <div className="flex flex-col items-center gap-6 text-center">
            <h1 className="max-w-[22ch] font-display text-[2.4rem] leading-[1.04] font-normal tracking-[-0.02em] text-balance text-ink sm:text-[3.3rem] lg:text-[4rem]">
              Commission you can trace to the shilling.{' '}
              <span className="text-ink-muted italic">Held until the payment settles, then sent to your M-Pesa.</span>
            </h1>
            <p className="max-w-[48ch] text-lg leading-relaxed text-ink-muted">Every step is written to a ledger nobody can quietly edit.</p>
            <Ctas className="justify-center" />
            <p className="text-sm text-ink-muted">New agents: your merchant gives you a one-time PIN to activate.</p>
          </div>

          {/* Hero stage: the slip prints from the slot on a dot grid, framed by the border beam. */}
          <div data-stage="" className="border-beam mx-auto mt-12 max-w-5xl rounded-[1.75rem] [--beam-fill:var(--sm-inset)] lg:mt-14">
            <div className="dot-grid relative flex justify-center rounded-[1.75rem] px-3 pt-10 pb-12 sm:px-6 sm:pt-14 sm:pb-16">
              <HeroReceipt />
              <dl aria-label="What the slip records" className="pointer-events-none absolute inset-y-0 hidden w-full max-w-5xl items-center justify-between px-8 lg:flex">
                <div data-hero-chip="" className="sm-surface pointer-events-auto flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-soft">
                  <dt className="text-[13px] text-ink-muted">Callback fingerprint</dt>
                  <dd className="font-mono text-[14px] text-ink">9f3a·c1e0</dd>
                </div>
                <div data-hero-chip="" className="sm-surface pointer-events-auto flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-soft">
                  <dt className="text-[13px] text-ink-muted">Held in escrow</dt>
                  <dd className="font-mono text-[14px] text-ink">
                    10:42 <span aria-hidden>→</span>
                    <span className="sr-only">to</span> 16:05
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <dl aria-label="Built on" className="mx-auto mt-10 grid max-w-5xl grid-cols-2 gap-y-5 border-y border-dashed border-line-strong py-5 lg:grid-cols-4">
            {STACK.map((f) => (
              <div key={f.k} className="flex flex-col gap-1 px-4 text-left lg:border-l lg:border-dashed lg:border-line-strong lg:first:border-l-0">
                <dt className="font-mono text-[12px] font-medium tracking-[0.12em] text-ink-muted uppercase">{f.k}</dt>
                <dd className="text-[15px] font-medium text-ink">{f.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <BeamFlow />
        <Bento />

        <section aria-labelledby="cta-heading" className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 px-4 pt-4 pb-20 text-center sm:px-6 lg:pb-28">
          <h2 id="cta-heading" className="max-w-[22ch] font-display text-[2.1rem] leading-[1.08] font-normal tracking-[-0.015em] text-balance text-ink sm:text-[3rem]">
            Your next commission, on a receipt you can check.
          </h2>
          <p className="max-w-[52ch] text-ink-muted">Sign in with your phone number and PIN, or activate with the PIN from your merchant.</p>
          <Ctas className="justify-center" />
        </section>
      </main>

      <SiteFooter full />
      <LandingMotion />
    </div>
  );
}
