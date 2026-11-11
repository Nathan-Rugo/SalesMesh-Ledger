/**
 * Open-model webhook load generator (spec gh-15, tier 2; NFR-01 sub-200 ms ingestion).
 *
 *   npm run load:webhooks -- --rate 200 --duration 60 --warmup 10 --base-url http://localhost:4000
 *   (env: MPESA_CALLBACK_TOKEN; optional DATABASE_URL to verify one intake row per ACKed receipt)
 *
 * Constant arrival: request i is due at t0 + i/rate whatever the earlier ones are doing, and its
 * latency is measured from that intended time, so a stalled gateway cannot hide its queueing
 * (no coordinated omission). Every receipt is unique. The warm-up is sent but not measured.
 *
 * PASS when, over the measured window: p95 ≤ 200 ms, 0 non-2xx (timeouts count), 0 ACKed receipts
 * missing from mpesa_callbacks (when DATABASE_URL is set) and the generator kept ≥ 95% of the rate.
 * With DATABASE_URL the --agent-code agent is seeded first (idempotently), so rows settle on the
 * known-agent path; without it the code may be unknown and the worker parks rows UNRESOLVED (the
 * hot path itself is the same: the agent is resolved after the ACK). The JSON records which.
 * Exit 0 PASS, 1 FAIL, 2 ABORT (target unreachable).
 */

import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { Client } from 'pg';
import { summarise, rate as ciRate } from '../support/stats';
import { c2bBody, count, environment, EXIT, flags, num, pos, request, sleep, writeResult } from './common';

const SLA_P95_MS = 200; // NFR-01
const MIN_RATE_FRACTION = 0.95;

interface Sample {
  receipt: string;
  intended: number;
  sentAt: number;
  doneAt: number;
  status: number;
  error?: string;
  measured: boolean;
}

