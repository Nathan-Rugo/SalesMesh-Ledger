'use client';

import { useEffect, useState } from 'react';
import { Button } from './button';
import { Icon } from './icon';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** "Install" button, shown only when the browser offers installation. Place it where its arrival shifts nothing (CLS). */
export function InstallPrompt({ className }: { className?: string }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred) return null;
  return (
    <Button
      variant="ghost"
      className={className}
      onClick={async () => {
        await deferred.prompt();
        await deferred.userChoice;
        setDeferred(null);
      }}
    >
      <Icon name="download" />
      Install
    </Button>
  );
}
