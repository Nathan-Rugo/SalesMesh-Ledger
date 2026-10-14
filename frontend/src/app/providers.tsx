'use client';

import { useEffect, type ReactNode } from 'react';
import { SessionProvider } from '@/features/auth/presentation/state/session-provider';
import { OfflineBanner } from '@/shared/presentation/ui/offline-banner';
import { ToastProvider } from '@/shared/presentation/ui/toast';

function useServiceWorker() {
  useEffect(() => {
    // Dev builds change every save; the SW only runs against production builds.
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* installability degrades gracefully; nothing to show the user */
    });
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  useServiceWorker();
  return (
    <ToastProvider>
      <SessionProvider>
        <OfflineBanner />
        {children}
      </SessionProvider>
    </ToastProvider>
  );
}
