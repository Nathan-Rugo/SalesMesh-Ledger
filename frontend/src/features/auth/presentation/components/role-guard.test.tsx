// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, sessionBody } from '@/test/fake-gateway';
import { nav, renderApp } from '@/test/render-app';
import { RoleGuard } from './role-guard';

const REFRESH = '/api/v1/auth/refresh';

const guarded = (role: 'SALES_AGENT' | 'MERCHANT_ADMIN' = 'SALES_AGENT') => (
  <RoleGuard role={role} fallback={<p>skeleton</p>}>
    <p>protected content</p>
  </RoleGuard>
);

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
  nav.pathname = '/agent';
});

describe('RoleGuard (matrix)', () => {
  it('reload with a valid refresh cookie: silent /refresh, lands on the route', async () => {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()) });
    renderApp(guarded(), gw.fetch);
    expect(screen.getByText('skeleton')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(await screen.findByText('protected content')).toBeInTheDocument();
    expect(gw.count(REFRESH)).toBe(1);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('reload with no session: 401 → /login?next=', async () => {
    const gw = fakeFetch({ [REFRESH]: () => json(401, { error: 'invalid_refresh_token' }) });
    renderApp(guarded(), gw.fetch);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?next=%2Fagent'));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('wrong role: SALES_AGENT opening /admin goes to /agent', async () => {
    nav.pathname = '/admin';
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody({ role: 'SALES_AGENT' })) });
    renderApp(guarded('MERCHANT_ADMIN'), gw.fetch);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/agent'));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('forced PIN change session: only /register', async () => {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody({ pinChangeRequired: true })) });
    renderApp(guarded(), gw.fetch);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/register'));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('refresh blocked by origin: config error screen, no refresh loop, logged once', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gw = fakeFetch({ [REFRESH]: () => json(403, { error: 'origin_not_allowed' }) });
    renderApp(guarded(), gw.fetch);
    expect(await screen.findByText("This app isn't connected correctly")).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(gw.count(REFRESH)).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(nav.replace).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('gateway down on reload: retry screen, not a sign-out', async () => {
    let up = false;
    const gw = fakeFetch({
      [REFRESH]: () => {
        if (!up) throw new TypeError('Failed to fetch');
        return json(200, sessionBody());
      },
    });
    renderApp(guarded(), gw.fetch);
    expect(await screen.findByText("Can't reach SalesMesh")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    up = true;
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(await screen.findByText('protected content')).toBeInTheDocument();
  });
});

describe('Session events (matrix)', () => {
  it('403 pin_change_required from any Bearer route sends the user to /register', async () => {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), '/api/v1/payouts': () => json(403, { error: 'pin_change_required' }) });
    const { container } = renderApp(guarded(), gw.fetch);
    await screen.findByText('protected content');
    await act(async () => {
      await container.http.request('/api/v1/payouts');
    });
    expect(nav.replace).toHaveBeenCalledWith('/register');
  });

  it.each([
    [403, 'forbidden', "Your role can't do that."],
    [400, 'invalid_request', 'That request was not accepted. Check the details and try again.'],
  ])('%i %s: toast with a stable message, no sign-out', async (status, code, message) => {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), '/api/v1/x': () => json(status, { error: code }) });
    const { container } = renderApp(guarded(), gw.fetch);
    await screen.findByText('protected content');
    await act(async () => {
      await container.http.request('/api/v1/x');
    });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(container.authRepository.current()).not.toBeNull();
  });

  it('a Bearer route still 401 after refresh + retry signs out', async () => {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), '/api/v1/payouts': () => json(401, { error: 'unauthorized' }) });
    const { container } = renderApp(guarded(), gw.fetch);
    await screen.findByText('protected content');
    await act(async () => {
      await container.http.request('/api/v1/payouts');
    });
    expect(gw.count('/api/v1/payouts')).toBe(2);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?next=%2Fagent'));
    expect(container.authRepository.current()).toBeNull();
  });

  it('logout in another tab signs this tab out', async () => {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()) });
    renderApp(guarded(), gw.fetch);
    await screen.findByText('protected content');
    const other = new BroadcastChannel('salesmesh-auth');
    other.postMessage({ type: 'signed_out' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?next=%2Fagent'));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    other.close();
  });
});
