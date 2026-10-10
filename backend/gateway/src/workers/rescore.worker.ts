/**
 * @file rescore.worker.ts
 * @description Self-healing quarantine (NFR-08 outage recovery).
 *
 * Escrows QUARANTINED only because ml-engine could not vouch for them (latest verification
 * event fail-safe with a retryable cause) are re-scored once the breaker lets calls through
 * (not OPEN, so a half-open probe can happen). Each re-score:
 *   1. claims a lease (SKIP LOCKED, fresh rescore_claim_token) — no lock held across the ML call;
 *   2. rebuilds the same raw request (transaction + history as of the INITIAL evaluation);
 *   3. in ONE transaction, fenced on the token and re-checking eligibility: appends a RESCORE
 *      verification event and its trust row (agent locked last, current rating) and, for a
 *      model-made CLEAR above the trust freeze, promotes QUARANTINED → HELD (T_hold from now) with
 *      a status-guarded UPDATE. Anything else stays QUARANTINED; failures back off. A model-made
 *      outcome (REVIEW, QUARANTINE, frozen CLEAR) is no longer eligible for self-heal.
 * RELEASED, security-held and model-made quarantines are never touched.
 */

import pool from '../config/db';
import { rescoreWorkerConfig, type RescoreWorkerConfig } from '../config/worker';
import { buildRawRequest } from '../domain/risk_request';
import { Rollback, withTransaction, type TxDb } from '../repositories/db.types';
import {
  claimRescoreBatch,
  loadRescoreContext,
  lockRescoreLease,
  promoteToHeld,
  releaseRescoreLease,
  setQuarantineReason,
  type RescoreClaim,
} from '../repositories/escrow.repository';
import { fetchHistory } from '../repositories/transaction.repository';
import { EscrowService, escrowOutcome, escrowService } from '../services/escrow.service';
import { resilientRiskClient, type ResilientRiskClient } from '../services/risk_client.service';

export type RescoreOutcome = 'promoted' | 'still_quarantined' | 'deferred' | 'lease_lost';

export interface RescoreWorkerDeps {
  pool?: TxDb;
  riskClient?: Pick<ResilientRiskClient, 'evaluate' | 'isAvailable'>;
  escrow?: EscrowService;
  config?: Partial<RescoreWorkerConfig>;
}

export class RescoreWorker {
  private readonly pool: TxDb;
  private readonly risk: Pick<ResilientRiskClient, 'evaluate' | 'isAvailable'>;
  private readonly escrow: EscrowService;
  readonly config: RescoreWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  private running = false;

  constructor(deps: RescoreWorkerDeps = {}) {
    this.pool = deps.pool ?? pool;
    this.risk = deps.riskClient ?? resilientRiskClient;
    this.escrow = deps.escrow ?? (deps.pool ? new EscrowService(deps.pool) : escrowService);
    this.config = { ...rescoreWorkerConfig(), ...deps.config };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.current = this.runOnce()
        .catch((e) => console.error('[RescoreWorker] tick failed:', (e as Error).message))
        .finally(() => {
          this.current = null;
          if (this.running) this.timer = setTimeout(tick, this.config.intervalMs);
        });
    };
    this.timer = setTimeout(tick, this.config.intervalMs);
    console.info('[RescoreWorker] started');
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** Logged once: the claim that consumed the last attempt is the only one to see attempts == max. */
  private reportExhausted(claim: RescoreClaim): void {
    if (claim.rescore_attempts >= this.config.maxAttempts) {
      console.error(
        `[RescoreWorker] escrow ${claim.escrow_id} exhausted ${claim.rescore_attempts} re-score attempts; ` +
          'it stays QUARANTINED and needs an operator'
      );
    }
  }

  public async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([this.current, new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
      clearTimeout(t);
    }
  }

