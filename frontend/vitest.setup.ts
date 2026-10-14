import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The 1 s default makes findBy/waitFor flaky on loaded or low-RAM machines (and slow CI runners).
configure({ asyncUtilTimeout: 5000 });

/**
 * Node's BroadcastChannel crosses worker_threads, so with `--pool=threads` one test file's
 * `signed_out` would sign out a session in another file running in parallel. This in-memory
 * stand-in keeps "other tabs" inside the current test file while preserving browser semantics
 * (async delivery, never to the sender, only to open channels with the same name).
 */
class LocalBroadcastChannel {
  private static readonly open = new Set<LocalBroadcastChannel>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  private closed = false;

  constructor(readonly name: string) {
    LocalBroadcastChannel.open.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
    for (const peer of LocalBroadcastChannel.open) {
      if (peer === this || peer.name !== this.name) continue;
      const copy = structuredClone(data);
      setTimeout(() => {
        if (!peer.closed) peer.onmessage?.(new MessageEvent('message', { data: copy }));
      }, 0);
    }
  }

  close(): void {
    this.closed = true;
    LocalBroadcastChannel.open.delete(this);
  }
}

vi.stubGlobal('BroadcastChannel', LocalBroadcastChannel);

afterEach(() => cleanup());
