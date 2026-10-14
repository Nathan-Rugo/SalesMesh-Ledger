'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { destinationFor } from '../../domain/entities/session';
import { useSession } from '../state/session-provider';

/** On public pages: a live session goes straight to its destination (honouring a safe `next=`). */
export function SessionRedirect() {
  const { status, session } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status !== 'authenticated' || !session) return;
    const next = new URLSearchParams(window.location.search).get('next');
    router.replace(destinationFor(session, next));
  }, [status, session, router]);
  return null;
}
