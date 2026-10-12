/**
 * @file frozen.service.ts
 * @description Frozen-payout SLA escalation (spec gh-11, part 3c).
 *
 * A QUARANTINED escrow waiting longer than FROZEN_ESCROW_SLA_HOURS (72) or an UNRESOLVED payout
 * waiting longer than UNRESOLVED_PAYOUT_SLA_HOURS (24) is marked escalated once per frozen spell,
 * and the active MERCHANT_ADMINs get one SMS digest per sweep (counts and KES totals only). Runs
 * whether or not PAYOUTS_ENABLED is set (quarantines exist without payouts), only inside
 * PAYOUT_REMINDER_HOURS (Africa/Nairobi), at most once an hour. The queue itself is
 * GET /api/v1/admin/frozen-payouts.
 */

import pool from '../config/db';
import { frozenSlaConfig, type FrozenSlaConfig } from '../domain/payout';
import type { Db } from '../repositories/db.types';
import { activeAdminPhones, escalateOverdue, listFrozen, type Escalated } from '../repositories/frozen.repository';
import { metrics as defaultMetrics, type GatewayMetrics } from './metrics.service';
import { notifierFromEnv, notifySafely, type Notifier } from './notifier.service';

export interface FrozenDeps {
  db?: Db;
  notifier?: Notifier;
  metrics?: GatewayMetrics;
  /** Overrides of PAYOUT_REMINDER_HOURS / *_SLA_HOURS (tests). */
  config?: Partial<FrozenSlaConfig>;
}

const ESCALATE_EVERY_MS = 3600_000;
export const FROZEN_LIST_LIMIT = 200;

const kes = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
const many = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The admin digest: counts and KES totals only (no names, phones or receipts). */
export function digest(x: Escalated): string {
  const parts = [
    x.escrows ? `${many(x.escrows, 'quarantined escrow')} (KES ${kes(x.escrowCents)})` : '',
    x.payouts ? `${many(x.payouts, 'unresolved payout')} (KES ${kes(x.payoutCents)})` : '',
  ].filter(Boolean);
  return `SalesMesh admin: ${parts.join(' and ')} passed their SLA. Review: GET /api/v1/admin/frozen-payouts.`;
}

export class FrozenPayoutService {
  private readonly db: Db;
  private readonly notifier: Notifier;
  private readonly metrics: GatewayMetrics;
  private readonly overrides: Partial<FrozenSlaConfig>;
  private readonly inflightAlerts = new Set<Promise<unknown>>();
  private lastRun = -Infinity;

  constructor(deps: FrozenDeps = {}) {
    this.db = deps.db ?? pool;
    this.notifier = deps.notifier ?? notifierFromEnv();
    this.metrics = deps.metrics ?? defaultMetrics;
    this.overrides = deps.config ?? {};
  }

  config(): FrozenSlaConfig {
    return { ...frozenSlaConfig(), ...this.overrides };
  }

  sla(): { escrowHours: number; payoutHours: number } {
    const cfg = this.config();
    return { escrowHours: cfg.frozenEscrowSlaHours, payoutHours: cfg.unresolvedPayoutSlaHours };
  }

  /**
   * Housekeeping: marks the frozen items past their SLA and texts each active MERCHANT_ADMIN one digest.
   * Outside the daytime window nothing is marked, so a night breach escalates at the next daytime sweep.
   * Returns what was escalated (null when the sweep did not run).
   */
  async escalate(now = new Date()): Promise<Escalated | null> {
    const cfg = this.config();
    const hour = (now.getUTCHours() + 3) % 24; // Africa/Nairobi: UTC+3, no DST
    if (hour < cfg.reminderHours[0] || hour >= cfg.reminderHours[1]) return null;
    if (now.getTime() - this.lastRun < ESCALATE_EVERY_MS) return null;
    this.lastRun = now.getTime(); // before the query: a failing sweep logs at most hourly
    const x = await escalateOverdue(this.db, this.sla());
    const n = x.escrows + x.payouts;
    if (n === 0) return x;
    this.metrics.frozenSla.escalated += n;
    console.warn(`[FrozenSLA] ${x.escrows} quarantined escrow(s) and ${x.payouts} unresolved payout(s) passed their SLA; see GET /api/v1/admin/frozen-payouts`);
    // Marked first: a failed lookup or SMS never un-marks (the queue still shows them as overdue).
    const phones = await activeAdminPhones(this.db).catch((e) => {
      console.error('[FrozenSLA] admin lookup failed:', (e as Error).message);
      return null;
    });
    if (phones?.length === 0) console.warn('[FrozenSLA] no active MERCHANT_ADMIN to alert');
    const text = digest(x);
    for (const phone of phones ?? []) {
      const send = notifySafely(this.notifier, phone, text, this.metrics).then((ok) => {
        if (ok) this.metrics.frozenSla.alertsSent += 1;
        else this.metrics.frozenSla.alertsFailed += 1;
      });
      this.inflightAlerts.add(send);
      void send.finally(() => this.inflightAlerts.delete(send));
    }
    return x;
  }

  /** GET /api/v1/admin/frozen-payouts: every frozen item, overdue first. */
  async list() {
    const sla = this.sla();
    return { sla, ...(await listFrozen(this.db, { ...sla, limit: FROZEN_LIST_LIMIT })) };
  }

  /** Waits for the digests still being sent (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.inflightAlerts]);
  }
}

export const frozenPayoutService = new FrozenPayoutService();
