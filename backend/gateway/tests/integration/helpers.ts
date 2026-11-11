/**
 * Integration-test helpers: a throwaway database per test file on the Postgres at
 * TEST_DATABASE_URL (tests are skipped when it is unset).
 *
 *   docker run -d --name sm-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres npx jest tests/integration
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Pool } from 'pg';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const INIT_SQL = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'init_db.sql'), 'utf-8');
export const MIGRATION_001 = fs.readFileSync(
  path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '001_settlement_pipeline.sql'),
  'utf-8'
);
export const MIGRATION_002 = fs.readFileSync(
  path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '002_auth_stk_initiation.sql'),
  'utf-8'
);
export const MIGRATION_003 = fs.readFileSync(
  path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '003_reconciliation.sql'),
  'utf-8'
);
export const MIGRATION_004 = fs.readFileSync(
  path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '004_trust_scores.sql'),
  'utf-8'
);
export const MIGRATION_005 = fs.readFileSync(
  path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '005_payout_destinations.sql'),
  'utf-8'
);
export const MIGRATION_006 = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '006_payout_claims.sql'), 'utf-8');
export const MIGRATION_007 = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '007_unclaimed_reminders.sql'), 'utf-8');
export const MIGRATION_008 = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '008_ufaa_remittance.sql'), 'utf-8');
export const MIGRATION_009 = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '009_frozen_sla_escalation.sql'), 'utf-8');
export const MIGRATION_010 = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '010_admin_oversight.sql'), 'utf-8');
export const MIGRATION_011 = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'scripts', 'migrations', '011_ledger_sync.sql'), 'utf-8');
export const LEGACY_SQL = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_init_db.sql'), 'utf-8');

function urlFor(db: string): string {
  const u = new URL(TEST_DATABASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

export interface TestDb {
  name: string;
  pool: Pool;
  drop(): Promise<void>;
}

/** Creates an empty database and a UTC pool on it. */
export async function createTestDb(prefix = 'sm_it'): Promise<TestDb> {
  const name = `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pool = new Pool({ connectionString: urlFor(name), max: 20, options: '-c TimeZone=UTC' });
  pool.on('error', () => undefined);
  return {
    name,
    pool,
    async drop() {
      await pool.end();
      const a = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Seeds a user + outlet + agent; returns the agent_id. */
export async function seedAgent(pool: Pool, agentCode: string | null, phone?: string): Promise<string> {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (full_name, phone_number, role) VALUES ('Test Agent', $1, 'SALES_AGENT') RETURNING user_id`,
    [phone ?? `2547${crypto.randomInt(10_000_000, 99_999_999)}`]
  );
  const { rows: [o] } = await pool.query(
    `INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ($1, 'Nairobi', 100000) RETURNING outlet_id`,
    [`OUT-${crypto.randomBytes(4).toString('hex')}`]
  );
  const { rows: [a] } = await pool.query(
    `INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, $3) RETURNING agent_id`,
    [u.user_id, o.outlet_id, agentCode]
  );
  return a.agent_id;
}

type MlDecision = { decision: 'CLEAR' | 'QUARANTINE' | 'REVIEW' } & Record<string, unknown>;

/** A contract-valid ml-engine /evaluate response for request `req`; `out` overrides any field. */
export function mlResponse(req: any, out: MlDecision) {
  return {
    transaction_id: req.transaction_id,
    isolation_score: 0.123456789,
    xgb_probability: 0.0456789,
    model_version: 'v1.0.0',
    model_sha256: 'b'.repeat(64),
    triggered_layer: out.decision === 'CLEAR' ? 1 : 2,
    layer2_adjudicated: out.decision !== 'CLEAR',
    reason: 'stub',
    latency_ms: 1,
    evaluated_at: new Date().toISOString(),
    feature_vector: { velocity_v_i: 0.5, split_ratio_r_s: 0.1, entropy_gaps: 1.2, agent_zscore: 0.3, amount_to_median_ratio: 1, recipient_reuse_count: 0 },
    ...out,
  };
}

/**
 * ml-engine stand-in for global.fetch: answers each request for its own transaction_id. The
 * decider may override any response field (e.g. layer2_adjudicated, xgb_probability).
 */
export function mlStub(decide: (req: any) => MlDecision | 'down') {
  const calls: any[] = [];
  const fn = jest.fn(async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const out = decide(req);
    if (out === 'down') throw new Error('connect ECONNREFUSED');
    return { ok: true, status: 200, json: async () => mlResponse(req, out) };
  });
  (global as any).fetch = fn;
  return { fn, calls };
}

export const count = async (pool: Pool, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await pool.query(sql, params)).rows[0].n);
