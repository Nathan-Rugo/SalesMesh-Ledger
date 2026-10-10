/** Tiny HTTP client for tests (no supertest dependency). */

import http from 'http';
import type { Express } from 'express';

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  /** Set-Cookie headers. */
  cookies: string[];
}

export interface TestServer {
  port: number;
  close(): Promise<void>;
  request(method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown; raw?: string }): Promise<TestResponse>;
}

export async function listen(app: Express): Promise<TestServer> {
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    request(method, path, opts = {}) {
      return new Promise((resolve, reject) => {
        const data = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
        const headers: Record<string, string | number> = { ...(opts.headers ?? {}) };
        if (data !== undefined) {
          headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
          headers['Content-Length'] = Buffer.byteLength(data);
        }
        const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => {
            let body: any = b;
            try {
              body = b ? JSON.parse(b) : null;
            } catch {
              /* not JSON */
            }
            const sc = res.headers['set-cookie'];
            resolve({ status: res.statusCode!, headers: res.headers, body, cookies: Array.isArray(sc) ? sc : sc ? [sc] : [] });
          });
        });
        req.on('error', reject);
        if (data !== undefined) req.write(data);
        req.end();
      });
    },
  };
}

/** "name=value" of a Set-Cookie header with that cookie name, or undefined. */
export function cookieValue(cookies: string[], name: string): string | undefined {
  const c = cookies.find((x) => x.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(';')[0]) : undefined;
}
