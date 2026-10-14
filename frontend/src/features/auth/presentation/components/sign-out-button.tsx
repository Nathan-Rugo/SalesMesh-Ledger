'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/shared/presentation/ui/cn';
import { Icon } from '@/shared/presentation/ui/icon';
import { useToast } from '@/shared/presentation/ui/toast';
import { useSession } from '../state/session-provider';

/** Signs out everywhere this browser is signed in; on failure keeps the session and says why. */
export function SignOutButton({ className, compact = false }: { className?: string; compact?: boolean }) {
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
      className={cn('press flex min-h-11 cursor-pointer items-center rounded-xl text-ink-muted hover:bg-inset hover:text-ink', !compact && 'gap-3', className)}
    >
      <Icon name="logout" />
      <span className={compact ? 'text-xs font-semibold' : 'text-[15px] font-semibold'}>{busy ? 'Signing out…' : 'Sign out'}</span>
    </button>
  );
}
