/**
 * @file escrow.service.ts
 * @description Manages transaction recording, verification event logging, and
 * escrow hold creation within the SalesMesh-Ledger database.
 */

import pool from '../config/db';
import { trustParams } from '../config/trust';
import { assess, QUARANTINE_HOLD_HOURS, type TrustAssessment, type TrustParams } from '../domain/trust';
import { withTransaction, type Db, type TxDb } from '../repositories/db.types';
import { enqueueCommit } from '../repositories/ledger.repository';
import { agentMaturity, insertTrustScore, lockAgentRating, medianSettledAmount, penaliseReceipt } from '../repositories/trust.repository';
import { RiskEvaluationResponse } from './risk_client.service';

export interface TransactionRecord {
  agent_id: string;
  mpesa_receipt_id: string;
  raw_payload_hash: string;
  amount: string | number; // DECIMAL(12,2); a string keeps cents exact
  source_channel: 'DARAJA_STK' | 'C2B' | 'POS';
  timestamp?: Date; // payment time (UTC)
  counterparty_hash: string;
  callback_id?: string | null;
}

export type VerificationKind = 'INITIAL' | 'RESCORE';

/** Every quarantine waits the standard 72 h; a model CLEAR waits the risk-adaptive T_hold (spec gh-23). */
export { QUARANTINE_HOLD_HOURS };

export type QuarantineReason = 'security_hold' | 'fail_safe' | 'model_decision' | 'trust_below_threshold' | 'trust_input_invalid';

export type EscrowStatus = 'HELD' | 'CLAIMED' | 'QUARANTINED' | 'RELEASED' | 'REMITTED';

export interface EscrowOutcome {
  status: 'HELD' | 'QUARANTINED';
  reason: QuarantineReason | null;
  holdSeconds: number;
}

/**
 * NFR-08 + spec gh-23: only a model-made CLEAR with a valid trust score above the freeze threshold
 * is HELD, for T_hold. Everything else is QUARANTINED for 72 h, with the reason.
 */
export function escrowOutcome(risk: RiskEvaluationResponse, securityHold: boolean, trust: TrustAssessment | null): EscrowOutcome {
  const q = (reason: QuarantineReason): EscrowOutcome => ({ status: 'QUARANTINED', reason, holdSeconds: QUARANTINE_HOLD_HOURS * 3600 });
  if (securityHold) return q('security_hold');
  if (risk.is_fail_safe) return q('fail_safe');
  if (risk.decision !== 'CLEAR') return q('model_decision');
  if (!trust) return q('trust_input_invalid');
  if (trust.frozen) return q('trust_below_threshold');
  return { status: 'HELD', reason: null, holdSeconds: trust.holdSeconds };
}

export interface SettlementOptions {
  /** Run inside the caller's transaction instead of opening one. */
  client?: Db;
  /** A payload mutation was recorded for this receipt: quarantine, never self-heal. */
  securityHold?: boolean;
  historyTruncated?: boolean;
  /** Receipts actually sent to ml-engine (after trimming): lets a re-score replay them exactly. */
  historyReceipts?: string[];
}

export class EscrowService {
  private params: TrustParams | undefined;

  constructor(private readonly db: TxDb = pool, params?: TrustParams) {
    this.params = params;
  }

  /** Read lazily: an invalid trust configuration is reported by preflight, not at import. */
  private get trust(): TrustParams {
    return (this.params ??= trustParams());
  }

  private async subject(db: Db, transactionId: string) {
    const { rows } = await db.query<{ agent_id: string; receipt: string; amount: string; ts: Date }>(
      `SELECT agent_id, mpesa_receipt_id AS receipt, amount::text AS amount, timestamp AS ts FROM transactions WHERE transaction_id = $1`,
      [transactionId]
    );
    const r = rows[0];
    return r ? { agentId: r.agent_id, receipt: r.receipt, amount: Number(r.amount), at: new Date(r.ts) } : null;
  }