async function main(): Promise<number> {
  const f = flags({
    rate: '200',
    duration: '60',
    warmup: '10',
    'base-url': process.env.BASE_URL ?? 'http://localhost:4000',
    token: process.env.MPESA_CALLBACK_TOKEN ?? '',
    'agent-code': 'LOADTEST',
    'timeout-ms': '2000',
  });
  const config = {
    rate: count(f.rate, 'rate'),
    duration_s: count(f.duration, 'duration'),
    warmup_s: num(f.warmup, 'warmup'),
    base_url: f['base-url'].replace(/\/+$/, ''),
    agent_code: f['agent-code'],
    timeout_ms: pos(f['timeout-ms'], 'timeout-ms'),
    db_verification: Boolean(process.env.DATABASE_URL),
    thresholds: { p95_ms: SLA_P95_MS, non_2xx: 0, lost_receipts: 0, min_rate_fraction: MIN_RATE_FRACTION },
  };
  const result: Record<string, unknown> = { kind: 'webhook-load', started_at: new Date().toISOString(), config, environment: environment() };
  const finish = (verdict: 'PASS' | 'FAIL' | 'ABORT', extra: Record<string, unknown>) => {
    Object.assign(result, extra, { verdict, finished_at: new Date().toISOString() });
    const file = writeResult('load', result);
    console.log(`${verdict} — results: ${file}`);
    return EXIT[verdict];
  };

  if (!f.token) return finish('ABORT', { reason: 'MPESA_CALLBACK_TOKEN (or --token) is required' });
  const live = await request(`${config.base_url}/health/live`, { timeoutMs: 3_000 });
  if (live.status !== 200) return finish('ABORT', { reason: `gateway not reachable at ${config.base_url} (${live.error ?? live.status})` });

  let agentSeeded = false;
  if (process.env.DATABASE_URL) {
    try {
      agentSeeded = await seedAgent(process.env.DATABASE_URL, config.agent_code);
    } catch (e) {
      return finish('ABORT', { reason: `DATABASE_URL set but seeding --agent-code failed: ${(e as Error).message}` });
    }
  }
  Object.assign(config, { agent_path: agentSeeded ? 'known agent (seeded)' : 'not seeded: unknown-agent (UNRESOLVED) path after the ACK' });

  const url = `${config.base_url}/api/v1/mpesa/callback/${encodeURIComponent(f.token)}`;
  const agent = new (url.startsWith('https:') ? https.Agent : http.Agent)({ keepAlive: true, maxSockets: 2_048 });
  const runId = crypto.randomBytes(3).toString('hex').toUpperCase();
  const total = Math.round(config.rate * (config.warmup_s + config.duration_s));
  const warmupCount = Math.round(config.rate * config.warmup_s);
  const intervalMs = 1_000 / config.rate;
  console.log(`load: ${total} requests at ${config.rate}/s (${warmupCount} warm-up) → ${config.base_url}, run ${runId}`);

  const samples: Sample[] = [];
  const inflight: Promise<void>[] = [];
  const t0 = performance.now() + 50;
  const wallT0 = Date.now() + 50;
  for (let i = 0; i < total; i++) {
    const intended = t0 + i * intervalMs;
    const wait = intended - performance.now();
    if (wait > 1) await sleep(wait);
    const receipt = `LD${runId}${i.toString(36).toUpperCase().padStart(6, '0')}`;
    const body = c2bBody(receipt, config.agent_code, 100 + (i % 900), `2547${String(i % 1e8).padStart(8, '0')}`, new Date(wallT0 + i * intervalMs));
    const sentAt = performance.now();
    inflight.push(
      request(url, { body, agent, timeoutMs: config.timeout_ms }).then((r) => {
        samples.push({ receipt, intended, sentAt, doneAt: performance.now(), status: r.status, error: r.error, measured: i >= warmupCount });
      })
    );
  }
  await Promise.all(inflight);
  agent.destroy();

  const measured = samples.filter((s) => s.measured).sort((a, b) => a.intended - b.intended);
  const latency = measured.map((s) => s.doneAt - s.intended);
  const service = measured.map((s) => s.doneAt - s.sentAt);
  const lag = measured.map((s) => s.sentAt - s.intended);
  const non2xx = measured.filter((s) => s.status < 200 || s.status >= 300);
  const spanS = measured.length > 1 ? (measured.at(-1)!.sentAt - measured[0].sentAt) / 1_000 : 0;
  const achieved = spanS > 0 ? (measured.length - 1) / spanS : 0;
  const errors: Record<string, number> = {};
  for (const s of non2xx) errors[s.error ?? `HTTP ${s.status}`] = (errors[s.error ?? `HTTP ${s.status}`] ?? 0) + 1;

  // Every SENT receipt is checked: lost = ACKed without a row; rows for non-ACKed sends are reported apart.
  let lost: number | null = null;
  let verifiedRows: number | null = null;
  let nonAckedWithRow: number | null = null;
  const acked = samples.filter((s) => s.status === 200).map((s) => s.receipt);
  if (process.env.DATABASE_URL) {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await db.connect();
      const { rows } = await db.query(`SELECT mpesa_receipt_id AS r FROM mpesa_callbacks WHERE mpesa_receipt_id = ANY($1::text[])`, [samples.map((s) => s.receipt)]);
      const found = new Set(rows.map((x) => x.r as string));
      verifiedRows = found.size;
      lost = acked.filter((r) => !found.has(r)).length;
      nonAckedWithRow = samples.filter((s) => s.status !== 200 && found.has(s.receipt)).length;
    } catch (e) {
      return finish('ABORT', { reason: `DATABASE_URL set but verification failed: ${(e as Error).message}` });
    } finally {
      await db.end().catch(() => undefined);
    }
  }

  const lat = summarise(latency);
  const metrics = {
    run_id: runId,
    sent: samples.length,
    measured: measured.length,
    achieved_rate_per_s: +achieved.toFixed(2),
    latency_ms_from_intended: lat,
    service_time_ms: summarise(service),
    generator_lag_ms: summarise(lag),
    non_2xx: ciRate(non2xx.length, measured.length),
    over_sla: ciRate(latency.filter((l) => l > SLA_P95_MS).length, measured.length),
    errors,
    acked_receipts_all: acked.length,
    intake_rows_found_for_sent: verifiedRows,
    non_acked_with_row: nonAckedWithRow,
    lost_receipts: lost,
  };
  const failures: string[] = [];
  if (lat.p95 === null || lat.p95 > SLA_P95_MS) failures.push(`p95 ${lat.p95?.toFixed(1)} ms > ${SLA_P95_MS} ms`);
  if (non2xx.length > 0) failures.push(`${non2xx.length} non-2xx`);
  if (lost !== null && lost > 0) failures.push(`${lost} ACKed receipts missing from mpesa_callbacks`);
  if (achieved < MIN_RATE_FRACTION * config.rate) failures.push(`achieved ${achieved.toFixed(1)}/s < ${MIN_RATE_FRACTION * 100}% of ${config.rate}/s`);
  console.log(
    `p50 ${lat.p50?.toFixed(1)} ms, p95 ${lat.p95?.toFixed(1)} ms, p99 ${lat.p99?.toFixed(1)} ms, max ${lat.max?.toFixed(1)} ms; ` +
      `${non2xx.length}/${measured.length} non-2xx; ${achieved.toFixed(1)}/s; lost ${lost ?? 'not verified'}`
  );
  if (failures.length) console.log(`threshold misses: ${failures.join('; ')}`);
  return finish(failures.length ? 'FAIL' : 'PASS', { metrics, failures });
}

/** Seeds user + outlet + agent for `code` unless it exists; true once the agent is on file. */
async function seedAgent(connectionString: string, code: string): Promise<boolean> {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    const { rowCount } = await db.query(`SELECT 1 FROM sales_agents WHERE agent_code = $1`, [code]);
    if (rowCount) return true;
    const phone = `2547${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
    const { rows: [u] } = await db.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Load Test', $1, 'SALES_AGENT') RETURNING user_id`, [phone]);
    const { rows: [o] } = await db.query(
      `INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ($1, 'Nairobi', 100000) RETURNING outlet_id`,
      [`OUT-${code}-${crypto.randomBytes(3).toString('hex')}`]
    );
    await db.query(`INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, $3)`, [u.user_id, o.outlet_id, code]);
    return true;
  } finally {
    await db.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ABORT: ${(e as Error).message}`);
      process.exit(EXIT.ABORT);
    }
  );
}
