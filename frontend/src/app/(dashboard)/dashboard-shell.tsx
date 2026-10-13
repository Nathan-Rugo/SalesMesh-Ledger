'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { adminNav } from '@/features/admin-oversight/presentation/admin-nav';
import { agentNav } from '@/features/agent-ledger/presentation/agent-nav';
import type { Role } from '@/features/auth/domain/entities/session';
import { RoleGuard } from '@/features/auth/presentation/components/role-guard';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import type { NavItem } from '@/shared/presentation/nav';
import { cn } from '@/shared/presentation/ui/cn';
import { Icon } from '@/shared/presentation/ui/icon';
import { Logo } from '@/shared/presentation/ui/logo';
import { useToast } from '@/shared/presentation/ui/toast';

const SHELLS: Record<'agent' | 'admin', { role: Role; nav: readonly NavItem[]; label: string }> = {
  agent: { role: 'SALES_AGENT', nav: agentNav, label: 'Agent' },
  admin: { role: 'MERCHANT_ADMIN', nav: adminNav, label: 'Merchant admin' },
};

/** Neutral placeholder while the session resolves: same frame, no protected content. */
function ShellSkeleton() {
  return (
    // Same offsets as the resolved shell (mobile header ≈ 4.5rem; rail md:pl-60; main md:px-10 md:pt-10).
    <div className="min-h-dvh bg-canvas md:pl-60" role="status" aria-label="Loading your workspace">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 pt-18 md:px-10 md:pt-10">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-inset" />
        <div className="h-40 animate-pulse rounded-2xl bg-inset" />
        <div className="h-24 animate-pulse rounded-2xl bg-inset" />
      </div>
    </div>
  );
}

function SignOutButton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { logout } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await logout();
        if (r.ok) {
          router.replace('/login');
          return;
        }
        setBusy(false);
        toast("Couldn't reach SalesMesh to sign you out. Check your connection and try again.");
      }}
      className={cn('press flex min-h-11 cursor-pointer items-center gap-3 rounded-xl text-ink-muted hover:bg-inset hover:text-ink', className)}
    >
      <Icon name="logout" />
      <span className={compact ? 'text-xs font-semibold' : 'text-[15px] font-semibold'}>{busy ? 'Signing out…' : 'Sign out'}</span>
    </button>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const area = pathname.startsWith('/admin') ? 'admin' : 'agent';
  const shell = SHELLS[area];
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div data-shell={area} className="min-h-dvh bg-canvas text-ink">
      <RoleGuard role={shell.role} fallback={<ShellSkeleton />}>
        <a
          href="#main"
          className="sr-only rounded-xl border border-line bg-surface px-4 py-3 font-semibold text-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to content
        </a>
        {/* Desktop rail */}
        <nav aria-label="Main" className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-canvas px-3 py-5 md:flex">
          <div className="px-3 pb-6">
            <Logo />
            <p className="mt-1 text-sm text-ink-muted">{shell.label}</p>
          </div>
          <ul className="flex flex-1 flex-col gap-1">
            {shell.nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cn(
                    'press flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-semibold',
                    isActive(item.href) ? 'sm-surface border border-line bg-surface text-ink' : 'text-ink-muted hover:bg-inset hover:text-ink'
                  )}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <SignOutButton className="px-3" />
        </nav>

        {/* Mobile header */}
        <header className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 md:hidden">
          <Logo />
          <span className="text-sm text-ink-muted">{shell.label}</span>
        </header>

        <div className="md:pl-60">
          <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] md:px-10 md:pt-10 md:pb-12">{children}</main>
        </div>

        {/* Mobile bottom tab bar */}
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          <ul className="mx-auto flex max-w-md items-stretch justify-around px-2">
            {shell.nav.map((item) => (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cn(
                    'press flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-xs font-semibold',
                    isActive(item.href) ? 'text-link' : 'text-ink-muted'
                  )}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="flex-1">
              <SignOutButton compact className="w-full min-h-14 flex-col justify-center gap-0.5" />
            </li>
          </ul>
        </nav>
      </RoleGuard>
    </div>
  );
}
