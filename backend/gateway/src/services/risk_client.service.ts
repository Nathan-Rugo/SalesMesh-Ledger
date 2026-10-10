/**
 * @file risk_client.service.ts
 * @description Resilient HTTP client for the ML Fraud Detection Service, with a Circuit
 * Breaker State Machine to prevent system overload during ML service degradation.
 *
 * Contract: mirrors ml-engine `service/schemas.py` (EvaluateRequest / EvaluateResponse), RAW
 * mode: the gateway sends the transaction plus the agent's own history and ml-engine computes
 * the 6 features with the same code it trained with (train/serve parity). ml-engine forbids
 * unknown request fields and rejects NaN/Infinity, so the types below stay in lock-step.
 */

import { field } from '../domain/unknown';

/** The transaction being scored (ml-engine RawTransaction). */
export interface RawTransaction {
  agent_id: string;
  timestamp: string; // ISO-8601 UTC
  amount: number; // KES
  counterparty_id: string; // keyed hash, never an MSISDN
}

/** One prior transaction of the SAME agent (ml-engine HistoryRow). */
export interface HistoryRow extends RawTransaction {
  transaction_id: string; // M-Pesa receipt, as on the scored side
}

/** ml-engine EvaluateRequest, raw mode. */
export interface RiskEvaluationRequest {
  transaction_id: string; // M-Pesa receipt: the NFR-09 join key across Postgres and Fabric
  transaction: RawTransaction;
  history: HistoryRow[];
  include_shap?: boolean;
}

export type RiskDecisionValue = 'CLEAR' | 'QUARANTINE' | 'REVIEW';

export type FailSafeCause =
  | 'circuit_open'
  | 'probe_in_flight'
  | 'timeout'
  | 'service_unavailable'
  | 'inference_error'
  | 'invalid_request'
  | 'payload_too_large';

/** Causes where re-submitting the same request later may succeed (self-healing quarantine). */
export const RETRYABLE_FAIL_SAFE_CAUSES: readonly FailSafeCause[] = [
  'circuit_open',
  'probe_in_flight',
  'timeout',
  'service_unavailable',
  'inference_error',
];

/** ml-engine EvaluateResponse fields the gateway relies on, plus the fail-safe marker. */
export interface RiskEvaluationResponse {
  transaction_id: string;
  isolation_score: number | null; // null on fail-safe
  xgb_probability: number | null; // null on fail-safe
  model_version: string;
  model_sha256: string | null;
  decision: RiskDecisionValue;
  triggered_layer: number | null;
  layer2_adjudicated: boolean | null;
  reason: string;
  latency_ms: number;
  evaluated_at: string;
  is_fail_safe: boolean;
  fail_safe_cause: FailSafeCause | null;
}

const DECISIONS: ReadonlySet<string> = new Set(['CLEAR', 'QUARANTINE', 'REVIEW']);
const ML_CAUSES: ReadonlySet<string> = new Set(['service_unavailable', 'inference_error', 'invalid_request', 'payload_too_large']);
const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isAmount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isIso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isId = (v: unknown): boolean => typeof v === 'string' && v.length >= 1 && v.length <= 128;

/** Accepts only a well-formed ml-engine EvaluateResponse for this transaction; anything else fails closed. */
function parseResponse(body: unknown, transactionId: string): RiskEvaluationResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.transaction_id !== transactionId) return null;
  if (typeof b.decision !== 'string' || !DECISIONS.has(b.decision)) return null;
  if (!isUnit(b.isolation_score) || !isUnit(b.xgb_probability)) return null;
  if (typeof b.model_version !== 'string' || b.model_version.length === 0) return null;
  return {
    transaction_id: transactionId,
    isolation_score: b.isolation_score,
    xgb_probability: b.xgb_probability,
    model_version: b.model_version.slice(0, 64),
    model_sha256: typeof b.model_sha256 === 'string' ? b.model_sha256.slice(0, 64) : null,
    decision: b.decision as RiskDecisionValue,
    triggered_layer: typeof b.triggered_layer === 'number' ? b.triggered_layer : null,
    layer2_adjudicated: typeof b.layer2_adjudicated === 'boolean' ? b.layer2_adjudicated : null,
    reason: typeof b.reason === 'string' ? b.reason : '',
    latency_ms: typeof b.latency_ms === 'number' ? b.latency_ms : 0,
    evaluated_at: typeof b.evaluated_at === 'string' ? b.evaluated_at : new Date().toISOString(),
    is_fail_safe: false,
    fail_safe_cause: null,
  };
}

/** The cause ml-engine put in its NFR-08 error body, if any. */
function errorCause(body: unknown, fallback: FailSafeCause): FailSafeCause {
  const cause = (body as Record<string, unknown> | null)?.fail_safe_cause;
  return typeof cause === 'string' && ML_CAUSES.has(cause) ? (cause as FailSafeCause) : fallback;
}

/** Validates a raw-mode request locally: JSON would turn NaN/Infinity into null, which ml-engine rejects. */
function isSendable(r: RiskEvaluationRequest): boolean {
  const rowOk = (row: RawTransaction) =>
    isId(row.agent_id) && isIso(row.timestamp) && isAmount(row.amount) && isId(row.counterparty_id);
  return (
    isId(r.transaction_id) &&
    !!r.transaction &&
    rowOk(r.transaction) &&
    Array.isArray(r.history) &&
    r.history.every((h) => rowOk(h) && isId(h.transaction_id) && h.agent_id === r.transaction.agent_id)
  );
}

