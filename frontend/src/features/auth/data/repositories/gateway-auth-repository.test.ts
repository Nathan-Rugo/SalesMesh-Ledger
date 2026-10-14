// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '@/core/di/container';
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
