/**
 * @file reconcile.worker.ts
 * @description STK Query reconciliation sweep (spec gh-6-recon): closes the "state limbo" of
 * ACCEPTED STK requests whose callback never arrived.
 *
 * Each tick:
 *   1. leases that expired with their attempts exhausted (a crashed sweeper) → RECONCILE_EXHAUSTED;
 *   2. claims overdue ACCEPTED requests (STK_TTL + grace, newer than RECONCILE_MAX_AGE, no intake
 *      row carrying their CheckoutRequestID) under SKIP LOCKED with a fenced lease;
 *   3. per claim, rate-limited (RECONCILE_QPS): re-checks that no callback won the race, asks the
 *      Daraja STK Push Query, and records the outcome fenced on the lease:
 *        PAID    → PAID_UNCONFIRMED (the statement import later supplies the receipt);
 *        FAILED  → FAILED with the result code;
 *        PENDING / UNKNOWN → retried with exponential backoff; when the attempt cap is reached →
 *                  RECONCILE_EXHAUSTED. Never FAILED on an ambiguous answer.
 *      Throttling (and Daraja being unreachable) gives the attempt back and ends the tick early;
 *      the remaining claims are released for a later tick.
 * Nothing here ever creates a payment: a paid-but-silent request only becomes a precise,
 * queryable register entry until the statement import supplies the receipt.
 */

import pool from '../config/db';
import { overdueAfterMs, reconcileSweepConfig, type ReconcileSweepConfig } from '../config/reconcile';
import { darajaClient, type DarajaClient, type StkQueryOutcome } from '../daraja/client';
import * as defaultRepo from '../repositories/reconcile.repository';
import type { ReconcileClaim } from '../repositories/reconcile.repository';
import type { Db } from '../repositories/db.types';

export type SweepOutcome = 'paid' | 'failed' | 'retry' | 'throttled' | 'exhausted' | 'skipped' | 'deferred' | 'lease_lost';

export type ReconcileRepo = Pick<
  typeof defaultRepo,
  | 'claimReconcileBatch'
  | 'intakeExistsForRequest'
  | 'markPaidUnconfirmed'
  | 'markQueryFailed'
  | 'releaseReconcileLease'
  | 'sweepExhaustedLeases'
>;

export interface ReconcileWorkerDeps {
  pool?: Db;
  daraja?: Pick<DarajaClient, 'stkQuery'>;
  repo?: ReconcileRepo;
  config?: Partial<ReconcileSweepConfig>;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Evidence kept on the request: codes and Daraja's description only (never PII). */
function evidence(o: StkQueryOutcome): string {
  const base = { at: new Date().toISOString(), kind: o.kind };
  if (o.kind === 'PAID' || o.kind === 'FAILED') return JSON.stringify({ ...base, resultCode: o.resultCode, resultDesc: o.resultDesc.slice(0, 200) });
  return JSON.stringify({ ...base, code: o.code, message: o.message.slice(0, 200) });
}

export class ReconcileWorker {
  private readonly pool: Db;
  private readonly daraja: Pick<DarajaClient, 'stkQuery'>;
  private readonly repo: ReconcileRepo;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly config: ReconcileSweepConfig;

  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  private running = false;
  /** stop() was called: the claims still in hand are given back instead of queried. */
  private stopRequested = false;
  private lastQueryAt = 0;
  lastSweepAt: Date | null = null;
  readonly counters: Record<SweepOutcome, number> = {
    paid: 0,
    failed: 0,
    retry: 0,
    throttled: 0,
    exhausted: 0,
    skipped: 0,
    deferred: 0,
    lease_lost: 0,
  };

