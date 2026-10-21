/**
 * @file ledger.worker.ts
 * @description Drains the ledger outbox to the commission chaincode (DLT-03, #10). Per tick, while
 * FABRIC_ENABLED=true:
 *   1. leases due rows (ordered per key) and submits each one's stored request, unchanged:
 *      committed → DELIVERED with its tx id and block number; a #9 code → DEAD (keys stay blocked,
 *      logged, counted), except LOCKED_BY_AUDITOR on a Quarantine / Release (or a Quarantine no-op
 *      answered with lockedBy = auditor), which mirrors the escrow as `auditor_hold` and marks the
 *      row SUPERSEDED; anything else → retried with exponential backoff.
 *      A rollback's Settle FAILED answered NOT_FOUND is done only when qscc finds none of the
 *      payout's Authorise tx ids; otherwise it is retried until the late Authorise is settled.
 *   2. fills block hashes (qscc GetBlockByNumber) for delivered rows and authorised payouts;
 *   3. every LEDGER_AUDITOR_POLL_MS, re-reads auditor_hold escrows: one the auditor released goes
 *      back to HELD with the ledger's releaseDueAt and security_hold cleared.
 */

import pool from '../config/db';
import { fabricEnabled, ledgerWorkerConfig, type LedgerWorkerConfig } from '../config/fabric';
import { withTransaction, type TxDb } from '../repositories/db.types';
import {
  auditorHolds,
  blocksMissingHash,
  fillBlockHash,
  leaseOutbox,
  markDead,
  markDelivered,
  markRetry,
  markSuperseded,
  releaseLeases,
  mirrorAuditorHold,
  mirrorAuditorRelease,
  type OutboxLease,
} from '../repositories/ledger.repository';
import { fabricLedger, type LedgerClient } from '../services/fabric.service';
import { metrics as defaultMetrics, type GatewayMetrics } from '../services/metrics.service';

export type Delivery = 'delivered' | 'retry' | 'dead' | 'superseded' | 'lease_lost';

export interface LedgerWorkerDeps {
  pool?: TxDb;
  ledger?: LedgerClient;
  metrics?: GatewayMetrics;
  config?: Partial<LedgerWorkerConfig>;
  /** Defaults to FABRIC_ENABLED. */
  enabled?: () => boolean;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class LedgerWorker {
  private readonly pool: TxDb;
  private readonly ledgerOverride: LedgerClient | undefined;
  private readonly metrics: GatewayMetrics;
  private readonly enabled: () => boolean;
  readonly config: LedgerWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  private running = false;
  private lastAuditorPoll = -Infinity;
  private auditorCursor = NIL_UUID;

  constructor(deps: LedgerWorkerDeps = {}) {
    this.pool = deps.pool ?? pool;
    this.ledgerOverride = deps.ledger;
    this.metrics = deps.metrics ?? defaultMetrics;
    this.enabled = deps.enabled ?? (() => fabricEnabled());
    this.config = { ...ledgerWorkerConfig(), ...deps.config };
  }

  private get ledger(): LedgerClient {
    return this.ledgerOverride ?? fabricLedger();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.current = this.runOnce()
        .catch((e) => console.error('[LedgerWorker] tick failed:', (e as Error).message))
        .finally(() => {
          this.current = null;
          if (this.running) this.timer = setTimeout(tick, this.config.intervalMs);
        });
    };
    this.timer = setTimeout(tick, this.config.intervalMs);
    console.info('[LedgerWorker] started');
  }

