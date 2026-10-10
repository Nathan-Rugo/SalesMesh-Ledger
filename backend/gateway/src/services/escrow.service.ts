/**
 * @file escrow.service.ts
 * @description Manages transaction recording, verification event logging, and
 * escrow hold creation within the SalesMesh-Ledger database.
 */

import pool from '../config/db';
import { withTransaction, type Db, type TxDb } from '../repositories/db.types';
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

/** Fixed holds for now; risk-adaptive T_hold is the next spec. */
export const CLEAR_HOLD_HOURS = 24;
export const QUARANTINE_HOLD_HOURS = 72;

export interface SettlementOptions {
  /** Run inside the caller's transaction instead of opening one. */
  client?: Db;
  /** A payload mutation was recorded for this receipt: quarantine, never self-heal. */
  securityHold?: boolean;
  historyTruncated?: boolean;
  /** Receipts actually sent to ml-engine (after trimming): lets a re-score replay them exactly. */
  historyReceipts?: string[];
}

/** NFR-08: only an explicit, model-made CLEAR is held normally. */
export const isModelClear = (r: RiskEvaluationResponse): boolean => r.decision === 'CLEAR' && !r.is_fail_safe;

export class EscrowService {
  constructor(private readonly db: TxDb = pool) {}

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
   * model digest, raw float scores (NULL on fail-safe) and the fail-safe cause. INITIAL is
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
    ];
    const columns = `(transaction_id, is_deduplicated, isolation_forest_score, xgboost_fraud_prob, model_version,
                      decision, layer2_adjudicated, model_sha256, triggered_layer, is_fail_safe, fail_safe_cause,
                      history_truncated, reason, history_receipts, kind)`;
    const select = `($1, TRUE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[]`;
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
   * Records the INITIAL verification outcome and the escrow hold atomically.
   * Ref: Data Dictionary Tables 6 (VERIFICATION_EVENTS) and 8 (ESCROW_ACCOUNTS)
   *
   * NFR-08: only an explicit, model-made CLEAR is held normally; REVIEW, QUARANTINE,
   * fail-safe and security-held decisions are quarantined. Re-running is a no-op.
   */
  public async processSettlement(
    transactionId: string,
    riskResponse: RiskEvaluationResponse,
    grossCommission: number | string,
    options: SettlementOptions = {}
  ): Promise<{ escrowStatus: 'HELD' | 'QUARANTINED'; created: boolean }> {
    const cleared = isModelClear(riskResponse) && !options.securityHold;
    const status = cleared ? 'HELD' : 'QUARANTINED';
    const holdHours = cleared ? CLEAR_HOLD_HOURS : QUARANTINE_HOLD_HOURS;
    const gross = typeof grossCommission === 'number' ? grossCommission.toFixed(2) : grossCommission;

    const run = async (db: Db) => {
      const verificationId = await this.insertVerificationEvent(
        db, transactionId, riskResponse, 'INITIAL', options.historyTruncated ?? false, options.historyReceipts ?? null
      );
      if (!verificationId) return { escrowStatus: status, created: false } as const; // already settled
      const { rows } = await db.query(
        `INSERT INTO escrow_accounts (transaction_id, gross_commission, hold_period_hours, escrow_status,
                                      security_hold, release_due_at)
         VALUES ($1, $2, $3::int, $4, $5, NOW() + make_interval(hours => $3::int))
         ON CONFLICT (transaction_id) DO NOTHING
         RETURNING escrow_id`,
        [transactionId, gross, holdHours, status, options.securityHold ?? false]
      );
      return { escrowStatus: status, created: rows.length > 0 } as const;
    };

    return options.client ? run(options.client) : withTransaction(this.db, run);
  }
}

// Export singleton instance
export const escrowService = new EscrowService();
export default escrowService;
