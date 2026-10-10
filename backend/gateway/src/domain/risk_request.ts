/**
 * @file risk_request.ts
 * @description Builds the ml-engine raw-mode request (transaction + the agent's own history).
 */

import type { HistoryRow, RiskEvaluationRequest } from '../services/risk_client.service';

export interface RawRequestInput {
  receipt: string;
  agentId: string;
  at: Date;
  amount: number;
  counterpartyHash: string;
  /** Most recent first, as returned by fetchHistory. */
  history: HistoryRow[];
  maxBodyBytes: number;
}

/**
 * Raw-mode request. If the body would exceed ml-engine's limit the OLDEST rows are dropped
 * (history arrives most-recent-first) and `truncated` is reported for the audit record.
 */
export function buildRawRequest(input: RawRequestInput): { request: RiskEvaluationRequest; truncated: boolean } {
  let history = input.history;
  let truncated = false;
  const make = (rows: HistoryRow[]): RiskEvaluationRequest => ({
    transaction_id: input.receipt,
    transaction: {
      agent_id: input.agentId,
      timestamp: input.at.toISOString(),
      amount: input.amount,
      counterparty_id: input.counterpartyHash,
    },
    history: rows,
  });
  let request = make(history);
  while (history.length > 0 && Buffer.byteLength(JSON.stringify(request)) > input.maxBodyBytes) {
    history = history.slice(0, Math.floor(history.length * 0.9));
    truncated = true;
    request = make(history);
  }
  return { request, truncated };
}
