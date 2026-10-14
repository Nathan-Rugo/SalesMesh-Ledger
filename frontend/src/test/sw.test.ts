import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../../scripts/sw.template.js', import.meta.url), 'utf8');
const ORIGIN = 'http://localhost:3000';
const OFFLINE_HTML =
  '<html><head><link rel="stylesheet" href="/_next/static/chunks/app.css"/></head>' +
  '<body><h1>You are offline</h1><script src="/_next/static/chunks/main.js" async></script></body></html>';

type Req = string | { url: string };
const pathOf = (r: Req) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;

/** Boots the service worker source in a sandbox with fake self / caches / fetch. */
function bootSw() {
  let online = true;
  const network = async (r: Req) => {
    if (!online) throw new TypeError('Failed to fetch');
    const path = pathOf(r);
    return new Response(path === '/offline' ? OFFLINE_HTML : `body of ${path}`, { status: 200 });
  };

  const puts: string[] = [];
  class FakeCache {
    store = new Map<string, Response>();
    async addAll(urls: string[]) {
      for (const u of urls) this.store.set(pathOf(u), await network(u));
    }
    async put(r: Req, res: Response) {
      puts.push(pathOf(r));
      this.store.set(pathOf(r), res);
    }
    async match(r: Req) {
      return this.store.get(pathOf(r))?.clone();
    }
  }
  const named = new Map<string, FakeCache>();
  const caches = {
    open: async (name: string) => named.get(name) ?? named.set(name, new FakeCache()).get(name)!,
    keys: async () => [...named.keys()],
    delete: async (name: string) => named.delete(name),
    match: async (r: Req) => {
      for (const c of named.values()) {
        const hit = await c.match(r);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  runInNewContext(SOURCE, { self, caches, fetch: network, URL, Response, Promise, Set });

  const lifecycle = async (type: 'install' | 'activate') => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const fetchEvent = (path: string, mode = 'no-cors') => {
    let responded: Promise<Response> | null = null;
    handlers.fetch!({ request: { method: 'GET', url: ORIGIN + path, mode }, respondWith: (p: Promise<Response>) => (responded = p), waitUntil: () => {} });
    return responded as Promise<Response> | null;
  };
  return { named, puts, lifecycle, fetchEvent, setOnline: (v: boolean) => (online = v) };
}

describe('service worker', () => {
  it('install precaches the shell and the /_next/static assets referenced by /offline', async () => {
    const sw = bootSw();
    await sw.lifecycle('install');
    const cached = [...sw.named.get('salesmesh-shell-dev')!.store.keys()];
    expect(cached).toEqual(expect.arrayContaining(['/', '/offline', '/icons/192', '/icons/512', '/_next/static/chunks/app.css', '/_next/static/chunks/main.js']));
  });

  it('never answers /api/* (network only, never cached)', async () => {
    const sw = bootSw();
    await sw.lifecycle('install');
    expect(sw.fetchEvent('/api/v1/payouts')).toBeNull();
    expect(sw.fetchEvent('/api/v1/auth/refresh', 'navigate')).toBeNull();
  });

  it('offline navigation to a dashboard resolves to the cached /offline', async () => {
    const sw = bootSw();
    await sw.lifecycle('install');
    sw.setOnline(false);
    const res = await sw.fetchEvent('/agent', 'navigate')!;
    expect(await res.text()).toBe(OFFLINE_HTML);
  });

  it('navigations never write HTML to the cache', async () => {
    const sw = bootSw();
    await sw.lifecycle('install');
    await sw.fetchEvent('/agent', 'navigate');
    await sw.fetchEvent('/admin', 'navigate');
    sw.setOnline(false);
    await sw.fetchEvent('/agent', 'navigate');
    expect(sw.puts).toEqual([]);
  });

  it('activate deletes caches from older builds', async () => {
    const sw = bootSw();
    await sw.lifecycle('install');
    sw.named.set('salesmesh-shell-old', sw.named.get('salesmesh-shell-dev')!);
    await sw.lifecycle('activate');
    expect([...sw.named.keys()]).toEqual(['salesmesh-shell-dev']);
  });
});
