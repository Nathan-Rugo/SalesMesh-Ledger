/**
 * Shared plumbing for the tier-2 scripts (spec gh-15): flags, the run environment, results files,
 * C2B bodies and a tiny HTTP client on Node built-ins. Exit codes: 0 PASS, 1 FAIL, 2 ABORT.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';

export const EXIT = { PASS: 0, FAIL: 1, ABORT: 2 } as const;

/** --name value / --name=value flags; anything not given falls back to `defaults`. */
export function flags<T extends Record<string, string>>(defaults: T, argv = process.argv.slice(2)): T {
  const out: Record<string, string> = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`unexpected argument ${argv[i]}`);
    if (!(m[1] in defaults)) throw new Error(`unknown flag --${m[1]} (known: ${Object.keys(defaults).join(', ')})`);
    out[m[1]] = m[2] ?? argv[++i] ?? '';
  }
  return out as T;
}

export function num(v: string, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got "${v}"`);
  return n;
}

/** The machine the run measured (CPU / RAM matter for reading latency numbers). */
export function environment() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: { model: cpus[0]?.model ?? 'unknown', cores: cpus.length },
    memory_gb: { total: +(os.totalmem() / 2 ** 30).toFixed(2), free_at_start: +(os.freemem() / 2 ** 30).toFixed(2) },
  };
}

/** Writes tests/load/results/<kind>-<timestamp>.json and returns its path. */
export function writeResult(kind: string, data: unknown): string {
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** Daraja timestamps are EAT (UTC+3), yyyyMMddHHmmss. */
export function darajaTime(d: Date): string {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().replace(/\D/g, '').slice(0, 14);
}

export function c2bBody(receipt: string, agentCode: string, amount: number, msisdn: string, at: Date) {
  return {
    TransactionType: 'Pay Bill',
    TransID: receipt,
    TransTime: darajaTime(at),
    TransAmount: amount.toFixed(2),
    BusinessShortCode: '600638',
    BillRefNumber: agentCode,
    MSISDN: msisdn,
    FirstName: 'Load',
  };
}

export interface HttpResult {
  status: number; // 0 = network error or timeout
  error?: string;
}

/** One request with a hard timeout; never throws. */
export function request(url: string, opts: { method?: string; body?: unknown; agent?: http.Agent; timeoutMs?: number } = {}): Promise<HttpResult> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: opts.method ?? (data ? 'POST' : 'GET'),
        agent: opts.agent,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        res.resume(); // drain so keep-alive sockets are reused
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', (e) => resolve({ status: 0, error: e.message }));
      }
    );
    req.setTimeout(opts.timeoutMs ?? 5_000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seeded PRNG (mulberry32) so a run can be repeated exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A distinct-looking Safaricom MSISDN (2547 + 8 digits). */
export const msisdn = (r: () => number) => `2547${String(Math.floor(r() * 1e8)).padStart(8, '0')}`;