  /**
   * Spec gh-23: locks the agent row (last, FOR NO KEY UPDATE), computes S_t / T_hold from the rating
   * read under that lock, and writes the trust row for this verification. null for a fail-safe (no p)
   * or invalid inputs: no S_t, the caller quarantines (fail closed).
   */
  public async scoreTrust(db: Db, transactionId: string, verificationId: string, risk: RiskEvaluationResponse): Promise<TrustAssessment | null> {
    if (risk.is_fail_safe || !risk.feature_vector) return null;
    const t = await this.subject(db, transactionId);
    if (!t) {
      console.error(`[Trust] transaction ${transactionId} not found; no trust score (failing closed)`);
      return null;
    }
    const rating = await lockAgentRating(db, t.agentId);
    if (rating === null) {
      console.error(`[Trust] agent ${t.agentId} of transaction ${transactionId} not found; no trust score (failing closed)`);
      return null;
    }
    const maturity = await agentMaturity(db, t.agentId);
    const median = await medianSettledAmount(db, { agentId: t.agentId, at: t.at, excludeReceipt: t.receipt, days: this.trust.medianDays });
    const assessment = assess({ risk, rating, maturity, amount: t.amount, median: median.median, settledCount: median.count }, this.trust);
    if (!assessment) {
      console.error(`[Trust] ${t.receipt}: trust inputs out of range (p/s/R); failing closed`);
      return null;
    }
    await insertTrustScore(db, { verificationId, agentId: t.agentId, assessment, features: risk.feature_vector }, this.trust);
    return assessment;
  }

