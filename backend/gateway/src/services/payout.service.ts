/**
 * @file payout.service.ts
 * @description Agent-claimed commission payouts (spec gh-11, part 2).
 *
 * Matured HELD escrows are the agent's claimable balance. The agent claims it whole (oldest first,
 * up to PAYOUT_MAX_AMOUNT) with their PIN, after accepting the current Fuliza disclosure. The claim
 * (payout row SENT + consent hash, escrows HELD → CLAIMED) commits BEFORE one B2C BusinessPayment
 * of floor(balance) shillings to the ACTIVE destination; the cents carry to the next claim.
 *
 *  - ACCEPTED: the result callback decides PAID (escrows RELEASED) or FAILED (escrows HELD again).
 *  - REJECTED (definitively not sent): FAILED at once, escrows claimable again.
 *  - UNKNOWN (timeout, 5xx, no ConversationID): never resent. The sweep asks Transaction Status
 *    (by OriginalConversationID) with backoff; no definitive answer after the attempts → UNRESOLVED,
 *    settled by an admin (`npm run payout:resolve`). The agent cannot claim again meanwhile.
 *
 * Every state change writes a PAYOUT_STATUS_CHANGED event (same transaction) and sends an SMS to the
 * paid line. Alerts never block or roll back the flow.
 *
 * Unclaimed reminders (part 3a): housekeeping texts the login phone when the claimable balance has
 * waited PAYOUT_REMINDER_DAYS (7, 30, 90) since its oldest escrow matured, once per stage per cycle,
 * only in PAYOUT_REMINDER_HOURS (Africa/Nairobi).
 */

import crypto from 'crypto';
import pool from '../config/db';
import { AuthService, type ClientInfo, type PinConfirmResult } from '../auth/auth.service';
import { b2cClient, parseB2cResult, parseTransactionStatusResult, type B2cClient } from '../daraja/client';
import { DISCLOSURES, payoutConfig, splitClaim, type PayoutConfig } from '../domain/payout';
import { maskMsisdn } from '../domain/payout_destination';
import { findAgentForUser } from '../repositories/agent.repository';
import type { TxDb } from '../repositories/db.types';
import {
  applyPayoutResult,
  applyStatusResult,
  claimableEscrows,
  createPayout,
  dueReminders,
  exhaustStatusChecks,
  leaseStatusChecks,
  listPayouts,
  payoutContext,
  pendingAccruals,
  type Accrual,
  recordPayoutSend,
  releaseStatusLease,
  resolvePayout,
  type PayoutChange,
  type PayoutRow,
  type ResultOutcome,
} from '../repositories/payout.repository';
import { remittedForAgent } from '../repositories/ufaa.repository';
import { metrics as defaultMetrics, type GatewayMetrics } from './metrics.service';
import { notifierFromEnv, notifySafely, type Notifier } from './notifier.service';
import { isNotSent, payoutsEnabled } from './payout_destination.service';

export interface PayoutDeps {
  db?: TxDb;
  b2c?: Pick<B2cClient, 'b2cPayment' | 'transactionStatus'>;
  auth?: Pick<AuthService, 'confirmPin'>;
  notifier?: Notifier;
  metrics?: GatewayMetrics;
  /** Overrides of the PAYOUT_* settings (tests). */
  config?: Partial<PayoutConfig>;
}

type PinFailure = Exclude<PinConfirmResult, { kind: 'ok' }>;
type AgentFailure = { kind: 'not_provisioned' } | { kind: 'disabled' };

export interface Balance {
  /** Claimable gross plus the carry, in cents. */
  cents: number;
  escrows: number;
  carryCents: number;
  /** Whole shillings a claim would pay now (oldest escrows up to the maximum). */
  payableNow: number;
}

export type ClaimResult =
  | AgentFailure
  | PinFailure
  | { kind: 'disclosure_changed' }
  | { kind: 'payout_in_progress' }
  | { kind: 'no_active_destination' }
  | { kind: 'destination_changing' }
  | { kind: 'below_minimum'; amount: number }
  | { kind: 'above_maximum' }
  /** The claim committed; `payout.status` says what the B2C send did (SENT, UNKNOWN or FAILED). */
  | { kind: 'claimed'; payout: PayoutRow };

const LEASE_MS = 120_000;
const MAX_BACKOFF_MS = 6 * 3600_000;
const REMINDER_EVERY_MS = 3600_000;

