/**
 * End-to-end commission-stuffing detection (spec gh-15, tier 2) against the REAL ml-engine.
 *
 *   npm run load:stuffing -- --events 120 --agents 24 --base-url http://localhost:4000 --ml-url http://localhost:8000
 *   (env: MPESA_CALLBACK_TOKEN, DATABASE_URL — the gateway's own database)
 *
 * Seeds agents, sends benign background C2B callbacks, waits for settlement, then sends stuffing
 * bursts ported from ml-engine/engine/fraud_injector.py (θ = 5000; anchor A in (θ, 6.79θ]; k ~
 * U{max(3, ⌈A/0.97θ⌉)..7}; splits sum to A exactly, 100 ≤ a_j < 0.98θ; same agent and payer within
 * 20 min). An event is detected when ANY of its splits got a non-CLEAR INITIAL model decision
 * (eval.py event_table: detected = any flagged row). Benign rows decide the FPR (reported only).
 *
 * PASS when the event recall's exact 95% CI lower bound ≥ 0.90. Any fail-safe decision means the
 * gateway could not reach ml-engine: ABORT, never PASS. Exit 0 PASS, 1 FAIL, 2 ABORT.
 */

import crypto from 'crypto';
import { Client } from 'pg';
import { rate as ciRate } from '../support/stats';
import { c2bBody, count, environment, EXIT, flags, msisdn, num, pos, request, rng, sleep, writeResult } from './common';

const RECALL_CI_LOW_MIN = 0.9;
// ml-engine/reports/metrics.json (offline, test split): stuffing event recall 84/84, CI-low 0.957.
const OFFLINE_BASELINE = { k: 84, n: 84, ci_low: 0.957, source: 'ml-engine/reports/metrics.json' };

