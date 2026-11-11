// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '@/core/di/container';
import { HttpClient } from '@/core/data/http-client';
import { GatewayAuthDataSource } from '../datasources/gateway-auth-datasource';
import { GatewayAuthRepository, localStorageHint } from './gateway-auth-repository';
import { fakeFetch, json, sessionBody, token } from '@/test/fake-gateway';

const LOGIN = '/api/v1/auth/login';
const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';

beforeEach(() => window.localStorage.clear());

async function signedIn(routes: Parameters<typeof fakeFetch>[0]) {
  const gw = fakeFetch({ [LOGIN]: () => json(200, sessionBody()), ...routes });
  const c = createContainer(gw.fetch);
  expect((await c.login.execute({ phone: '0712345678', pin: '4829' })).ok).toBe(true);
  return { c, gw };
}

describe('GatewayAuthRepository', () => {
  it('logout ok: one POST, session and hint cleared', async () => {
    const { c, gw } = await signedIn({ [LOGOUT]: () => json(204) });
    const r = await c.logout.execute();
    expect(r.ok).toBe(true);
    expect(gw.count(LOGOUT)).toBe(1);
    expect(c.authRepository.current()).toBeNull();
    expect(c.authRepository.hasSessionHint()).toBe(false);
  });

  it.each([
    ['503', () => json(503, { error: 'temporarily_unavailable' })],
    [
      'network error',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('logout %s: session and hint kept (the refresh cookie is still live)', async (_name, reply) => {
    const { c } = await signedIn({ [LOGOUT]: reply });
    const r = await c.logout.execute();
    expect(r).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(c.authRepository.current()).not.toBeNull();
    expect(c.authRepository.hasSessionHint()).toBe(true);
  });

  it('a stale refresh 401 that lands after a fresh login does not wipe it', async () => {
    let releaseRefresh: (r: Response) => void = () => {};
    const gw = fakeFetch({
      [REFRESH]: () => new Promise<Response>((resolve) => (releaseRefresh = resolve)),
      [LOGIN]: () => json(200, sessionBody({ tok: token('fresh') })),
    });
    const c = createContainer(gw.fetch);
    const pendingRefresh = c.refreshSession.execute();
    await c.login.execute({ phone: '0712345678', pin: '4829' });
    releaseRefresh(json(401, { error: 'invalid_refresh_token' }));
    expect((await pendingRefresh).ok).toBe(false);
    expect(c.authRepository.current()?.accessToken).toBe(token('fresh'));
    expect(c.authRepository.hasSessionHint()).toBe(true);
  });

  it('a stale refresh ok that lands after logout does not sign back in', async () => {
    let releaseRefresh: (r: Response) => void = () => {};
    const { c } = await signedIn({
      [REFRESH]: () => new Promise<Response>((resolve) => (releaseRefresh = resolve)),
      [LOGOUT]: () => json(204),
    });
    const pendingRefresh = c.refreshSession.execute();
    await c.logout.execute();
    releaseRefresh(json(200, sessionBody()));
    await pendingRefresh;
    expect(c.authRepository.current()).toBeNull();
  });

  it('clear() (another tab signed out) drops the session but leaves the shared hint', async () => {
    const { c } = await signedIn({});
    const seen: unknown[] = [];
    c.authRepository.subscribe((s) => seen.push(s));
    c.authRepository.clear();
    expect(c.authRepository.current()).toBeNull();
    expect(seen).toEqual([null]);
    expect(c.authRepository.hasSessionHint()).toBe(true);
  });
});

describe('GatewayAuthRepository refresh single-flight', () => {
  type Chan = { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null };
  function make(locks: unknown, channel: Chan | null) {
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()) });
    const repo = new GatewayAuthRepository(new GatewayAuthDataSource(new HttpClient(gw.fetch)), localStorageHint, { locks, channel } as never);
    return { repo, gw };
  }

  it('concurrent in-tab refreshes share one network call (no locks: fallback, no crash)', async () => {
    const { repo, gw } = make(null, null);
    const rs = await Promise.all([repo.refresh(), repo.refresh(), repo.refreshAccessToken()]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(gw.count(REFRESH)).toBe(1);
  });

  it('serialises under the lock and broadcasts the new session', async () => {
    const posted: unknown[] = [];
    const names: string[] = [];
    const locks = { request: async <T,>(n: string, cb: () => Promise<T>) => (names.push(n), cb()) };
    const { repo, gw } = make(locks, { postMessage: (m) => posted.push(m), onmessage: null });
    await repo.refresh();
    expect(names).toEqual(['salesmesh-refresh']);
    expect(gw.count(REFRESH)).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it('skips the server call when another tab refreshed while waiting for the lock', async () => {
    const channel: Chan = { postMessage: () => {}, onmessage: null };
    const remote = { accessToken: 'remote', expiresAt: Date.now() + 600_000, pinChangeRequired: false, user: { id: 'u', role: 'SALES_AGENT' } };
    // The other tab holds the lock; it broadcasts before our callback runs.
    const locks = {
      request: async <T,>(_n: string, cb: () => Promise<T>) => {
        channel.onmessage?.({ data: { type: 'session', session: remote } });
        return cb();
      },
    };
    const { repo, gw } = make(locks, channel);
    const r = await repo.refresh();
    expect(r.ok && r.value.accessToken).toBe('remote');
    expect(gw.count(REFRESH)).toBe(0);
  });

  it('still calls the server when nothing arrived while waiting for the lock', async () => {
    const { repo, gw } = make({ request: <T,>(_n: string, cb: () => Promise<T>) => cb() }, { postMessage: () => {}, onmessage: null });
    await repo.refresh();
    expect(gw.count(REFRESH)).toBe(1);
  });

  it('a throwing lock request degrades to a direct refresh', async () => {
    const { repo, gw } = make({ request: () => Promise.reject(new Error('nope')) }, null);
    expect((await repo.refresh()).ok).toBe(true);
    expect(gw.count(REFRESH)).toBe(1);
  });
});