  /**
   * Upserts the transaction (Data Dictionary Table 5) and returns its id — the existing one when
   * the receipt is already persisted. UNIQUE(mpesa_receipt_id) keeps settlement idempotent.
   */
  public async persistTransaction(params: TransactionRecord, db: Db = this.db): Promise<string> {
    const amount = typeof params.amount === 'number' ? params.amount.toFixed(2) : params.amount;
    const { rows } = await db.query<{ transaction_id: string }>(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel,
                                 timestamp, counterparty_hash, callback_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7, $8)
       ON CONFLICT (mpesa_receipt_id) DO NOTHING
       RETURNING transaction_id`,
      [
        params.agent_id,
        params.mpesa_receipt_id,
        params.raw_payload_hash,
        amount,
        params.source_channel,
        params.timestamp?.toISOString() ?? null,
        params.counterparty_hash,
        params.callback_id ?? null,
      ]
    );
    if (rows[0]?.transaction_id) return rows[0].transaction_id;
    const existing = await db.query<{ transaction_id: string }>(
      'SELECT transaction_id FROM transactions WHERE mpesa_receipt_id = $1',
      [params.mpesa_receipt_id]
    );
    if (!existing.rows[0]) throw new Error(`transaction ${params.mpesa_receipt_id} conflicted but is not visible`);
    return existing.rows[0].transaction_id;
  }

  /**
   * Appends a verification event (Table 6) with the full audit record: decision, layer-2 flag,
   * model digest, raw float scores (NULL on fail-safe), the fail-safe cause and the run's SHAP
   * attributions (spec gh-14; NULL on fail-safe). INITIAL is
   * idempotent per transaction (partial unique index); RESCOREs append.
   *
   * @returns the verification id, or null when the INITIAL event already exists.
   */
  public async insertVerificationEvent(
    db: Db,
    transactionId: string,
    risk: RiskEvaluationResponse,
    kind: VerificationKind,
    historyTruncated = false,
    historyReceipts: string[] | null = null
  ): Promise<string | null> {
    const values = [
      transactionId,
      risk.isolation_score,
      risk.xgb_probability,
      risk.model_version,
      risk.decision,
      risk.layer2_adjudicated,
      risk.model_sha256,
      risk.triggered_layer,
      risk.is_fail_safe,
      risk.fail_safe_cause,
      historyTruncated,
      risk.reason.slice(0, 1000),
      historyReceipts,
      risk.top_shap_features ? JSON.stringify(risk.top_shap_features) : null,
      risk.top_shap_features ? (risk.shap_units ?? null) : null,
    ];
    const columns = `(transaction_id, is_deduplicated, isolation_forest_score, xgboost_fraud_prob, model_version,
                      decision, layer2_adjudicated, model_sha256, triggered_layer, is_fail_safe, fail_safe_cause,
                      history_truncated, reason, history_receipts, shap_features, shap_units, kind)`;
    const select = `($1, TRUE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14::jsonb, $15`;
    const { rows } =
      kind === 'INITIAL'
        ? await db.query<{ verification_id: string }>(
            `INSERT INTO verification_events ${columns} VALUES ${select}, 'INITIAL')
             ON CONFLICT (transaction_id) WHERE kind = 'INITIAL' DO NOTHING
             RETURNING verification_id`,
            values
          )
        : await db.query<{ verification_id: string }>(
            `INSERT INTO verification_events ${columns} VALUES ${select}, 'RESCORE')
             RETURNING verification_id`,
            values
          );
    return rows[0]?.verification_id ?? null;
  }

  /**
   * Records the INITIAL verification outcome, the trust row and the escrow hold atomically.
   * Ref: Data Dictionary Tables 6 (VERIFICATION_EVENTS), 7 (TRUST_SCORES) and 8 (ESCROW_ACCOUNTS)
   *
   * NFR-08: only an explicit, model-made CLEAR above the trust freeze is HELD (for T_hold); REVIEW,
   * QUARANTINE, fail-safe, frozen and security-held decisions are quarantined. A security-held
   * receipt also penalises the agent (idempotent). Re-running is a no-op. A new escrow queues its
 * ledger CommitTransaction (DLT-03) in the same transaction.
   */
  public async processSettlement(
    transactionId: string,
    riskResponse: RiskEvaluationResponse,
    grossCommission: number | string,
    options: SettlementOptions = {}
  ): Promise<{ escrowStatus: EscrowStatus; created: boolean }> {
    const securityHold = options.securityHold ?? false;
    const gross = typeof grossCommission === 'number' ? grossCommission.toFixed(2) : grossCommission;

    // Already settled: report what was persisted, not what this run computed.
    const persisted = async (db: Db) => {
      const { rows } = await db.query<{ escrow_status: EscrowStatus }>('SELECT escrow_status FROM escrow_accounts WHERE transaction_id = $1', [transactionId]);
      return { escrowStatus: rows[0]?.escrow_status ?? 'QUARANTINED', created: false };
    };
    const run = async (db: Db): Promise<{ escrowStatus: EscrowStatus; created: boolean }> => {
      const verificationId = await this.insertVerificationEvent(
        db, transactionId, riskResponse, 'INITIAL', options.historyTruncated ?? false, options.historyReceipts ?? null
      );
      if (!verificationId) return persisted(db);
      const trust = await this.scoreTrust(db, transactionId, verificationId, riskResponse);
      const outcome = escrowOutcome(riskResponse, securityHold, trust);
      const { rows } = await db.query(
        `INSERT INTO escrow_accounts (transaction_id, gross_commission, hold_period_hours, escrow_status,
                                      security_hold, release_due_at, hold_seconds, quarantine_reason)
         VALUES ($1, $2, $3::int, $4, $5, NOW() + make_interval(secs => $6::int), $6::int, $7)
         ON CONFLICT (transaction_id) DO NOTHING
         RETURNING escrow_id`,
        [transactionId, gross, Math.ceil(outcome.holdSeconds / 3600), outcome.status, securityHold, outcome.holdSeconds, outcome.reason]
      );
      if (rows.length > 0) await enqueueCommit(db, rows[0].escrow_id); // DLT-03: the ledger COMMIT, same transaction
      if (securityHold) {
        const t = await this.subject(db, transactionId);
        if (t) await penaliseReceipt(db, t.receipt, this.trust);
      }
      return rows.length > 0 ? { escrowStatus: outcome.status, created: true } : persisted(db);
    };

    return options.client ? run(options.client) : withTransaction(this.db, run);
  }
}

// Export singleton instance
export const escrowService = new EscrowService();
export default escrowService;