/** Gamma(α, 1) (Marsaglia–Tsang; α < 1 by the boost α+1 · U^(1/α)). */
function gamma(r: () => number, alpha: number): number {
  if (alpha < 1) return gamma(r, alpha + 1) * r() ** (1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = r();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** fraud_injector.sample_splits: k cent amounts summing to total with lower ≤ a < upper. */
export function sampleSplits(r: () => number, total: number, k: number, lower: number, upper: number): number[] {
  const totalC = Math.round(total * 100);
  if (Math.floor(totalC / k) < lower * 100 || Math.ceil(totalC / k) >= upper * 100) throw new Error(`infeasible split ${total}/${k}`);
  for (const alpha of [1, 4, 16, 64, 256, 1024, 4096]) {
    for (let t = 0; t < 200; t++) {
      const g = Array.from({ length: k }, () => gamma(r, alpha));
      const sum = g.reduce((a, b) => a + b, 0);
      const cents = g.map((x) => Math.floor((x / sum) * totalC));
      cents[Math.floor(r() * k)] += totalC - cents.reduce((a, b) => a + b, 0);
      const amounts = cents.map((c) => c / 100);
      if (Math.min(...amounts) >= lower && Math.max(...amounts) < upper) return amounts;
    }
  }
  const base = Math.floor(totalC / k);
  return Array.from({ length: k }, (_, i) => (base + (i < totalC % k ? 1 : 0)) / 100);
}

const lognormal = (r: () => number, median: number, sigma: number) => Math.min(Math.max(median * Math.exp(sigma * normal(r)), 50), 250_000);

interface Row {
  receipt: string;
  agentCode: string;
  amount: number;
  msisdn: string;
  at: Date;
  event: number | null; // stuffing event id, null = benign
}

async function main(): Promise<number> {
  const f = flags({
    events: '120',
    agents: '24',
    'benign-per-agent': '40',
    theta: '5000',
    seed: '7',
    'base-url': process.env.BASE_URL ?? 'http://localhost:4000',
    'ml-url': process.env.ML_URL ?? 'http://localhost:8000',
    token: process.env.MPESA_CALLBACK_TOKEN ?? '',
    'settle-timeout-s': '1800',
  });
  const config = {
    events: count(f.events, 'events'),
    agents: count(f.agents, 'agents'),
    benign_per_agent: num(f['benign-per-agent'], 'benign-per-agent'),
    theta: pos(f.theta, 'theta'),
    seed: num(f.seed, 'seed'),
    base_url: f['base-url'].replace(/\/+$/, ''),
    ml_url: f['ml-url'].replace(/\/+$/, ''),
    settle_timeout_s: num(f['settle-timeout-s'], 'settle-timeout-s'),
    k_max: 7,
    window_minutes: 20,
    thresholds: { event_recall_ci_low: RECALL_CI_LOW_MIN },
  };
  const result: Record<string, unknown> = { kind: 'stuffing-e2e', started_at: new Date().toISOString(), config, environment: environment(), baseline: OFFLINE_BASELINE };
  const finish = (verdict: 'PASS' | 'FAIL' | 'ABORT', extra: Record<string, unknown>) => {
    Object.assign(result, extra, { verdict, finished_at: new Date().toISOString() });
    console.log(`${verdict}${extra.reason ? ` (${extra.reason})` : ''} — results: ${writeResult('stuffing', result)}`);
    return EXIT[verdict];
  };

  // Inputs that would hang the anchor draw or overlap one agent's 20-minute windows.
  // Splits need A/k >= 100 with A > theta, k <= 7, so theta >= 700; above 50000 the anchor tail is empty.
  const perAgent = Math.ceil(config.events / config.agents);
  const slotMs = (19 * 86_400_000) / perAgent;
  if (config.theta < 700 || config.theta > 50_000) return finish('ABORT', { reason: `--theta ${config.theta} outside [700, 50000]` });
  if (slotMs <= 2 * config.window_minutes * 60_000)
    return finish('ABORT', { reason: `${perAgent} events per agent overlap their ${config.window_minutes}-minute windows; raise --agents` });

  // Preflight: every dependency must be reachable, or the run aborts (never a pass by default).
  if (!process.env.DATABASE_URL) return finish('ABORT', { reason: 'DATABASE_URL is required' });
  if (!f.token) return finish('ABORT', { reason: 'MPESA_CALLBACK_TOKEN (or --token) is required' });
  const mlHealth = await request(`${config.ml_url}/health`, { timeoutMs: 3_000 });
  if (mlHealth.status !== 200) return finish('ABORT', { reason: `ml-engine unreachable at ${config.ml_url} (${mlHealth.error ?? mlHealth.status})` });
  const ready = await request(`${config.base_url}/health/ready`, { timeoutMs: 3_000 });
  if (ready.status !== 200) return finish('ABORT', { reason: `gateway not ready at ${config.base_url} (${ready.error ?? ready.status})` });
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
  } catch (e) {
    return finish('ABORT', { reason: `database unreachable: ${(e as Error).message}` });
  }

  try {
    const r = rng(config.seed);
    const runId = crypto.randomBytes(3).toString('hex').toUpperCase();
    const now = Date.now();
    const day = 86_400_000;
    // Phones mix in runId: users.phone_number is UNIQUE, so a rerun with the same seed must differ.
    const agentPhone = (i: number) =>
      `2547${String(parseInt(crypto.createHash('sha256').update(`${runId}:${i}`).digest('hex').slice(0, 12), 16) % 1e8).padStart(8, '0')}`;
    const codes = Array.from({ length: config.agents }, (_, i) => `SE${runId}${i}`);
    for (const [i, code] of codes.entries()) {
      const { rows: [u] } = await db.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Stuffing E2E', $1, 'SALES_AGENT') RETURNING user_id`, [agentPhone(i)]);
      const { rows: [o] } = await db.query(
        `INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ($1, 'Nairobi', 100000) RETURNING outlet_id`,
        [`OUT-${code}`]
      );
      await db.query(`INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, $3)`, [u.user_id, o.outlet_id, code]);
    }

    let seq = 0;
    const receipt = () => `SE${runId}${(seq++).toString(36).toUpperCase().padStart(6, '0')}`;
    const benign: Row[] = [];
    const stuffing: Row[] = [];
    for (const code of codes) {
      for (let i = 0; i < config.benign_per_agent; i++) {
        benign.push({ receipt: receipt(), agentCode: code, amount: +lognormal(r, 1500, 0.9).toFixed(2), msisdn: msisdn(r), at: new Date(now - 28 * day + r() * 27 * day), event: null });
      }
    }
    const maxAnchor = config.k_max * 0.97 * config.theta;
    for (let e = 0; e < config.events; e++) {
      const code = codes[e % codes.length];
      const slot = Math.floor(e / codes.length);
      const anchorAt = now - 20 * day + slot * slotMs + r() * (slotMs - config.window_minutes * 60_000);
      let total = NaN;
      for (let t = 0; t < 100_000 && !(total > config.theta && total <= maxAnchor); t++) total = lognormal(r, 1500, 0.9);
      // shortcut: uniform fallback when the log-normal tail is too thin for rejection (extreme theta).
      if (!(total > config.theta && total <= maxAnchor)) total = config.theta + r() * (maxAnchor - config.theta);
      total = +total.toFixed(2);
      const kLo = Math.max(3, Math.ceil(total / (0.97 * config.theta)));
      const k = kLo + Math.floor(r() * (config.k_max - kLo + 1));
      const amounts = sampleSplits(r, total, k, 100, 0.98 * config.theta);
      const offsets = [0, ...Array.from({ length: k - 1 }, () => r() * config.window_minutes * 60_000)].sort((a, b) => a - b);
      const payer = msisdn(r);
      amounts.forEach((amount, j) => stuffing.push({ receipt: receipt(), agentCode: code, amount, msisdn: payer, at: new Date(anchorAt + offsets[j]), event: e }));
    }

    const url = `${config.base_url}/api/v1/mpesa/callback/${encodeURIComponent(f.token)}`;
    /** Per agent in time order (history is built from settled rows); agents in parallel. */
    const send = async (rows: Row[]) => {
      const byAgent = new Map<string, Row[]>();
      for (const row of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) byAgent.set(row.agentCode, [...(byAgent.get(row.agentCode) ?? []), row]);
      await Promise.all(
        [...byAgent.values()].map(async (list) => {
          for (const row of list) {
            let status = 0;
            for (let t = 0; t < 10 && status !== 200; t++) {
              status = (await request(url, { body: c2bBody(row.receipt, row.agentCode, row.amount, row.msisdn, row.at), timeoutMs: 5_000 })).status;
              if (status !== 200) await sleep(500 * (t + 1));
            }
            if (status !== 200) throw new Error(`receipt ${row.receipt} never ACKed (last ${status})`);
          }
        })
      );
    };
    const settled = async (rows: Row[]) => {
      const ids = rows.map((x) => x.receipt);
      const deadline = Date.now() + config.settle_timeout_s * 1_000;
      for (;;) {
        const { rows: [c] } = await db.query(
          `SELECT count(*) FILTER (WHERE status = 'SETTLED')::int AS done, count(*) FILTER (WHERE status IN ('UNRESOLVED', 'FAILED', 'DEAD'))::int AS bad
             FROM mpesa_callbacks WHERE mpesa_receipt_id = ANY($1::text[])`,
          [ids]
        );
        if (c.bad > 0) throw new Error(`${c.bad} callbacks did not settle (UNRESOLVED/FAILED/DEAD)`);
        if (c.done === ids.length) return;
        if (Date.now() > deadline) throw new Error(`only ${c.done}/${ids.length} settled within ${config.settle_timeout_s} s`);
        await sleep(2_000);
      }
    };

    console.log(`stuffing-e2e run ${runId}: ${benign.length} benign, ${config.events} events (${stuffing.length} splits) over ${codes.length} agents`);
    await send(benign);
    await settled(benign);
    await send(stuffing);
    await settled(stuffing);

    const all = [...benign, ...stuffing];
    const { rows: scored } = await db.query(
      `SELECT t.mpesa_receipt_id AS receipt, v.decision, v.is_fail_safe
         FROM transactions t JOIN verification_events v ON v.transaction_id = t.transaction_id AND v.kind = 'INITIAL'
        WHERE t.mpesa_receipt_id = ANY($1::text[])`,
      [all.map((x) => x.receipt)]
    );
    const byReceipt = new Map(scored.map((s) => [s.receipt as string, s]));
    const failSafe = scored.filter((s) => s.is_fail_safe).length;
    if (failSafe > 0) return finish('ABORT', { reason: `${failSafe} rows scored fail-safe: ml-engine was unreachable from the gateway` });
    if (byReceipt.size !== all.length) return finish('ABORT', { reason: `${all.length - byReceipt.size} rows have no INITIAL verification event` });

    const flagged = (row: Row) => byReceipt.get(row.receipt)!.decision !== 'CLEAR';
    const detected = new Set(stuffing.filter(flagged).map((x) => x.event));
    const recall = ciRate(detected.size, config.events);
    const metrics = {
      run_id: runId,
      event_recall: recall,
      split_recall: ciRate(stuffing.filter(flagged).length, stuffing.length),
      benign_fpr: ciRate(benign.filter(flagged).length, benign.length),
      decisions: scored.reduce<Record<string, number>>((acc, s) => ((acc[s.decision] = (acc[s.decision] ?? 0) + 1), acc), {}),
    };
    console.log(
      `event recall ${detected.size}/${config.events} (95% CI ${recall.ci95?.map((x) => x.toFixed(3)).join('–')}); ` +
        `benign FPR ${metrics.benign_fpr.k}/${metrics.benign_fpr.n}`
    );
    const low = recall.ci95?.[0] ?? 0;
    return finish(low >= RECALL_CI_LOW_MIN ? 'PASS' : 'FAIL', {
      metrics,
      failures: low >= RECALL_CI_LOW_MIN ? [] : [`event recall CI-low ${low.toFixed(3)} < ${RECALL_CI_LOW_MIN}`],
    });
  } catch (e) {
    return finish('ABORT', { reason: (e as Error).message });
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
