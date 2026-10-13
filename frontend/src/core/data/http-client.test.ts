// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '@/core/di/container';
import { authHeader, fakeFetch, json, sessionBody, token } from '@/test/fake-gateway';
import { parseRetryAfter, toAppError } from './http-client';

const REFRESH = '/api/v1/auth/refresh';
const LOGIN = '/api/v1/auth/login';
const PIN = '/api/v1/auth/pin';

beforeEach(() => window.localStorage.clear());

async function signedIn(routes: Parameters<typeof fakeFetch>[0]) {
  const gw = fakeFetch({ [LOGIN]: () => json(200, sessionBody({ tok: token('old') })), ...routes });
  const c = createContainer(gw.fetch);
  const r = await c.login.execute({ phone: '0712 345 678', pin: '4829' });
  expect(r.ok).toBe(true);
  return { c, gw };
}

describe('HttpClient auth retry', () => {
  it('concurrent 401s share exactly one /refresh and all three are retried', async () => {
    let refreshes = 0;
    const { c, gw } = await signedIn({
      [REFRESH]: async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, sessionBody({ tok: token('new') }));
      },
      '/api/v1/a': (i) => (authHeader(i) === `Bearer ${token('new')}` ? json(200, { a: 1 }) : json(401, { error: 'unauthorized' })),
      '/api/v1/b': (i) => (authHeader(i) === `Bearer ${token('new')}` ? json(200, { b: 1 }) : json(401, { error: 'unauthorized' })),
      '/api/v1/c': (i) => (authHeader(i) === `Bearer ${token('new')}` ? json(200, { c: 1 }) : json(401, { error: 'unauthorized' })),
    });

    const results = await Promise.all(['/api/v1/a', '/api/v1/b', '/api/v1/c'].map((p) => c.http.request(p)));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshes).toBe(1);
    expect(gw.count('/api/v1/a')).toBe(2);
    expect(gw.count('/api/v1/b')).toBe(2);
    expect(gw.count('/api/v1/c')).toBe(2);
  });

  it('a failed refresh signs out exactly once', async () => {
    const { c } = await signedIn({
      [REFRESH]: () => json(401, { error: 'invalid_refresh_token' }),
      '/api/v1/a': () => json(401, { error: 'unauthorized' }),
      '/api/v1/b': () => json(401, { error: 'unauthorized' }),
      '/api/v1/c': () => json(401, { error: 'unauthorized' }),
    });
    let signOuts = 0;
    c.authRepository.subscribe((s) => {
      if (s === null) signOuts++;
    });

    const results = await Promise.all(['/api/v1/a', '/api/v1/b', '/api/v1/c'].map((p) => c.http.request(p)));

    expect(results.map((r) => !r.ok && r.error.kind)).toEqual(['unauthenticated', 'unauthenticated', 'unauthenticated']);
    expect(signOuts).toBe(1);
    expect(c.authRepository.current()).toBeNull();
    expect(c.authRepository.hasSessionHint()).toBe(false);
  });

  it('never retries a 401 from /api/v1/auth/* (each retry would count toward lockout)', async () => {
    const gw = fakeFetch({ [LOGIN]: () => json(401, { error: 'invalid_credentials' }), [REFRESH]: () => json(200, sessionBody()) });
    const c = createContainer(gw.fetch);
    const r = await c.login.execute({ phone: '0712345678', pin: '4829' });
    expect(r).toEqual({ ok: false, error: { kind: 'invalid_credentials' } });
    expect(gw.count(LOGIN)).toBe(1);
    expect(gw.count(REFRESH)).toBe(0);
  });

  it('wrong current PIN on /auth/pin is not retried and keeps the session', async () => {
    const { c, gw } = await signedIn({ '/api/v1/auth/pin': () => json(401, { error: 'invalid_credentials' }), [REFRESH]: () => json(200, sessionBody()) });
    const r = await c.changePin.execute({ currentPin: '4829', newPin: '5830', confirmPin: '5830' });
    expect(r).toEqual({ ok: false, error: { kind: 'invalid_credentials' } });
    expect(gw.count(REFRESH)).toBe(0);
    expect(c.authRepository.current()).not.toBeNull();
  });

  it('expired token on /auth/pin (401 unauthorized): one shared refresh, then one retry with the new token', async () => {
    const { c, gw } = await signedIn({
      [REFRESH]: () => json(200, sessionBody({ tok: token('new') })),
      [PIN]: (i) => (authHeader(i) === `Bearer ${token('new')}` ? json(200, sessionBody({ tok: token('own') })) : json(401, { error: 'unauthorized' })),
    });
    const r = await c.changePin.execute({ currentPin: '4829', newPin: '5830', confirmPin: '5830' });
    expect(r.ok).toBe(true);
    expect(gw.count(REFRESH)).toBe(1);
    expect(gw.count(PIN)).toBe(2);
    expect(c.authRepository.current()?.accessToken).toBe(token('own'));
  });

  it('refresh network failure behind a Bearer 401 is "unavailable" and keeps the session and hint', async () => {
    const { c } = await signedIn({
      '/api/v1/a': () => json(401, { error: 'unauthorized' }),
      [REFRESH]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const r = await c.http.request('/api/v1/a');
    expect(r).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(c.authRepository.current()).not.toBeNull();
    expect(c.authRepository.hasSessionHint()).toBe(true);
  });

  it('sends the access token and same-origin credentials', async () => {
    const { c, gw } = await signedIn({ '/api/v1/x': () => json(200, {}) });
    await c.http.request('/api/v1/x');
    const call = gw.calls.at(-1)!;
    expect(authHeader(call.init)).toBe(`Bearer ${token('old')}`);
    expect(call.init.credentials).toBe('same-origin');
  });

  it('publishes Bearer-route errors to listeners, but not /auth/* ones', async () => {
    const { c } = await signedIn({ '/api/v1/f': () => json(403, { error: 'forbidden' }) });
    const seen: string[] = [];
    c.http.onError((e) => seen.push(e.kind));
    await c.http.request('/api/v1/f');
    await c.http.request(LOGIN, { method: 'POST', body: {}, auth: false });
    expect(seen).toEqual(['forbidden']);
  });

  it('network failure is "unavailable", never a throw', async () => {
    const c = createContainer((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(await c.http.request('/api/v1/x')).toEqual({ ok: false, error: { kind: 'unavailable' } });
  });
});

describe('toAppError', () => {
  it.each([
    [401, { error: 'invalid_credentials' }, null, { kind: 'invalid_credentials' }],
    [401, { error: 'invalid_refresh_token' }, null, { kind: 'unauthenticated' }],
    [403, { error: 'origin_not_allowed' }, null, { kind: 'origin_not_allowed' }],
    [403, { error: 'pin_change_required' }, null, { kind: 'pin_change_required' }],
    [403, { error: 'forbidden' }, null, { kind: 'forbidden' }],
    [400, { error: 'invalid_request' }, null, { kind: 'invalid_request' }],
    [400, { error: 'invalid_pin', reason: 'pin_unchanged', field: 'new_pin' }, null, { kind: 'invalid_pin', reason: 'pin_unchanged', field: 'new_pin' }],
    [400, { error: 'invalid_pin', reason: 'current_pin_missing', field: 'current_pin' }, null, { kind: 'invalid_pin', reason: 'current_pin_missing', field: 'current_pin' }],
    [429, { error: 'too_many_attempts' }, '90', { kind: 'throttled', retryAfterS: 90 }],
    [429, { error: 'too_many_attempts' }, null, { kind: 'throttled', retryAfterS: null }],
    [503, { error: 'temporarily_unavailable' }, null, { kind: 'unavailable' }],
    [500, null, null, { kind: 'unavailable' }],
    [404, null, null, { kind: 'unexpected', status: 404 }],
  ])('%i %j', (status, body, retryAfter, expected) => expect(toAppError(status, body, retryAfter)).toEqual(expected));

  it('parses Retry-After delta-seconds only', () => {
    expect(parseRetryAfter('90')).toBe(90);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter('-1')).toBeNull();
  });
});