export class PayoutService {
  private readonly db: TxDb;
  private readonly b2c: Pick<B2cClient, 'b2cPayment' | 'transactionStatus'>;
  private readonly auth: Pick<AuthService, 'confirmPin'>;
  private readonly notifier: Notifier;
  private readonly metrics: GatewayMetrics;
  private readonly overrides: Partial<PayoutConfig>;
  private readonly inflightAlerts = new Set<Promise<unknown>>();
  private lastReminderRun = -Infinity;

  constructor(deps: PayoutDeps = {}) {
    this.db = deps.db ?? pool;
    this.b2c = deps.b2c ?? b2cClient;
    this.auth = deps.auth ?? new AuthService({ db: this.db });
    this.notifier = deps.notifier ?? notifierFromEnv();
    this.metrics = deps.metrics ?? defaultMetrics;
    this.overrides = deps.config ?? {};
  }

  /** PAYOUT_* read per call (a bad value fails the request, not the import); preflight validates them. */
  config(): PayoutConfig {
    return { ...payoutConfig(), ...this.overrides };
  }

  disclosure(): { version: string; text: string } {
    const version = this.config().disclosureVersion;
    return { version, text: DISCLOSURES[version] };
  }

  /** GET: balance, destination, the disclosure to accept, and history. */
  async claimable(userId: string): Promise<
    | AgentFailure
    | {
        kind: 'ok';
        balance: Balance;
        destination: string | null;
        destinationChanging: boolean;
        disclosure: { version: string; text: string };
        payouts: PayoutRow[];
        /** Commission still in escrow, quarantined or in a claim (gh-13), with the unmatured totals. */
        accruals: Accrual[];
        pendingCount: number;
        pendingCents: number;
        /** Dormant commission transferred (reference) or being transferred (null) to UFAA (part 3b): not in the balance. */
        remitted: Array<{ cents: number; periodEnd: string; reference: string | null; holderReference: string }>;
      }
  > {
    const agent = await findAgentForUser(this.db, userId);
    if (!agent) return { kind: 'not_provisioned' };
    if (agent.userDisabled) return { kind: 'disabled' };
    const [escrows, ctx, payouts, remitted, pending] = await Promise.all([
      claimableEscrows(this.db, agent.agentId),
      payoutContext(this.db, agent.agentId),
      listPayouts(this.db, agent.agentId),
      remittedForAgent(this.db, agent.agentId),
      pendingAccruals(this.db, agent.agentId, 50),
    ]);
    const cents = escrows.reduce((s, e) => s + e.cents, 0) + ctx.carryCents;
    return {
      kind: 'ok',
      balance: { cents, escrows: escrows.length, carryCents: ctx.carryCents, payableNow: splitClaim(escrows, ctx.carryCents, this.config().maxAmount).amount },
      destination: ctx.active ? maskMsisdn(ctx.active.msisdn) : null,
      destinationChanging: ctx.changing,
      disclosure: this.disclosure(),
      payouts,
      remitted,
      ...pending,
    };
  }

  /** POST /claim: {pin, disclosure_version}. The agent comes from the token, the phone from the ACTIVE destination. */
  async claim(userId: string, pin: unknown, disclosureVersion: unknown, client: ClientInfo): Promise<ClaimResult> {
    const cfg = this.config();
    const agent = await findAgentForUser(this.db, userId);
    if (!agent) return { kind: 'not_provisioned' };
    if (agent.userDisabled) return { kind: 'disabled' };
    const confirmed = await this.auth.confirmPin(userId, pin, client);
    if (confirmed.kind !== 'ok') return confirmed;
    if (String(disclosureVersion ?? '') !== cfg.disclosureVersion) return { kind: 'disclosure_changed' };

    const created = await createPayout(this.db, {
      agentId: agent.agentId,
      payoutId: crypto.randomUUID(),
      acceptedAt: new Date(),
      disclosureVersion: cfg.disclosureVersion,
      disclosureText: DISCLOSURES[cfg.disclosureVersion],
      minAmount: cfg.minAmount,
      maxAmount: cfg.maxAmount,
    });
    if (created.kind !== 'created') return created;
    this.metrics.payoutClaims.claimed += 1;
    const claimed = created.payout;

    const outcome = await this.b2c.b2cPayment({
      originatorConversationId: claimed.payoutId,
      phone: claimed.msisdn,
      amount: claimed.amount,
      remarks: 'SalesMesh commission payout',
    });
    const reason = outcome.kind === 'REJECTED' ? (isNotSent(outcome.code) ? 'not_sent' : `b2c_${outcome.code}`) : '';
    let change: PayoutChange | null = null;
    let raced = false;
    try {
      change = await recordPayoutSend(this.db, claimed.payoutId, outcome, reason);
      raced = change === null;
    } catch (error) {
      // The payout stays SENT: its result or the Transaction Status sweep decides it (never a resend).
      console.error(`[Payouts] could not record the B2C outcome for payout ${claimed.payoutId}:`, (error as Error).message);
    }
    const payout = change?.payout ?? claimed;
    console.info(`[Payouts] payout ${payout.payoutId} KES ${payout.amount} (${maskMsisdn(payout.msisdn)}): B2C ${outcome.kind}${reason ? ` (${reason})` : ''} → ${payout.status}`);
    // One SMS for the claim, saying where the send stands (a result that raced ahead alerts on its own).
    if (!raced) this.alert(payout, payout.status);
    if (payout.status === 'UNKNOWN') this.metrics.payoutClaims.unknown += 1;
    if (payout.status === 'FAILED') this.metrics.payoutClaims.failed += 1;
    return { kind: 'claimed', payout };
  }

