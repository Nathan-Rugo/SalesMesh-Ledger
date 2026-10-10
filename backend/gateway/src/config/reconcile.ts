/**
 * @file reconcile.ts
 * @description Daraja reconciliation settings (spec gh-6-recon): the STK Query sweep and the
 * M-Pesa statement import. All overridable via env (see .env.example).
 */

import { STK_TTL_MS } from './stk';

const int = (env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const n = parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

/** RECONCILE_ENABLED=true starts the STK Query sweep (startup then requires the Daraja credentials). */
export const reconcileEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.RECONCILE_ENABLED === 'true';

export interface ReconcileSweepConfig {
  intervalMs: number;
  batchSize: number;
  /** ACCEPTED requests older than STK_TTL + this (default 10 min) are overdue. */
  graceMs: number;
  /** Only requests newer than this are swept (default 7 d): the first deploy never queries all history. */
  maxAgeMs: number;
  /** STK Query rate limit (queries per second, per process). */
  qps: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export function reconcileSweepConfig(env: NodeJS.ProcessEnv = process.env): ReconcileSweepConfig {
  const qpsRaw = Number(env.RECONCILE_QPS);
  return {
    intervalMs: int(env, 'RECONCILE_INTERVAL_MS', 60_000, 1_000),
    batchSize: int(env, 'RECONCILE_BATCH_SIZE', 20, 1, 500),
    graceMs: int(env, 'RECONCILE_GRACE_MS', 10 * 60_000),
    maxAgeMs: int(env, 'RECONCILE_MAX_AGE_MS', 7 * 24 * 3_600_000, 60_000),
    qps: Number.isFinite(qpsRaw) && qpsRaw > 0 ? Math.min(qpsRaw, 20) : 1,
    leaseMs: int(env, 'RECONCILE_LEASE_MS', 5 * 60_000, 30_000),
    maxAttempts: int(env, 'RECONCILE_MAX_ATTEMPTS', 8, 1, 1_000),
    backoffBaseMs: int(env, 'RECONCILE_BACKOFF_BASE_MS', 2 * 60_000),
    backoffMaxMs: int(env, 'RECONCILE_BACKOFF_MAX_MS', 6 * 3_600_000),
  };
}

/** Age past which an ACCEPTED request with no callback is overdue (STK_TTL + grace). */
export const overdueAfterMs = (cfg: Pick<ReconcileSweepConfig, 'graceMs'>): number => STK_TTL_MS + cfg.graceMs;

export interface ReconcileImportConfig {
  /** The Daraja shortcode(s) a statement must belong to (DARAJA_BUSINESS_SHORTCODE / DARAJA_PARTY_B). */
  shortCodes: string[];
  /** When set, the statement's Account must equal this (case-insensitive). */
  expectedAccount: string | null;
  /** Whitelisted `Details` / `Reason Type` prefixes that create payments (case-insensitive). */
  creditTypes: string[];
  /** Above either cap a real import needs --confirm. */
  confirmMaxRows: number;
  confirmMaxAmountCents: number;
  /** Where the original file is copied (a directory named by its SHA-256). */
  evidenceDir: string;
  /** Binding window allowance for clock skew between Safaricom and the gateway. */
  clockSkewMs: number;
  /** A known receipt's payment time may differ from the statement's Completion Time by at most this. */
  timeToleranceMs: number;
  /** STK callbacks are paid to this shortcode (DARAJA_PARTY_B, else DARAJA_BUSINESS_SHORTCODE). */
  receivingShortCode: string | null;
  /** Above this many two-way security holds a real import needs --confirm. */
  twoWayMaxHolds: number;
}

export const DEFAULT_CREDIT_TYPES = ['Pay Bill Online', 'Pay Bill from', 'Merchant Payment'];

export function reconcileImportConfig(env: NodeJS.ProcessEnv = process.env): ReconcileImportConfig {
  const shortCodes = [env.DARAJA_BUSINESS_SHORTCODE, env.DARAJA_PARTY_B].map((v) => (v ?? '').trim()).filter((v) => v.length > 0);
  const types = (env.RECONCILE_CREDIT_TYPES ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const maxAmountKes = int(env, 'RECONCILE_CONFIRM_MAX_AMOUNT', 500_000, 0);
  return {
    shortCodes: [...new Set(shortCodes)],
    expectedAccount: env.RECONCILE_EXPECTED_ACCOUNT?.trim() || null,
    creditTypes: types.length ? types : DEFAULT_CREDIT_TYPES,
    confirmMaxRows: int(env, 'RECONCILE_CONFIRM_MAX_ROWS', 50, 0),
    confirmMaxAmountCents: maxAmountKes * 100,
    evidenceDir: env.RECONCILE_EVIDENCE_DIR?.trim() || 'reconcile-evidence',
    clockSkewMs: int(env, 'STK_CLOCK_SKEW_MS', 60_000, 0, 600_000),
    timeToleranceMs: int(env, 'RECONCILE_TIME_TOLERANCE_MS', 10 * 60_000, 0),
    receivingShortCode: env.DARAJA_PARTY_B?.trim() || env.DARAJA_BUSINESS_SHORTCODE?.trim() || null,
    twoWayMaxHolds: int(env, 'RECONCILE_TWO_WAY_MAX_HOLDS', 5, 0),
  };
}
