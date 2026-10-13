// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeFetch, json, sessionBody } from '@/test/fake-gateway';
import { nav, renderApp } from '@/test/render-app';
import { DashboardShell } from './dashboard-shell';

const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
  nav.pathname = '/agent';
});

async function renderSignedIn(logout: () => Response) {
  const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), [LOGOUT]: logout });
  const other = new BroadcastChannel('salesmesh-auth');
  const received: unknown[] = [];
  other.onmessage = (e) => received.push(e.data);
  const app = renderApp(
    <DashboardShell>
      <p>protected content</p>
    </DashboardShell>,
    gw.fetch
  );
  await screen.findByText('protected content');
  return { ...app, gw, other, received };
}

// The rail and the bottom bar each render a Sign out button; either works.
const signOut = () => fireEvent.click(screen.getAllByRole('button', { name: /sign out/i })[0]!);

describe('Sign out', () => {
  it('success: one POST, session and hint cleared, other tabs told, routed to /login', async () => {
    const { container, gw, other, received } = await renderSignedIn(() => json(204));
    signOut();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login'));
    expect(gw.count(LOGOUT)).toBe(1);
    expect(container.authRepository.current()).toBeNull();
    expect(container.authRepository.hasSessionHint()).toBe(false);
    await waitFor(() => expect(received).toEqual([{ type: 'signed_out' }]));
    other.close();
  });

  it.each([
    ['503', () => json(503, { error: 'temporarily_unavailable' })],
    [
      'network error',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('%s: session kept, toast shown, no broadcast, no navigation', async (_name, reply) => {
    const { container, other, received } = await renderSignedIn(reply);
    signOut();
    expect(await screen.findByText("Couldn't reach SalesMesh to sign you out. Check your connection and try again.")).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container.authRepository.current()).not.toBeNull();
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(received).toEqual([]);
    expect(nav.replace).not.toHaveBeenCalled();
    other.close();
  });
});