  /**
   * A B2C result callback body: a payout result (by payout_id), else a Transaction Status result
   * (by any of its status_query_ids). Null when it is neither (the payout-destination flow handles it).
   */
  async handleResult(body: unknown): Promise<ResultOutcome | null> {
    const result = parseB2cResult(body);
    if (!result) return null;
    let outcome = await applyPayoutResult(this.db, result);
    if (outcome.kind === 'unknown') {
      const ts = parseTransactionStatusResult(body);
      outcome = ts ? await applyStatusResult(this.db, ts) : outcome;
    }
    if (outcome.kind === 'unknown') return null;
    if (outcome.kind === 'applied') this.applied(outcome);
    else if (outcome.kind === 'duplicate' && outcome.conflict) console.error(`[Payouts] SECURITY: ${outcome.conflict} (OriginatorConversationID ${result.originatorConversationId})`);
    else console.info(`[Payouts] result ${outcome.kind} (ResultCode ${result.resultCode})`);
    return outcome;
  }

  /** Worker sweep: Transaction Status for lost results; exhausted attempts → UNRESOLVED. No-op while PAYOUTS_ENABLED≠true. */
  async sweep(): Promise<{ queried: number; unresolved: number }> {
    if (!payoutsEnabled()) return { queried: 0, unresolved: 0 };
    const cfg = this.config();
    let queried = 0;
    const leases = await leaseStatusChecks(this.db, { limit: 20, afterMs: cfg.statusAfterMs, maxAttempts: cfg.statusMaxAttempts, leaseMs: LEASE_MS }).catch((e) => {
      console.error('[Payouts] Transaction Status lease failed:', (e as Error).message);
      return [];
    });
    for (const lease of leases) {
      try {
        const o = await this.b2c.transactionStatus({ originatorConversationId: lease.payoutId, queryId: lease.queryId });
        this.metrics.payoutClaims.statusQueries += 1;
        queried += 1;
        // Never sent (our side / Daraja unreachable): the attempt is given back, so an outage cannot exhaust it.
        const notSent = o.kind === 'REJECTED' && isNotSent(o.code);
        // Backoff doubles per attempt: the answer arrives asynchronously on the result URL meanwhile.
        const delay = Math.min(cfg.statusAfterMs * 2 ** (lease.attempts - 1), MAX_BACKOFF_MS);
        await releaseStatusLease(this.db, lease, delay, `TS query ${lease.attempts}: ${o.kind}${o.kind === 'ACCEPTED' ? '' : ` (${o.code})`}`, notSent);
      } catch (error) {
        // The lease expires on its own; the other payouts are still queried.
        console.error(`[Payouts] Transaction Status for payout ${lease.payoutId} failed:`, (error as Error).message);
      }
    }
    const unresolved = await exhaustStatusChecks(this.db, { maxAttempts: cfg.statusMaxAttempts, leaseMs: LEASE_MS }).catch((e) => {
      console.error('[Payouts] unresolved sweep failed:', (e as Error).message);
      return [] as PayoutChange[];
    });
    for (const c of unresolved) {
      this.metrics.payoutClaims.unresolved += 1;
      console.error(`[Payouts] payout ${c.payout.payoutId} UNRESOLVED: no definitive M-Pesa answer; resolve with payout:resolve`);
      this.alert(c.payout, 'UNRESOLVED');
    }
    return { queried, unresolved: unresolved.length };
  }

