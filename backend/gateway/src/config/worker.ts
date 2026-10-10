/**
 * @file worker.ts
 * @description Settlement / re-score worker tuning (all overridable via env, see .env.example).
 */

const int = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const clamp = (n: number, min: number, max = Number.MAX_SAFE_INTEGER): number => Math.min(Math.max(n, min), max);

/** Floors that keep a misconfiguration from busy-looping or reclaiming live rows. */
const MIN_POLL_MS = 100;
const MIN_LEASE_MS = 30_000;
/** ml-engine's MAX_REQUEST_BYTES (413 above it). */
const ML_ENGINE_MAX_BODY_BYTES = 524_288;

export interface SettlementWorkerConfig {
  batchSize: number;
  pollIntervalMs: number;
  /** A PROCESSING row whose claim is older than this is presumed crashed and reclaimed. */
  visibilityTimeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  unresolvedWindowMs: number;
  unresolvedBaseDelayMs: number;
  unresolvedMaxDelayMs: number;
  historyLimit: number;
  /** ml-engine rejects bodies above 512 KB; history is trimmed (oldest first) to stay under this. */
  mlMaxBodyBytes: number;
  sweepIntervalMs: number;
  spoolDrainBatch: number;
  commissionRateBps: number;
}

export interface RescoreWorkerConfig {
  intervalMs: number;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  historyLimit: number;
  mlMaxBodyBytes: number;
}

export function settlementWorkerConfig(): SettlementWorkerConfig {
  return {
    batchSize: Math.max(1, int('WORKER_BATCH_SIZE', 5)),
    pollIntervalMs: clamp(int('WORKER_POLL_INTERVAL_MS', 1_000), MIN_POLL_MS),
    visibilityTimeoutMs: clamp(int('WORKER_VISIBILITY_TIMEOUT_MS', 5 * 60_000), MIN_LEASE_MS),
    maxAttempts: Math.max(1, int('WORKER_MAX_ATTEMPTS', 5)),
    backoffBaseMs: int('WORKER_BACKOFF_BASE_MS', 2_000),
    backoffMaxMs: int('WORKER_BACKOFF_MAX_MS', 5 * 60_000),
    unresolvedWindowMs: int('UNRESOLVED_RETRY_WINDOW_MS', 15 * 60_000),
    unresolvedBaseDelayMs: int('UNRESOLVED_BASE_DELAY_MS', 30_000),
    unresolvedMaxDelayMs: int('UNRESOLVED_MAX_DELAY_MS', 5 * 60_000),
    historyLimit: Math.max(0, Math.min(int('ML_MAX_HISTORY_ROWS', 2_000), 2_000)),
    mlMaxBodyBytes: clamp(int('ML_MAX_BODY_BYTES', 500_000), 1_024, ML_ENGINE_MAX_BODY_BYTES),
    sweepIntervalMs: int('WORKER_SWEEP_INTERVAL_MS', 60_000),
    spoolDrainBatch: Math.max(1, int('SPOOL_DRAIN_BATCH', 50)),
    commissionRateBps: clamp(int('COMMISSION_RATE_BPS', 1_000), 0, 10_000), // 10 % placeholder
  };
}

export function rescoreWorkerConfig(): RescoreWorkerConfig {
  return {
    intervalMs: clamp(int('RESCORE_INTERVAL_MS', 30_000), MIN_POLL_MS),
    batchSize: Math.max(1, int('RESCORE_BATCH_SIZE', 10)),
    leaseMs: clamp(int('RESCORE_LEASE_MS', 5 * 60_000), MIN_LEASE_MS),
    maxAttempts: Math.max(1, int('RESCORE_MAX_ATTEMPTS', 20)),
    backoffBaseMs: int('RESCORE_BACKOFF_BASE_MS', 60_000),
    backoffMaxMs: int('RESCORE_BACKOFF_MAX_MS', 60 * 60_000),
    historyLimit: Math.max(0, Math.min(int('ML_MAX_HISTORY_ROWS', 2_000), 2_000)),
    mlMaxBodyBytes: clamp(int('ML_MAX_BODY_BYTES', 500_000), 1_024, ML_ENGINE_MAX_BODY_BYTES),
  };
}
