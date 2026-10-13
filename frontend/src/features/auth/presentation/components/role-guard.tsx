'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Button } from '@/shared/presentation/ui/button';
import { Icon } from '@/shared/presentation/ui/icon';
import { homePathFor, type Role } from '../../domain/entities/session';
import { useSession } from '../state/session-provider';

/**
 * Client-only route guard (the refresh cookie is scoped to /api/v1/auth, so the server can't see
 * a session). Protected children never render until the session resolves to the right role.
 */
export function RoleGuard({ role, fallback, children }: { role: Role; fallback: ReactNode; children: ReactNode }) {
  const { status, session, probed, resolve } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      // Force one probe even without the local hint: the refresh cookie is the source of truth.
      if (!probed) void resolve();
      else router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    } else if (status === 'authenticated' && session) {
      if (session.pinChangeRequired) router.replace('/register');
      else if (session.user.role !== role) router.replace(homePathFor(session.user.role));
    }
  }, [status, session, probed, resolve, router, pathname, role]);

  if (status === 'misconfigured') return <ConfigErrorScreen />;
  if (status === 'unreachable') return <UnreachableScreen onRetry={() => void resolve()} />;
  if (status === 'authenticated' && session && !session.pinChangeRequired && session.user.role === role) return <>{children}</>;
  return <>{fallback}</>;
}

function ScreenMessage({ icon, title, children }: { icon: 'alert' | 'offline'; title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-6">
      <div className="flex max-w-md flex-col items-start gap-4">
        <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-ink">
          <Icon name={icon} />
        </span>
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-ink">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function ConfigErrorScreen() {
  return (
    <ScreenMessage icon="alert" title="This app isn't connected correctly">
      <p className="text-ink-muted">
        The SalesMesh gateway refused requests from this address. Ask your administrator to add it to the gateway&rsquo;s{' '}
        <code className="font-mono text-ink">CORS_ORIGINS</code> setting.
      </p>
    </ScreenMessage>
  );
}

export function UnreachableScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <ScreenMessage icon="offline" title="Can't reach SalesMesh">
      <p className="text-ink-muted">Check your connection, then try again. You&rsquo;re still signed in.</p>
      <Button onClick={onRetry}>Try again</Button>
    </ScreenMessage>
  );
}