const LATENCY_WINDOW = 200;

/**
 * ResilientRiskClient
 *
 * NFR-08 (Fail-Safe Circuit Breaker): CLOSED → OPEN → HALF_OPEN with a single probe.
 * Every non-success path returns QUARANTINE, never CLEAR.
 *
 * NFR-09 (Model Traceability): fail-safe responses carry a "-failsafe" model_version.
 */
export class ResilientRiskClient {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private totalTrips = 0;

  // Observability: ML latency is measured against the thesis's 500 ms budget.
  private calls = 0;
  private timeouts = 0;
  private latencies: number[] = [];

  private readonly FAILURE_THRESHOLD = 3;
  private readonly COOLING_PERIOD_MS = 30000;
  private readonly ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8001';
  private readonly ML_TIMEOUT_MS = parseInt(process.env.ML_TIMEOUT_MS || '500', 10);
  private readonly MODEL_VERSION = process.env.MODEL_VERSION || 'v1.0.0';

  /**
   * Evaluates a transaction's risk profile against the ML service (raw mode).
   *
   * @param request The risk evaluation request payload.
   * @returns The validated ML decision, or a QUARANTINE fail-safe.
   */
  public async evaluate(request: RiskEvaluationRequest): Promise<RiskEvaluationResponse> {
    if (!isSendable(request)) return this.failSafeDecision(request.transaction_id, 'invalid_request');

    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt < this.COOLING_PERIOD_MS) {
        return this.failSafeDecision(request.transaction_id, 'circuit_open');
      }
      this.state = 'HALF_OPEN';
    }
    const isProbe = this.state === 'HALF_OPEN';
    if (isProbe) {
      if (this.probeInFlight) return this.failSafeDecision(request.transaction_id, 'probe_in_flight');
      this.probeInFlight = true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ML_TIMEOUT_MS);
    const started = Date.now();
    this.calls += 1;
    try {
      const response = await fetch(`${this.ML_SERVICE_URL}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      // Always consume the body so undici returns the socket to the pool.
      const body: unknown = await response.json().catch(() => null);
      this.recordLatency(Date.now() - started);

      if (response.status >= 400 && response.status < 500) {
        // The service is up and rejected our request: a gateway bug, not an outage.
        this.onSuccess();
        console.error(`[RiskClient] ml-engine rejected ${request.transaction_id} with ${response.status}`);
        const fallback: FailSafeCause = response.status === 413 ? 'payload_too_large' : 'invalid_request';
        return this.failSafeDecision(request.transaction_id, errorCause(body, fallback));
      }
      if (!response.ok) {
        throw new Error(`ml-engine responded ${response.status}`, {
          cause: errorCause(body, response.status === 503 ? 'service_unavailable' : 'inference_error'),
        });
      }

      const decision = parseResponse(body, request.transaction_id);
      if (!decision) throw new Error('ml-engine response failed contract validation');
      this.onSuccess();
      return decision;
    } catch (error) {
      this.onFailure(isProbe);
      if (controller.signal.aborted) {
        this.timeouts += 1;
        this.recordLatency(Date.now() - started);
        return this.failSafeDecision(request.transaction_id, 'timeout');
      }
      const cause = field(error, 'cause');
      return this.failSafeDecision(
        request.transaction_id,
        cause === 'inference_error' || cause === 'service_unavailable' ? cause : 'service_unavailable'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Builds the safe fallback decision.
   * NFR-08: We NEVER default to CLEAR when the ML service cannot vouch for a transaction.
   * NFR-09: We append '-failsafe' to the model version for observability.
   */
  public failSafeDecision(transactionId: string, cause: FailSafeCause): RiskEvaluationResponse {
    return {
      transaction_id: transactionId,
      isolation_score: null,
      xgb_probability: null,
      model_version: `${this.MODEL_VERSION}-failsafe`,
      model_sha256: null,
      decision: 'QUARANTINE',
      triggered_layer: null,
      layer2_adjudicated: null,
      reason: `NFR-08 fail-safe: ${cause}`,
      latency_ms: 0,
      evaluated_at: new Date().toISOString(),
      is_fail_safe: true,
      fail_safe_cause: cause,
    };
  }

  /** False while OPEN and still cooling (a call would fail safe without trying). */
  public isAvailable(): boolean {
    if (this.state === 'OPEN') return Date.now() - this.openedAt >= this.COOLING_PERIOD_MS;
    if (this.state === 'HALF_OPEN') return !this.probeInFlight;
    return true;
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    this.probeInFlight = false;
  }

  private onFailure(isProbe: boolean): void {
    this.consecutiveFailures += 1;
    if (isProbe || this.consecutiveFailures >= this.FAILURE_THRESHOLD) {
      if (this.state !== 'OPEN') this.totalTrips += 1;
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.probeInFlight = false;
    }
  }

  /**
   * Exposes internal state for health checks and observability endpoints.
   */
  public getCircuitState() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalTrips: this.totalTrips,
    };
  }

  /** ML call metrics: timeout rate and latency percentiles over the last calls. */
  public getMetrics() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
    return {
      timeoutMs: this.ML_TIMEOUT_MS,
      calls: this.calls,
      timeouts: this.timeouts,
      timeoutRate: this.calls ? this.timeouts / this.calls : 0,
      latencyMs: { p50: pct(0.5), p95: pct(0.95), max: sorted.length ? sorted[sorted.length - 1] : null },
    };
  }
}

// Export singleton instance
export const resilientRiskClient = new ResilientRiskClient();