  /** One pass: returns the number of escrows claimed. Skips entirely while the breaker is OPEN. */
  public async runOnce(): Promise<number> {
    if (!this.risk.isAvailable()) return 0;
    const claims = await claimRescoreBatch(this.pool, this.config.batchSize, this.config.leaseMs, this.config.maxAttempts);
    for (const claim of claims) {
      try {
        await this.rescore(claim);
      } catch (error) {
        console.error(`[RescoreWorker] escrow ${claim.escrow_id} re-score failed:`, (error as Error).message);
        this.reportExhausted(claim);
        await releaseRescoreLease(this.pool, claim.escrow_id, claim.rescore_claim_token, this.config.backoffBaseMs).catch(
          () => undefined // the lease simply expires
        );
      }
    }
    return claims.length;
  }

  public async rescore(claim: RescoreClaim): Promise<RescoreOutcome> {
    const { escrow_id: escrowId, rescore_claim_token: token } = claim;
    if (!this.risk.isAvailable()) {
      await releaseRescoreLease(this.pool, escrowId, token, 0, true);
      return 'deferred';
    }
    const ctx = await loadRescoreContext(this.pool, claim.transaction_id);
    if (!ctx) throw new Error(`transaction ${claim.transaction_id} not found`);

    // Exact replay of the INITIAL request's history; legacy events fall back to the ingest cut.
    const history = await fetchHistory(this.pool, {
      agentId: ctx.agentId,
      at: ctx.timestamp,
      excludeReceipt: ctx.receipt,
      limit: ctx.historyReceipts ? Math.max(ctx.historyReceipts.length, this.config.historyLimit) : this.config.historyLimit,
      ...(ctx.historyReceipts ? { receipts: ctx.historyReceipts } : { asOfInitialOf: claim.transaction_id }),
    });
    const { request, truncated } = buildRawRequest({
      receipt: ctx.receipt,
      agentId: ctx.agentId,
      at: ctx.timestamp,
      amount: ctx.amount,
      counterpartyHash: ctx.counterpartyHash,
      history: history.rows,
      maxBodyBytes: this.config.mlMaxBodyBytes,
    });
    const risk = await this.risk.evaluate(request);

    // The breaker refused the call (opened mid-batch): not a real attempt, nothing to audit.
    if (risk.is_fail_safe && (risk.fail_safe_cause === 'circuit_open' || risk.fail_safe_cause === 'probe_in_flight')) {
      await releaseRescoreLease(this.pool, escrowId, token, 0, true);
      return 'deferred';
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        if (!(await lockRescoreLease(client, escrowId, token))) throw new Rollback('lease_lost');
        const verificationId = await this.escrow.insertVerificationEvent(client, claim.transaction_id, risk, 'RESCORE', history.truncated || truncated);
        const trust = verificationId ? await this.escrow.scoreTrust(client, claim.transaction_id, verificationId, risk) : null;
        const outcome = escrowOutcome(risk, false, trust);
        if (outcome.status === 'HELD') {
          if (!(await promoteToHeld(client, escrowId, token, outcome.holdSeconds))) throw new Error('guarded promote matched no row');
          console.info(`[RescoreWorker] escrow ${escrowId} (${ctx.receipt}) self-healed: QUARANTINED → HELD (${outcome.holdSeconds} s)`);
          return 'promoted' as const;
        }
        if (outcome.reason && outcome.reason !== 'fail_safe') await setQuarantineReason(client, escrowId, outcome.reason);
        const n = claim.rescore_attempts ?? 1;
        const delay = Math.min(this.config.backoffBaseMs * 2 ** Math.max(0, n - 1), this.config.backoffMaxMs);
        await releaseRescoreLease(client, escrowId, token, delay);
        this.reportExhausted(claim);
        return 'still_quarantined' as const;
      });
    } catch (error) {
      if (error instanceof Rollback) {
        console.warn(`[RescoreWorker] lease lost or escrow no longer eligible: ${escrowId}`);
        return 'lease_lost';
      }
      throw error;
    }
  }
}

export const rescoreWorker = new RescoreWorker();