  isRunning(): boolean {
    return this.running;
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([this.current, new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
      clearTimeout(t);
    }
    if (!this.ledgerOverride) fabricLedger().close(); // a restart reconnects
  }

  /** One pass; returns the number of rows leased. No-op while FABRIC_ENABLED≠true. */
  async runOnce(now = Date.now()): Promise<number> {
    if (!this.enabled()) return 0;
    const leases = await leaseOutbox(this.pool, this.config.batchSize, this.config.leaseMs);
    for (const [i, l] of leases.entries()) {
      try {
        // A failure that needs a retry (peer down) would hit the rest too: stop, give their leases back.
        if ((await this.deliver(l)) === 'retry') {
          await releaseLeases(this.pool, leases.slice(i + 1));
          break;
        }
      } catch (error) {
        // The lease expires on its own; the next tick retries it.
        console.error(`[LedgerWorker] outbox ${l.outboxId} (${l.op}) failed:`, (error as Error).message);
      }
    }
    await this.fillHashes().catch((e) => console.error('[LedgerWorker] block hash fill failed:', (e as Error).message));
    if (now - this.lastAuditorPoll >= this.config.auditorPollMs) {
      this.lastAuditorPoll = now;
      await this.pollAuditorHolds().catch((e) => console.error('[LedgerWorker] auditor-hold poll failed:', (e as Error).message));
    }
    return leases.length;
  }

  private backoff(attempts: number): number {
    return Math.min(this.config.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.config.backoffMaxMs);
  }

  async deliver(l: OutboxLease): Promise<Delivery> {
    const r = await this.ledger.submit(fnOf(l.op), l.request);
    if (r.ok) {
      // A Quarantine answered as a no-op under the auditor's lock did not take effect: mirror it.
      if (l.op === 'QUARANTINE' && lockedByAuditor(r.result)) return this.supersede(l, 'no-op: escrow locked by the auditor');
      if (!(await markDelivered(this.pool, l, { txId: r.txId, blockNumber: r.blockNumber }))) return 'lease_lost';
      this.metrics.ledger.delivered += 1;
      return 'delivered';
    }
    if (r.code === 'LOCKED_BY_AUDITOR' && (l.op === 'QUARANTINE' || l.op === 'RELEASE')) return this.supersede(l, r.message);
    if (r.code === 'NOT_FOUND' && l.op === 'SETTLE' && l.absentTxIds) return this.settleNotFound(l);
    if (r.code) {
      await markDead(this.pool, l, r.message);
      this.metrics.ledger.dead += 1;
      console.error(`[LedgerWorker] outbox ${l.outboxId} (${l.op}) DEAD: ${r.message}; fix the cause, then npm run ledger:requeue ${l.outboxId}`);
      return 'dead';
    }
    await markRetry(this.pool, l, this.backoff(l.attempts), r.message);
    this.metrics.ledger.retried += 1;
    return 'retry';
  }

  /** The rollback's Settle FAILED on a payout the ledger does not know: done only if no Authorise tx committed. */
  private async settleNotFound(l: OutboxLease): Promise<Delivery> {
    let committed: string | undefined;
    try {
      for (const txId of l.absentTxIds ?? []) if (await this.ledger.txCommitted(txId)) committed = txId;
    } catch (error) {
      await markRetry(this.pool, l, this.backoff(l.attempts), `NOT_FOUND; Authorise tx lookup failed: ${(error as Error).message}`);
      this.metrics.ledger.retried += 1;
      return 'retry';
    }
    if (committed) {
      // The Authorise committed after the gateway gave up: its block will show the payout soon.
      await markRetry(this.pool, l, this.backoff(l.attempts), `NOT_FOUND but Authorise tx ${committed} committed; retrying the Settle`);
      this.metrics.ledger.retried += 1;
      return 'retry';
    }
    if (!(await markDelivered(this.pool, l, null, 'NOT_FOUND: no Authorise tx committed; nothing to settle'))) return 'lease_lost';
    this.metrics.ledger.delivered += 1;
    return 'delivered';
  }

  private async supersede(l: OutboxLease, note: string): Promise<Delivery> {
    const done = await withTransaction(this.pool, async (tx) => {
      if (!(await markSuperseded(tx, l, note))) return false;
      if (l.escrowId) await mirrorAuditorHold(tx, [l.escrowId]);
      return true;
    });
    if (!done) return 'lease_lost';
    this.metrics.ledger.superseded += 1;
    console.warn(`[LedgerWorker] outbox ${l.outboxId} (${l.op}) superseded: escrow ${l.escrowId} is held by the auditor (mirrored as auditor_hold)`);
    return 'superseded';
  }

  private async fillHashes(): Promise<void> {
    for (const n of await blocksMissingHash(this.pool, 20)) {
      try {
        await fillBlockHash(this.pool, n, (await this.ledger.blockHeader(n)).hash);
      } catch (error) {
        console.error(`[LedgerWorker] block ${n} hash not filled (next tick retries):`, (error as Error).message);
      }
    }
  }

  /** Every auditor_hold escrow the auditor has released on the ledger goes back to HELD. */
  async pollAuditorHolds(limit = 100): Promise<number> {
    const ids = await auditorHolds(this.pool, this.auditorCursor, limit);
    this.auditorCursor = ids.length < limit ? NIL_UUID : ids[ids.length - 1];
    let released = 0;
    for (const id of ids) {
      const r = await this.ledger.evaluate('GetEscrow', id);
      if (!r.ok) continue; // retried at the next poll
      const e = parse(r.result) as { status?: string; releaseDueAt?: string };
      if (e.status !== 'HELD' || !e.releaseDueAt || Number.isNaN(Date.parse(e.releaseDueAt))) continue;
      if (await mirrorAuditorRelease(this.pool, id, new Date(e.releaseDueAt))) {
        released += 1;
        this.metrics.ledger.auditorReleased += 1;
        console.info(`[LedgerWorker] escrow ${id}: released by the auditor on the ledger; HELD again (due ${e.releaseDueAt})`);
      }
    }
    return released;
  }
}

const FN: Record<OutboxLease['op'], string> = { COMMIT: 'CommitTransaction', QUARANTINE: 'QuarantineEscrow', RELEASE: 'ReleaseEscrow', SETTLE: 'SettlePayout' };
const fnOf = (op: OutboxLease['op']): string => FN[op];

function parse(result: string): Record<string, unknown> {
  try {
    return JSON.parse(result) ?? {};
  } catch {
    return {};
  }
}
const lockedByAuditor = (result: string): boolean => parse(result).lockedBy === 'auditor';

export const ledgerWorker = new LedgerWorker();
