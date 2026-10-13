import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { createContainer } from '@/core/di/container';
import { SessionProvider } from '@/features/auth/presentation/state/session-provider';
import { ToastProvider } from '@/shared/presentation/ui/toast';

/** Shared next/navigation double; tests set `nav.pathname` and assert on `nav.replace`. */
export const nav = { pathname: '/', replace: vi.fn(), push: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push, prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => nav.pathname,
}));

/** Renders `ui` inside the real providers wired to a fake gateway fetch. */
export function renderApp(ui: ReactNode, fetchImpl: typeof fetch) {
  const container = createContainer(fetchImpl);
  const utils = render(
    <ToastProvider>
      <SessionProvider container={container}>{ui}</SessionProvider>
    </ToastProvider>
  );
  return { ...utils, container };
}
