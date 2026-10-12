/**
 * @file settlement.worker.ts
 * @description Drains the durable intake queue (mpesa_callbacks) into settled transactions.
 *
 * Per callback: parse the stored (redacted) payload → resolve the agent (STK record — by
 * CheckoutRequestID, or for an UNKNOWN initiation by the fallback match on (payer-phone HMAC,
 * amount, time window) — or C2B agent_code) → load the agent's own 30-day history → score with ml-engine raw mode → in ONE
 * transaction (fenced on the claim token): bind the STK request, upsert the transaction, append
 * the INITIAL verification event, create the escrow hold, mark the callback SETTLED.
 *
 * Reconciliation (spec gh-6-recon): a RECONCILED row (synthesised from an M-Pesa statement) that
 * was bound to an STK request carries that request's id; it resolves by that id (never by a
 * fabricated CheckoutRequestID), and the settlement transaction re-checks the request's status and
 * consumption FOR UPDATE. Unbound RECONCILED rows are C2B-shaped and resolve by agent code.
 *
 * Every step is idempotent (ON CONFLICT everywhere), so a crash at any point is recovered by
 * reclaiming the row after the visibility timeout. Fail closed: anything not explicitly
 * model-CLEARed is QUARANTINED; unresolvable callbacks never create transactions.
 */

import type { PoolClient } from 'pg';
import pool from '../config/db';
import { assertPiiKey } from '../config/pii';
import { field, ownErrorCode, type JsonRecord } from '../domain/unknown';
import { settlementWorkerConfig, type SettlementWorkerConfig } from '../config/worker';
import { payoutDestinationService, payoutsEnabled, type PayoutDestinationService } from '../services/payout_destination.service';
import { payoutService, type PayoutService } from '../services/payout.service';
import { FrozenPayoutService, frozenPayoutService } from '../services/frozen.service';
import {
  CallbackParseError,
  extractIngress,
  centsToAmount,
  centsToDecimal,
  counterpartyHash,
  effectivePaymentTime,
  normaliseAgentCode,
  parseStoredCallback,
  type ParsedCallback,
} from '../domain/callback';
import { buildRawRequest } from '../domain/risk_request';
import { consumeStkRequest, findAgentByCode, findStkRequest, findStkRequestById } from '../repositories/agent.repository';
import {
  bindFallback,
  expireOpenRequests,
  expireStalePending,
  findFallbackCandidates,
  lockReconciledStk,
  RECONCILE_BINDABLE,
} from '../repositories/stk.repository';
import { purgeAuthData } from '../repositories/auth.repository';
import { paymentsConfig, STK_EXPIRE_AFTER_MS } from '../config/stk';
import { Rollback, withTransaction, type TxDb } from '../repositories/db.types';
import {
  claimBatch,
  findIntakeSummary,
  insertIntake,
  isChannelEcho,
  lockClaimed,
  markFailed,
  markRetry,
  markSettled,
  markUnresolved,
  sweepDead,
  type IntakeRow,
} from '../repositories/intake.repository';
import { hasSecurityHold, insertSecurityEvent, recordChannelEcho, recordPayloadMutation } from '../repositories/security.repository';
import { fetchHistory } from '../repositories/transaction.repository';
import { creditReceipt, findMaturedHolds } from '../repositories/trust.repository';
import { EscrowService, escrowService } from '../services/escrow.service';
import { resilientRiskClient, type ResilientRiskClient } from '../services/risk_client.service';
import { spoolService, type SpoolItem, type SpoolService } from '../services/spool.service';

export type Outcome = 'settled' | 'unresolved' | 'failed' | 'retry' | 'lease_lost';

/** The STK request a callback consumes; `fallback` is set when it must first be bound (UNKNOWN row). */
interface StkBinding {
  stkRequestId: string;
  fallback: { phoneHashes: string[]; amount: string; at: Date; checkoutRequestId: string } | null;
  /** RECONCILED row bound by id: re-check status and consumption FOR UPDATE before consuming. */
  recheck?: boolean;
}