  constructor(deps: ReconcileWorkerDeps = {}) {
    this.pool = deps.pool ?? pool;
    this.daraja = deps.daraja ?? darajaClient;
    this.repo = deps.repo ?? defaultRepo;
    this.sleep = deps.sleep ?? realSleep;
    this.config = { ...reconcileSweepConfig(), ...deps.config };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    const tick = () => {
      if (!this.running) return;
      this.current = this.runOnce()
        .catch((e) => console.error('[ReconcileWorker] tick failed:', (e as Error).message))
        .finally(() => {
          this.current = null;
          if (this.running) {
            this.timer = setTimeout(tick, this.config.intervalMs);
            this.timer.unref?.();
          }
        });
    };
    this.timer = setTimeout(tick, Math.min(this.config.intervalMs, 5_000));
    this.timer.unref?.();
    console.info('[ReconcileWorker] started');
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([this.current, new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
      clearTimeout(t);
    }
  }

  private backoff(attempts: number): number {
    return Math.min(this.config.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.config.backoffMaxMs);
  }

  /** RECONCILE_QPS: at most `qps` STK Queries per second from this process. */
  private async rateLimit(): Promise<void> {
    const gap = 1000 / this.config.qps;
    const wait = this.lastQueryAt + gap - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastQueryAt = Date.now();
  }

  /** One sweep: returns the outcome of every claim (in claim order). */
  public async runOnce(): Promise<SweepOutcome[]> {
    const cfg = this.config;
    const exhausted = await this.repo.sweepExhaustedLeases(this.pool, cfg.leaseMs, cfg.maxAttempts);
    if (exhausted > 0) {
      this.counters.exhausted += exhausted;
      console.warn(`[ReconcileWorker] ${exhausted} STK request(s) RECONCILE_EXHAUSTED (lease expired with attempts used up)`);
    }
    const claims = await this.repo.claimReconcileBatch(this.pool, {
      limit: cfg.batchSize,
      overdueMs: overdueAfterMs(cfg),
      maxAgeMs: cfg.maxAgeMs,
      maxAttempts: cfg.maxAttempts,
      leaseMs: cfg.leaseMs,
    });
    const outcomes: SweepOutcome[] = [];
    let stopEarly = false;
    for (const claim of claims) {
      let outcome: SweepOutcome;
      try {
        outcome = stopEarly || this.stopRequested ? await this.defer(claim) : await this.reconcile(claim);
      } catch (error) {
        console.error('[ReconcileWorker] reconcile step failed:', (error as Error).message);
        await this.repo.releaseReconcileLease(this.pool, claim, { delayMs: this.backoff(claim.attempts) }).catch(() => undefined);
        outcome = 'retry';
      }
      if (outcome === 'throttled' || outcome === 'deferred') stopEarly = true;
      this.counters[outcome] += 1;
      outcomes.push(outcome);
    }
    this.lastSweepAt = new Date();
    if (claims.length > 0) {
      const summary = Object.entries(outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o]: (m[o] ?? 0) + 1 }), {}))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.info(`[ReconcileWorker] swept ${claims.length} overdue STK request(s): ${summary}`);
    }
    return outcomes;
  }

  /** Gives the claim back untouched (attempt refunded): Daraja is throttling us or unreachable. */
  private async defer(claim: ReconcileClaim): Promise<SweepOutcome> {
    await this.repo.releaseReconcileLease(this.pool, claim, { delayMs: this.config.backoffBaseMs, refund: true });
    return 'deferred';
  }

  public async reconcile(claim: ReconcileClaim): Promise<SweepOutcome> {
    // The callback may have arrived since the claim: nothing to do, nothing changes.
    if (await this.repo.intakeExistsForRequest(this.pool, claim)) {
      await this.repo.releaseReconcileLease(this.pool, claim, { delayMs: 0, refund: true });
      return 'skipped';
    }
    await this.rateLimit();
    const o = await this.daraja.stkQuery(claim.checkoutRequestId);
    const ev = evidence(o);
    switch (o.kind) {
      case 'PAID':
        if (!(await this.repo.markPaidUnconfirmed(this.pool, claim, ev))) return 'lease_lost';
        console.warn(`[ReconcileWorker] STK request ${claim.stkRequestId} was paid but its callback is missing: PAID_UNCONFIRMED`);
        return 'paid';
      case 'FAILED':
        if (!(await this.repo.markQueryFailed(this.pool, claim, o.resultCode, o.resultDesc, ev))) return 'lease_lost';
        return 'failed';
      case 'PENDING':
        if (o.throttled) {
          await this.repo.releaseReconcileLease(this.pool, claim, { delayMs: this.backoff(claim.attempts), refund: true, evidence: ev, queried: true });
          console.warn(`[ReconcileWorker] Daraja is throttling STK Queries (${o.code}); backing off`);
          return 'throttled';
        }
        return this.retry(claim, ev);
      default:
        if (o.unreachable) {
          // Daraja down: not this request's fault; retry later without consuming an attempt.
          await this.repo.releaseReconcileLease(this.pool, claim, { delayMs: this.config.backoffBaseMs, refund: true, evidence: ev });
          console.warn(`[ReconcileWorker] Daraja unreachable for STK Query (${o.code}); deferring the batch`);
          return 'deferred';
        }
        return this.retry(claim, ev);
    }
  }

  private async retry(claim: ReconcileClaim, ev: string): Promise<SweepOutcome> {
    const exhaust = claim.attempts >= this.config.maxAttempts;
    const ok = await this.repo.releaseReconcileLease(this.pool, claim, {
      delayMs: this.backoff(claim.attempts),
      exhaust,
      evidence: ev,
      queried: true,
    });
    if (!ok) return 'lease_lost';
    if (exhaust) console.error(`[ReconcileWorker] STK request ${claim.stkRequestId} RECONCILE_EXHAUSTED after ${claim.attempts} queries`);
    return exhaust ? 'exhausted' : 'retry';
  }

}

export const reconcileWorker = new ReconcileWorker();
