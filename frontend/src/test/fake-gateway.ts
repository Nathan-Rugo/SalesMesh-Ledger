import { vi } from 'vitest';

/** Builds a JSON Response the way the gateway sends them. */
export function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  if (body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A syntactically valid (unsigned) JWT-shaped token. */
export const token = (n: number | string) => `h.${n}.s`;

export const sessionBody = (opts: { role?: string; pinChangeRequired?: boolean; tok?: string } = {}) => ({
  access_token: opts.tok ?? token(1),
  token_type: 'Bearer',
  expires_in: 900,
  pin_change_required: opts.pinChangeRequired ?? false,
  user: { user_id: 'u-1', role: opts.role ?? 'SALES_AGENT' },
});

type Handler = (init: RequestInit & { url: string }) => Response | Promise<Response>;

/** fetch double routed by path; records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) throw new TypeError(`no route for ${url}`);
    return handler({ ...init, url });
  });
  return { fetch: fn as unknown as typeof fetch, calls, count: (url: string) => calls.filter((c) => c.url === url).length };
}

export const bodyOf = (init: RequestInit): unknown => JSON.parse(String(init.body));
export const authHeader = (init: RequestInit): string | undefined => (init.headers as Record<string, string>).Authorization;
