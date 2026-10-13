'use client';

import { useSyncExternalStore } from 'react';
import { Icon } from './icon';

const subscribe = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};

/** Appears only while the browser reports no connection. */
export function OfflineBanner() {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  if (online) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-[#78350f] px-4 py-2 text-sm font-semibold text-white">
      <Icon name="offline" width={16} height={16} />
      You&rsquo;re offline. Signing in and payouts need a connection.
    </div>
  );
}