  /**
   * Housekeeping: at most one SMS per agent whose claimable balance has reached a reminder stage. The
   * stage is recorded before the send (a failed SMS is counted, never retried). Outside the daytime
   * window nothing is marked, so the reminder goes at the next daytime sweep. At most one query per hour.
   * No-op while PAYOUTS_ENABLED≠true.
   */
  async remindUnclaimed(now = new Date()): Promise<number> {
    if (!payoutsEnabled()) return 0;
    const cfg = this.config();
    const hour = (now.getUTCHours() + 3) % 24; // Africa/Nairobi: UTC+3, no DST
    if (hour < cfg.reminderHours[0] || hour >= cfg.reminderHours[1]) return 0;
    // Ages move by days: query at most hourly (a night skip does not use up the hour).
    if (now.getTime() - this.lastReminderRun < REMINDER_EVERY_MS) return 0;
    const due = await dueReminders(this.db, { stages: cfg.reminderDays, minAmount: cfg.minAmount, limit: 100 });
    this.lastReminderRun = now.getTime();
    for (const r of due) {
      const amount = Math.floor(r.cents / 100);
      const how = r.hasActiveDestination
        ? 'Claim it in the SalesMesh app with your PIN; it is paid to your verified M-Pesa line.'
        : 'Register your M-Pesa payout line in the SalesMesh app first, then claim it with your PIN.';
      console.info(`[Payouts] unclaimed reminder (stage ${r.stage}) KES ${amount} to ${maskMsisdn(r.phone)}`);
      const send = notifySafely(this.notifier, r.phone, `SalesMesh: KES ${amount} commission is waiting for you to claim. ${how}`, this.metrics).then((ok) => {
        if (ok) this.metrics.payoutClaims.reminders += 1;
        else this.metrics.payoutClaims.remindersFailed += 1;
      });
      this.inflightAlerts.add(send);
      void send.finally(() => this.inflightAlerts.delete(send));
    }
    return due.length;
  }

  /** `npm run payout:resolve <id> paid <receipt> | failed`: only an UNRESOLVED payout. */
  async adminResolve(id: string, o: { paid: true; receipt: string } | { paid: false }, operator = 'unknown') {
    const r = await resolvePayout(this.db, id, o, operator);
    if (r.kind === 'resolved') this.applied(r);
    return r;
  }

  /** Waits for the alerts still being sent (tests, shutdown, CLI). */
  async settled(): Promise<void> {
    await Promise.all([...this.inflightAlerts]);
  }

  private applied(c: PayoutChange): void {
    const p = c.payout;
    if (p.status === 'PAID') this.metrics.payoutClaims.paid += 1;
    else if (p.status === 'FAILED') this.metrics.payoutClaims.failed += 1;
    if (c.nameMismatch) {
      this.metrics.payoutClaims.nameMismatch += 1;
      console.warn(`[Payouts] payout ${p.payoutId}: paid line's registered name no longer matches the agent (PAYOUT_NAME_MISMATCH)`);
    }
    console.info(`[Payouts] payout ${p.payoutId} KES ${p.amount} (${maskMsisdn(p.msisdn)}): ${p.status}${p.failureReason ? ` (${p.failureReason})` : ''}`);
    this.alert(p, p.status);
  }

  private alert(p: PayoutRow, status: PayoutRow['status']): void {
    const phone = maskMsisdn(p.msisdn);
    const text: Record<PayoutRow['status'], string> = {
      SENT: `SalesMesh: your commission payout of KES ${p.amount} to ${phone} has been requested. If this was not you, contact your admin now.`,
      UNKNOWN: `SalesMesh: we are confirming your payout of KES ${p.amount} to ${phone} with M-Pesa. It will never be sent twice.`,
      PAID: `SalesMesh: KES ${p.amount} commission paid to ${phone}${p.receipt ? `, M-Pesa receipt ${p.receipt}` : ''}.`,
      FAILED: `SalesMesh: your payout of KES ${p.amount} to ${phone} did not go through. The balance can be claimed again.`,
      UNRESOLVED: `SalesMesh: M-Pesa has not confirmed your payout of KES ${p.amount} to ${phone}. An admin will resolve it; it will never be sent twice.`,
    };
    const send = notifySafely(this.notifier, p.msisdn, text[status], this.metrics);
    this.inflightAlerts.add(send);
    void send.finally(() => this.inflightAlerts.delete(send));
  }
}

export const payoutService = new PayoutService();
