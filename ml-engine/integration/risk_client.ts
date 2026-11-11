/**
 * risk_client.ts
 * --------------
 * Production-ready Node.js / TypeScript integration client for SalesMesh Gateway.
 *
 * Implements:
 *   - HTTP POST /evaluate call to Python FastAPI microservice
 *   - Circuit breaker / timeout budget (default: 500ms)
 *   - NFR-08 Fail-Safe Default: Automatically defaults to QUARANTINE on network fault or timeout
 *   - NFR-09 Traceability: Passes model_version forward to Module 3 Hyperledger Fabric commit
 */

import axios, { AxiosInstance, AxiosError } from "axios";

export interface RiskFeatureVector {
  velocity_v_i: number;
  split_ratio_r_s: number;
  entropy_gaps: number;
  agent_zscore: number;
  amount_to_median_ratio: number;
  recipient_reuse_count: number;
}

export interface EvaluateRiskRequest {
  transaction_id: string;
  agent_id?: string;
  counterparty_id?: string;
  amount?: number;
  features: RiskFeatureVector;
  include_shap?: boolean;
  top_k_shap?: number;
}

export interface ShapFeature {
  feature: string;
  attribution: number;
  value: number;
}

export interface RiskDecisionResponse {
  transaction_id: string;
  isolation_score: number;
  xgb_probability: number;
  model_version: string;
  decision: "CLEAR" | "QUARANTINE" | "REVIEW";
  triggered_layer?: number | null;
  reason: string;
  top_shap_features: ShapFeature[];
  latency_ms: number;
  evaluated_at?: string;
  is_fail_safe_fallback?: boolean;
}

export class MLRiskEngineClient {
  private client: AxiosInstance;
  private readonly fallbackModelVersion: string;

  constructor(
    baseURL: string = process.env.ML_ENGINE_URL || "http://localhost:8000",
    timeoutMs: number = parseInt(process.env.ML_ENGINE_TIMEOUT_MS || "500", 10),
    fallbackModelVersion: string = "v1.1.0-failsafe"
  ) {
    this.fallbackModelVersion = fallbackModelVersion;
    this.client = axios.create({
      baseURL,
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    });
  }

  /**
   * Evaluates transaction risk.
   * If the ML service times out or errors, defaults strictly to QUARANTINE (NFR-08).
   */
  async evaluateTransaction(req: EvaluateRiskRequest): Promise<RiskDecisionResponse> {
    const startTime = Date.now();

    try {
      const response = await this.client.post<RiskDecisionResponse>("/evaluate", req);
      return response.data;
    } catch (err: unknown) {
      const elapsedMs = Date.now() - startTime;
      const error = err as AxiosError;

      const isTimeout = error.code === "ECONNABORTED" || error.message.includes("timeout");
      const errorMessage = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message || "Unknown error";

      console.warn(
        `[MLRiskEngineClient] Risk service failure for transaction ${req.transaction_id} ` +
        `after ${elapsedMs}ms: ${errorMessage}. Applying NFR-08 Fail-Safe: QUARANTINE.`
      );

      // NFR-08 Fail-Safe Default: NEVER default to CLEAR upon service timeout or downtime
      return {
        transaction_id: req.transaction_id,
        isolation_score: 1.0,
        xgb_probability: 1.0,
        model_version: this.fallbackModelVersion,
        decision: "QUARANTINE",
        triggered_layer: null,
        reason: isTimeout
          ? `Fail-safe default: ML microservice exceeded latency budget (${elapsedMs}ms > timeout)`
          : `Fail-safe default: ML microservice unreachable (${errorMessage})`,
        top_shap_features: [],
        latency_ms: elapsedMs,
        is_fail_safe_fallback: true,
      };
    }
  }

  /**
   * Health and readiness probe.
   */
  async checkHealth(): Promise<{ healthy: boolean; model_version?: string }> {
    try {
      const res = await this.client.get("/health", { timeout: 1000 });
      return {
        healthy: res.data.status === "healthy",
        model_version: res.data.model_version,
      };
    } catch {
      return { healthy: false };
    }
  }
}