/** The STK request id a RECONCILED intake row was bound to by the statement import, or null. */
export function reconciledStkRequestId(payload: unknown): string | null {
  const id = field(payload, 'Reconciliation', 'stkRequestId');
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

type Resolution =
  | { kind: 'resolved'; agentId: string; stk: StkBinding | null }
  | { kind: 'unresolved'; reason: string; terminal: boolean; replay?: boolean; statusConflictOf?: string };

export interface SettlementWorkerDeps {
  pool?: TxDb;
  riskClient?: Pick<ResilientRiskClient, 'evaluate'>;
  escrow?: EscrowService;
  spool?: Pick<SpoolService, 'peek' | 'remove'> | null;
  config?: Partial<SettlementWorkerConfig>;
  /** Payout-destination promotion / expiry sweep (spec gh-11); runs only while PAYOUTS_ENABLED=true. */
  payouts?: Pick<PayoutDestinationService, 'sweep'>;
  /** Payout Transaction Status recovery (spec gh-11, part 2); runs only while PAYOUTS_ENABLED=true. */
  payoutClaims?: Pick<PayoutService, 'sweep' | 'remindUnclaimed'>;
  /** Frozen-payout SLA escalation (spec gh-11, part 3c); runs whatever PAYOUTS_ENABLED says. */
  frozen?: Pick<FrozenPayoutService, 'escalate'>;
}

const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  ownErrorCode(e) === '23505' && (!constraint || field(e, 'constraint') === constraint);

export class SettlementWorker {
  private readonly pool: TxDb;
  private readonly risk: Pick<ResilientRiskClient, 'evaluate'>;
  private readonly escrow: EscrowService;
  private readonly spool: Pick<SpoolService, 'peek' | 'remove'> | null;
  readonly config: SettlementWorkerConfig;
  private readonly payouts: Pick<PayoutDestinationService, 'sweep'>;
  private readonly payoutClaims: Pick<PayoutService, 'sweep' | 'remindUnclaimed'>;
  private readonly frozen: Pick<FrozenPayoutService, 'escalate'>;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeRequested = false;
  private wakeSleep: (() => void) | null = null;
  private lastSweep = 0;

  constructor(deps: SettlementWorkerDeps = {}) {
    this.pool = deps.pool ?? pool;
    this.risk = deps.riskClient ?? resilientRiskClient;
    this.escrow = deps.escrow ?? (deps.pool ? new EscrowService(deps.pool) : escrowService);
    this.spool = deps.spool === undefined ? spoolService : deps.spool;
    this.payouts = deps.payouts ?? payoutDestinationService;
    this.payoutClaims = deps.payoutClaims ?? payoutService;
    this.frozen = deps.frozen ?? (deps.pool ? new FrozenPayoutService({ db: deps.pool }) : frozenPayoutService);
    this.config = { ...settlementWorkerConfig(), ...deps.config };
  }

  /** Starts the polling loop. Refuses to start without a valid PII_HMAC_KEY. */
  public start(): void {
    if (this.running) return;
    assertPiiKey();
    this.running = true;
    this.loopPromise = this.loop();
    console.info('[SettlementWorker] started');
  }

  /** Stops claiming new work and waits (up to timeoutMs) for the current batch to finish. */
  public async stop(timeoutMs = 10_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake();
    const loop = this.loopPromise;
    if (loop) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([loop, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    }
    console.info('[SettlementWorker] stopped');
  }

  /** Signals that new intake rows exist (called after each ACK). No-op when not running. */
  public wake(): void {
    this.wakeRequested = true;
    const resolve = this.wakeSleep;
    this.wakeSleep = null;
    resolve?.();
  }

  public isRunning(): boolean {
    return this.running;
  }

  private sleep(ms: number): Promise<void> {
    if (this.wakeRequested) {
      this.wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeRequested = false;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        await this.housekeeping();
        claimed = await this.runOnce();
      } catch (error) {
        console.error('[SettlementWorker] loop error:', (error as Error).message);
      }
      if (this.running && claimed === 0) await this.sleep(this.config.pollIntervalMs);
    }
  }

  /** Dead-row sweep, Redis spool drain and the other sweeps, at most once per sweep interval. */
  public async housekeeping(force = false): Promise<void> {
    if (!force && Date.now() - this.lastSweep < this.config.sweepIntervalMs) return;
    this.lastSweep = Date.now();
    const dead = await sweepDead(this.pool, this.config.visibilityTimeoutMs, this.config.maxAttempts);
    if (dead > 0) console.error(`[SettlementWorker] ${dead} intake row(s) moved to DEAD (lease expired, attempts exhausted)`);
    await this.drainSpool().catch((e) => console.error('[SettlementWorker] spool drain failed:', (e as Error).message));
    await this.stkAndAuthHousekeeping().catch((e) => console.error('[SettlementWorker] STK/auth housekeeping failed:', (e as Error).message));
    await this.creditMaturedHolds().catch((e) => console.error('[SettlementWorker] trust maturity sweep failed:', (e as Error).message));
    if (payoutsEnabled()) {
      await this.payouts.sweep().catch((e) => console.error('[SettlementWorker] payout-destination sweep failed:', (e as Error).message));
      await this.payoutClaims.sweep().catch((e) => console.error('[SettlementWorker] payout status sweep failed:', (e as Error).message));
      await this.payoutClaims.remindUnclaimed().catch((e) => console.error('[SettlementWorker] unclaimed reminder sweep failed:', (e as Error).message));
    }
    // Quarantines exist without payouts: the SLA sweep is outside the PAYOUTS_ENABLED gate.
    await this.frozen.escalate().catch((e) => console.error('[SettlementWorker] frozen-payout SLA sweep failed:', (e as Error).message));
  }

  /**
   * Spec gh-23: +β for each HELD escrow whose release_due_at passed with no security event on its
   * receipt (HOLD_MATURED_CLEAN), once per receipt, under the per-agent daily cap. Maturity only
   * feeds trust: nothing is released or paid here. Returns the number of credits applied.
   */
  public async creditMaturedHolds(limit = 100): Promise<number> {
    let credited = 0;
    for (const receipt of await findMaturedHolds(this.pool, limit)) {
      if ((await withTransaction(this.pool, (tx) => creditReceipt(tx, 'HOLD_MATURED_CLEAN', receipt))) !== null) credited += 1;
    }
    return credited;
  }

  /**
   * UNKNOWN / stale PENDING STK requests no callback can match any more (STK_TTL + 10 min) become
   * EXPIRED; refresh tokens expired/revoked > 30 days and auth_events (raw IPs) past their
   * retention (AUTH_EVENTS_RETENTION_DAYS, default 90) are purged.
   */
  public async stkAndAuthHousekeeping(): Promise<void> {
    const expired = await expireOpenRequests(this.pool, STK_EXPIRE_AFTER_MS);
    if (expired > 0) console.warn(`[SettlementWorker] ${expired} STK request(s) EXPIRED (no callback matched)`);
    const days = parseInt(process.env.AUTH_EVENTS_RETENTION_DAYS ?? '', 10);
    const purged = await purgeAuthData(this.pool, 30, Number.isFinite(days) && days > 0 ? days : 90);
    if (purged.tokens + purged.events > 0) {
      console.info(`[SettlementWorker] retention purge: ${purged.tokens} refresh token(s), ${purged.events} auth event(s)`);
    }
  }

  /** Claims one batch and processes it; returns the number of rows claimed. */
  public async runOnce(): Promise<number> {
    const rows = await claimBatch(this.pool, this.config.batchSize, this.config.visibilityTimeoutMs, this.config.maxAttempts);
    // UPDATE … RETURNING does not preserve the subquery's ORDER BY: settle first-in first-out, so
    // order-dependent effects (trust penalties before a later payment's hold) follow arrival order.
    rows.sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime());
    for (const row of rows) {
      await this.process(row);
    }
    return rows.length;
  }

  /** Processes one claimed intake row to a fenced outcome. */
  public async process(row: IntakeRow): Promise<Outcome> {
    const { mpesa_receipt_id: receipt } = row;
    let parsed: ParsedCallback;
    try {
      parsed = parseStoredCallback(row.payload);
      if (parsed.receipt !== receipt) throw new CallbackParseError('payload receipt differs from the intake receipt');
    } catch (error) {
      // Parse/validation errors are terminal immediately: retrying cannot fix them.
      const msg = `invalid: ${(error as Error).message}`;
      console.error(`[SettlementWorker] ${receipt} ${msg}`);
      try {
        return (await markFailed(this.pool, row.callback_id, row.claim_token, msg)) ? 'failed' : 'lease_lost';
      } catch (writeError) {
        // DB unreachable: the lease expires and the row is reclaimed (or swept DEAD).
        console.error(`[SettlementWorker] could not record failure for ${receipt}:`, (writeError as Error).message);
        return 'retry';
      }
    }

    try {
      const resolution =
        row.origin === 'RECONCILED' && (parsed.channel === 'DARAJA_STK' || reconciledStkRequestId(row.payload))
          ? await this.resolveReconciled(parsed, reconciledStkRequestId(row.payload))
          : await this.resolveAgent(parsed, new Date(row.received_at));
      if (resolution.kind === 'unresolved') return await this.unresolved(row, resolution);

      const at = effectivePaymentTime(parsed.paymentTime, new Date(row.received_at));
      const counterparty = counterpartyHash(parsed);
      const history = await fetchHistory(this.pool, {
        agentId: resolution.agentId,
        at,
        excludeReceipt: receipt,
        limit: this.config.historyLimit,
      });
      const { request, truncated } = buildRawRequest({
        receipt,
        agentId: resolution.agentId,
        at,
        amount: centsToAmount(parsed.amountCents),
        counterpartyHash: counterparty,
        history: history.rows,
        maxBodyBytes: this.config.mlMaxBodyBytes,
      });
      const risk = await this.risk.evaluate(request);
      const grossCents = Math.round((parsed.amountCents * this.config.commissionRateBps) / 10_000);

      try {
        const settled = await withTransaction(this.pool, async (client: PoolClient) => {
          if (!(await lockClaimed(client, row.callback_id, row.claim_token))) throw new Rollback('lease_lost');
          const stk = resolution.stk;
          if (stk?.recheck) {
            const state = await lockReconciledStk(client, stk.stkRequestId, receipt);
            if (state === 'replay') throw new Rollback('stk_receipt_replay');
            if (state !== 'ok') throw new Rollback('stk_status_changed');
          }
          if (stk) {
            // Fallback: re-select FOR UPDATE, re-count, bind only if still exactly this UNKNOWN row.
            if (stk.fallback && !(await bindFallback(client, { ...stk.fallback, stkRequestId: stk.stkRequestId }))) {
              throw new Rollback('stk_fallback_contended');
            }
            if (!(await consumeStkRequest(client, stk.stkRequestId, receipt))) throw new Rollback('stk_receipt_replay');
          }
          const securityHold = await hasSecurityHold(client, receipt);
          const transactionId = await this.escrow.persistTransaction(
            {
              agent_id: resolution.agentId,
              mpesa_receipt_id: receipt,
              raw_payload_hash: row.raw_payload_hash,
              amount: centsToDecimal(parsed.amountCents),
              source_channel: parsed.channel,
              timestamp: at,
              counterparty_hash: counterparty,
              callback_id: row.callback_id,
            },
            client
          );
          const result = await this.escrow.processSettlement(transactionId, risk, centsToDecimal(grossCents), {
            client,
            securityHold,
            historyTruncated: history.truncated || truncated,
            historyReceipts: request.history.map((h) => h.transaction_id),
          });
          if (!(await markSettled(client, row.callback_id, row.claim_token, transactionId))) {
            throw new Error('claim fence lost while holding the row lock');
          }
          return { transactionId, ...result };
        });
        console.info(
          `[Settlement] OK — receipt=${receipt} tx=${settled.transactionId} decision=${risk.decision}` +
            ` escrow=${settled.escrowStatus}${risk.is_fail_safe ? ` failsafe=${risk.fail_safe_cause}` : ''}`
        );
        return 'settled';
      } catch (error) {
        if (error instanceof Rollback && error.value === 'lease_lost') {
          console.warn(`[SettlementWorker] lease lost for ${receipt}; another worker owns it`);
          return 'lease_lost';
        }
        if ((error instanceof Rollback && error.value === 'stk_receipt_replay') || isUniqueViolation(error, 'stk_requests_consumed_receipt_key')) {
          return await this.unresolved(row, { kind: 'unresolved', reason: 'stk_receipt_replay', terminal: true, replay: true });
        }
        if (error instanceof Rollback && error.value === 'stk_status_changed') {
          return await this.unresolved(row, { kind: 'unresolved', reason: 'stk_status_conflict_reconciled', terminal: true, statusConflictOf: resolution.stk?.stkRequestId });
        }
        if ((error instanceof Rollback && error.value === 'stk_fallback_contended') || isUniqueViolation(error, 'stk_requests_checkout_request_id_key')) {
          // The candidate set changed under us: resolve afresh on the next attempt (fail closed now).
          return await this.unresolved(row, { kind: 'unresolved', reason: 'stk_fallback_contended', terminal: false });
        }
        throw error;
      }
    } catch (error) {
      return this.transientFailure(row, error as Error);
    }
  }

  private async resolveAgent(parsed: ParsedCallback, receivedAt: Date): Promise<Resolution> {
    if (parsed.channel === 'DARAJA_STK') {
      if (!parsed.checkoutRequestId) return { kind: 'unresolved', reason: 'stk_missing_checkout_request_id', terminal: true };
      const stk = await findStkRequest(this.pool, parsed.checkoutRequestId);
      if (stk) {
        if (stk.amountCents !== parsed.amountCents) return { kind: 'unresolved', reason: 'stk_amount_mismatch', terminal: true };
        if (stk.consumedReceipt && stk.consumedReceipt !== parsed.receipt) {
          return { kind: 'unresolved', reason: 'stk_receipt_replay', terminal: true, replay: true };
        }
        // A paid callback for a request recorded as rejected/failed is contradictory: review it.
        if (stk.status === 'REJECTED' || stk.status === 'FAILED') {
          return { kind: 'unresolved', reason: `stk_status_conflict_${stk.status.toLowerCase()}`, terminal: true, statusConflictOf: stk.stkRequestId };
        }
        return { kind: 'resolved', agentId: stk.agentId, stk: { stkRequestId: stk.stkRequestId, fallback: null } };
      }
      return this.fallbackMatch(parsed, receivedAt);
    }
    const code = normaliseAgentCode(parsed.billRefNumber);
    if (!code) return { kind: 'unresolved', reason: 'c2b_missing_agent_code', terminal: true };
    const agentId = await findAgentByCode(this.pool, code);
    if (!agentId) return { kind: 'unresolved', reason: 'c2b_unknown_agent_code', terminal: false };
    return { kind: 'resolved', agentId, stk: null };
  }

  /**
   * A statement-recovered STK payment: resolved by the STK request id the import bound it to.
   * A FAILED / REJECTED request is a status conflict (review, never C2B-shaped).
   */
  private async resolveReconciled(parsed: ParsedCallback, stkRequestId: string | null): Promise<Resolution> {
    if (!stkRequestId) return { kind: 'unresolved', reason: 'reconciled_stk_without_request', terminal: true };
    const stk = await findStkRequestById(this.pool, stkRequestId);
    if (!stk) return { kind: 'unresolved', reason: 'reconciled_stk_request_missing', terminal: true };
    if (stk.amountCents !== parsed.amountCents) return { kind: 'unresolved', reason: 'stk_amount_mismatch', terminal: true };
    if (stk.consumedReceipt && stk.consumedReceipt !== parsed.receipt) {
      return { kind: 'unresolved', reason: 'stk_receipt_replay', terminal: true, replay: true };
    }
    if (!RECONCILE_BINDABLE.includes(stk.status)) {
      return { kind: 'unresolved', reason: `stk_status_conflict_${stk.status.toLowerCase()}`, terminal: true, statusConflictOf: stk.stkRequestId };
    }
    return { kind: 'resolved', agentId: stk.agentId, stk: { stkRequestId: stk.stkRequestId, fallback: null, recheck: true } };
  }

  /**
   * CheckoutRequestID not on file: the initiation's Daraja response may have been lost (UNKNOWN).
   * Match exactly one UNKNOWN request on (payer-phone HMAC — under any configured PII key —,
   * amount, created within STK_TTL before the payment time). A PENDING candidate means its Daraja
   * call may still answer: retry. No phone (masked/missing) → no fallback. More than one → review.
   */
  private async fallbackMatch(parsed: ParsedCallback, receivedAt: Date): Promise<Resolution> {
    const unknownId: Resolution = { kind: 'unresolved', reason: 'stk_unknown_checkout_request_id', terminal: false };
    if (!parsed.counterpartyHash) return unknownId;
    const phoneHashes = [parsed.counterpartyHash, ...parsed.counterpartyAltHashes];
    const at = effectivePaymentTime(parsed.paymentTime, receivedAt);
    const amount = centsToDecimal(parsed.amountCents);
    let candidates = await findFallbackCandidates(this.pool, { phoneHashes, amount, at });
    const pending = candidates.filter((c) => c.status === 'PENDING');
    if (pending.length > 0) {
      // A PENDING row whose Daraja call cannot still be running (overall deadline + 10 s) is UNKNOWN by now.
      const staleMs = paymentsConfig().stalePendingMs;
      let expired = 0;
      for (const c of pending) if (await expireStalePending(this.pool, c.stkRequestId, staleMs)) expired += 1;
      if (expired > 0) candidates = await findFallbackCandidates(this.pool, { phoneHashes, amount, at });
    }
    if (candidates.some((c) => c.status === 'PENDING')) return { kind: 'unresolved', reason: 'stk_fallback_pending', terminal: false };
    if (candidates.length > 1) return { kind: 'unresolved', reason: 'stk_fallback_ambiguous', terminal: true };
    if (candidates.length === 0) return unknownId;
    const [c] = candidates;
    console.info(`[SettlementWorker] ${parsed.receipt}: CheckoutRequestID unknown; fallback-matched an UNKNOWN STK request`);
    return {
      kind: 'resolved',
      agentId: c.agentId,
      stk: { stkRequestId: c.stkRequestId, fallback: { phoneHashes, amount, at, checkoutRequestId: parsed.checkoutRequestId! } },
    };
  }

  private async unresolved(row: IntakeRow, r: Extract<Resolution, { kind: 'unresolved' }>): Promise<Outcome> {
    if (r.statusConflictOf) {
      // A paid payment for a request recorded FAILED / REJECTED (e.g. by the STK Query sweep): alarm, one per request.
      await insertSecurityEvent(this.pool, {
        type: 'STK_STATUS_CONFLICT',
        receipt: row.mpesa_receipt_id,
        originalHash: null,
        incomingHash: row.raw_payload_hash,
        detail: `payment for an STK request recorded ${r.reason.replace('stk_status_conflict_', '').toUpperCase()}`,
        stkRequestId: r.statusConflictOf,
      });
    }
    if (r.replay) {
      console.error(`[SECURITY ALARM] STK request already consumed by another receipt; ${row.mpesa_receipt_id} held UNRESOLVED`);
      await insertSecurityEvent(this.pool, {
        type: 'STK_RECEIPT_REPLAY',
        receipt: row.mpesa_receipt_id,
        originalHash: null,
        incomingHash: row.raw_payload_hash,
        detail: 'second receipt for an already-consumed STK request',
      });
    }
    const res = await markUnresolved(this.pool, row.callback_id, row.claim_token, `unresolved: ${r.reason}`, {
      terminal: r.terminal,
      windowMs: this.config.unresolvedWindowMs,
      baseDelayMs: this.config.unresolvedBaseDelayMs,
      maxDelayMs: this.config.unresolvedMaxDelayMs,
    });
    if (!res.updated) return 'lease_lost';
    console.warn(`[SettlementWorker] ${row.mpesa_receipt_id} UNRESOLVED (${r.reason})${res.terminal ? ' — awaiting review' : ' — will retry'}`);
    return 'unresolved';
  }

  private async transientFailure(row: IntakeRow, error: Error): Promise<Outcome> {
    const msg = `${error.name}: ${error.message}`;
    try {
      if (row.attempts >= this.config.maxAttempts) {
        console.error(`[SettlementWorker] ${row.mpesa_receipt_id} FAILED after ${row.attempts} attempts: ${msg}`);
        return (await markFailed(this.pool, row.callback_id, row.claim_token, msg)) ? 'failed' : 'lease_lost';
      }
      const delay = Math.min(this.config.backoffBaseMs * 2 ** Math.max(0, row.attempts - 1), this.config.backoffMaxMs);
      console.warn(`[SettlementWorker] ${row.mpesa_receipt_id} attempt ${row.attempts} failed (${msg}); retry in ${delay} ms`);
      return (await markRetry(this.pool, row.callback_id, row.claim_token, delay, msg)) ? 'retry' : 'lease_lost';
    } catch (writeError) {
      // DB unreachable: the lease expires and the row is reclaimed (or swept DEAD).
      console.error(`[SettlementWorker] could not record failure for ${row.mpesa_receipt_id}:`, (writeError as Error).message);
      return 'retry';
    }
  }

  /**
   * Moves Redis-spooled intake payloads (Postgres was down at ACK time) into mpesa_callbacks.
   * An entry that can never be inserted (bad shape, SQLSTATE class 22/23) is parked — removed and
   * logged without payload — so it cannot block the drain; any other error stops this pass.
   */
  public async drainSpool(): Promise<number> {
    if (!this.spool) return 0;
    let moved = 0;
    const park = async (raw: string, why: string) => {
      console.error(`[SettlementWorker] parking unusable spool entry (${why}); removed from the spool`);
      await this.spool!.remove(raw);
    };
    for (const raw of await this.spool.peek(this.config.spoolDrainBatch)) {
      let item: SpoolItem;
      try {
        item = JSON.parse(raw);
        const problem = invalidSpoolItem(item);
        if (problem) throw new Error(problem);
      } catch (error) {
        await park(raw, (error as Error).message);
        continue;
      }
      try {
        const res = await insertIntake(this.pool, {
          receipt: item.receipt,
          hash: item.hash,
          channel: item.channel,
          payload: item.payload,
          receivedAt: new Date(item.receivedAt),
        });
        if (res.outcome === 'existing' && res.storedHash !== item.hash) {
          const sameKey = res.storedHash.split(':')[0] === item.hash.split(':')[0];
          const incoming = extractIngress(item.payload);
          const stored = incoming.kind === 'ok' ? await findIntakeSummary(this.pool, item.receipt) : null;
          if (incoming.kind === 'ok' && isChannelEcho(stored, { channel: item.channel, amountCents: incoming.amountCents })) {
            console.warn(`[SettlementWorker] spooled ${item.receipt} is a cross-channel echo of a stored intake row; recorded, not settled`);
            await recordChannelEcho(this.pool, item.receipt, res.storedHash, item.hash, `spooled ${item.channel} echo`);
          } else if (sameKey) {
            console.error(`[SECURITY ALARM] Payload mutation on receipt ${item.receipt} (spool)`);
            await recordPayloadMutation(this.pool, item.receipt, res.storedHash, item.hash);
          } else {
            console.warn(`[SettlementWorker] spool entry for ${item.receipt} hashed under another key; not compared`);
          }
        }
      } catch (error) {
        const code = ownErrorCode(error);
        if (code.startsWith('22') || code.startsWith('23')) {
          await park(raw, `receipt ${item.receipt}: SQLSTATE ${code}`);
          continue;
        }
        throw error; // DB unavailable etc.: keep the entry, retry on the next sweep
      }
      await this.spool.remove(raw);
      moved += 1;
    }
    if (moved > 0) this.wake();
    return moved;
  }
}

const SPOOL_CHANNELS: ReadonlySet<string> = new Set(['DARAJA_STK', 'C2B']);

/** Why a spool entry cannot be inserted, or null when it is well-formed. */
export function invalidSpoolItem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not an object';
  const item = value as JsonRecord;
  if (typeof item.receipt !== 'string' || !item.receipt) return 'missing receipt';
  if (typeof item.hash !== 'string' || !item.hash) return 'missing hash';
  if (typeof item.channel !== 'string' || !SPOOL_CHANNELS.has(item.channel)) return 'unknown channel';
  if (!item.payload || typeof item.payload !== 'object') return 'payload is not an object';
  if (typeof item.receivedAt !== 'string' || !Number.isFinite(Date.parse(item.receivedAt))) return 'invalid receivedAt';
  return null;
}

/** Process-wide worker; the HTTP hot path wakes it after each durable intake insert. */
export const settlementWorker = new SettlementWorker();
