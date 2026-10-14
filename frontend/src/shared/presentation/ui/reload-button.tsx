'use client';

import { Button } from './button';
import { Icon } from './icon';

/** Reloads the address the user was trying to reach (the SW serves /offline under that URL). */
export function ReloadButton({ label = 'Try again' }: { label?: string }) {
  return (
    <Button block onClick={() => window.location.reload()}>
      <Icon name="refresh" />
      {label}
    </Button>
  );
}
