/**
 * @file payout_destination.service.ts
 * @description Verified payout destinations (spec gh-11, Fuliza-safe payouts part 1).
 *
 * An authenticated SALES_AGENT registers their LOGIN phone (never a phone from the request) as
 * their M-Pesa payout destination, confirming with their PIN. The row is recorded first; its id is
 * the B2C OriginatorConversationID of one BusinessPayment (PAYOUT_VERIFICATION_AMOUNT, default KES 10),
 * which is never resent. The
 * result's ReceiverPartyPublicName must match users.full_name. A first destination becomes ACTIVE;
 * a replacement (the login phone changed) waits out a cooling-off period (24 h) during which the
 * agent can cancel it, then the sweep promotes it. A result that never comes expires the row (30 min).
 *
 * Every change writes a PAYOUT_DESTINATION_CHANGED security event (same transaction) and sends a
 * SMS alert to the destination's phone and the agent's other open destinations (so the owner
 * of the current ACTIVE phone hears about a replacement). Alerts never block or roll back the flow.
 */

import pool from '../config/db';
import { AuthService, type ClientInfo, type PinConfirmResult } from '../auth/auth.service';
import { PayoutVerificationLimiter, ThrottleUnavailableError } from '../auth/throttle';
import { b2cClient, type B2cClient, type B2cResult } from '../daraja/client';
import { normaliseKenyanMsisdn } from '../domain/callback';
import { maskMsisdn } from '../domain/payout_destination';
import { findAgentForUser } from '../repositories/agent.repository';
import type { TxDb } from '../repositories/db.types';
import {
  applyVerificationResult,
  cancelCoolingOff,
  claimDestination,
  expireStale,
  findOpenDestinations,
  listDestinationEvents,
  listDestinations,
  promoteDue,
  recordB2cOutcome,
  type ApplyOutcome,
  type CancelOutcome,
  type DestinationEvent,
  type DestinationRow,
} from '../repositories/payout_destination.repository';
import { metrics as defaultMetrics, type GatewayMetrics } from './metrics.service';
import { notifierFromEnv, notifySafely, type Notifier } from './notifier.service';

/** PAYOUTS_ENABLED=true turns the routes and the sweep on (startup then requires the B2C settings). */
export const payoutsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PAYOUTS_ENABLED === 'true';

export interface PayoutDestinationConfig {
  verificationAmount: number;
  coolingOffMs: number;
  /** A PENDING_VERIFICATION row with no result after this long is EXPIRED. */
  expireAfterMs: number;
}

/** PAYOUT_VERIFICATION_AMOUNT: positive whole shillings; default 10 (the B2C minimum may exceed 1). */
export function verificationAmount(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.PAYOUT_VERIFICATION_AMOUNT?.trim() ?? '';
  const n = /^\d{1,6}$/.test(v) ? Number(v) : 0;
  return n > 0 ? n : 10;
}

export const DEFAULT_PAYOUT_DESTINATION_CONFIG: Omit<PayoutDestinationConfig, 'verificationAmount'> = {
  coolingOffMs: 24 * 3600_000,
  expireAfterMs: 30 * 60_000,
};

/** B2C REJECTED codes that are our own "never sent" failures, not a verdict on the destination. */
export const isNotSent = (code: string): boolean => ['config', 'oauth_unavailable', 'deadline'].includes(code) || code.startsWith('network_');

export interface PayoutDestinationDeps {
  db?: TxDb;
  b2c?: Pick<B2cClient, 'b2cPayment'>;
  auth?: Pick<AuthService, 'confirmPin'>;
  limiter?: PayoutVerificationLimiter;
  notifier?: Notifier;
  metrics?: GatewayMetrics;
  config?: Partial<PayoutDestinationConfig>;
}

type PinFailure = Exclude<PinConfirmResult, { kind: 'ok' }>;
type AgentFailure = { kind: 'not_provisioned' } | { kind: 'disabled' };

export type RegisterResult =
  | AgentFailure
  | PinFailure
  | { kind: 'already_active' }
  | { kind: 'pending' }
  | { kind: 'rate_limited'; retryAfterS: number }
  | { kind: 'phone_invalid' }
  | { kind: 'sent'; destination: DestinationRow };

export type CancelResult = AgentFailure | PinFailure | { kind: 'not_found' } | { kind: 'not_cancellable' } | { kind: 'cancelled'; destination: DestinationRow };

const REASONS: Record<string, string> = {
  name_mismatch: 'the M-Pesa registered name does not match your SalesMesh name',
  no_result: 'M-Pesa did not confirm the verification payment',
};

export class PayoutDestinationService {
  private readonly db: TxDb;
  private readonly b2c: Pick<B2cClient, 'b2cPayment'>;
  private readonly auth: Pick<AuthService, 'confirmPin'>;
  private readonly limiter: PayoutVerificationLimiter;
  private readonly notifier: Notifier;
  private readonly metrics: GatewayMetrics;
  readonly config: PayoutDestinationConfig;
  private readonly inflightAlerts = new Set<Promise<unknown>>();

  constructor(deps: PayoutDestinationDeps = {}) {
    this.db = deps.db ?? pool;
    this.b2c = deps.b2c ?? b2cClient;
    this.auth = deps.auth ?? new AuthService({ db: this.db });
    this.limiter = deps.limiter ?? new PayoutVerificationLimiter();
    this.notifier = deps.notifier ?? notifierFromEnv();
    this.metrics = deps.metrics ?? defaultMetrics;
    this.config = { ...DEFAULT_PAYOUT_DESTINATION_CONFIG, verificationAmount: verificationAmount(), ...deps.config };
  }

  /** POST: the agent and phone come from the token's user, never from the request body. */
  async register(userId: string, pin: unknown, client: ClientInfo): Promise<RegisterResult> {
    const agent = await findAgentForUser(this.db, userId);
    if (!agent) return { kind: 'not_provisioned' };
    if (agent.userDisabled) return { kind: 'disabled' };
    const confirmed = await this.auth.confirmPin(userId, pin, client);
    if (confirmed.kind !== 'ok') return confirmed;
    const msisdn = normaliseKenyanMsisdn(confirmed.phoneNumber);
    if (!msisdn) return { kind: 'phone_invalid' };

    const open = await findOpenDestinations(this.db, agent.agentId);
    if (open.some((d) => d.status !== 'ACTIVE')) return { kind: 'pending' };
    if (open.some((d) => d.msisdn === msisdn)) return { kind: 'already_active' };

    try {
      const limit = await this.limiter.hit(agent.agentId);
      if (!limit.allowed) {
        this.metrics.payouts.rateLimited += 1;
        return { kind: 'rate_limited', retryAfterS: limit.retryAfterS };
      }
    } catch (error) {
      if (!(error instanceof ThrottleUnavailableError)) throw error;
      console.error('[Payouts] verification rate limiter unavailable (Redis) — refusing (fail closed)');
      return { kind: 'unavailable' };
    }

    // Recorded (with its event) BEFORE the B2C call; a concurrent request loses here.
    const claimed = await claimDestination(this.db, { agentId: agent.agentId, userId, msisdn });
    if (!claimed) return { kind: 'pending' };
    this.alert(
      claimed,
      `SalesMesh: a payout destination (${maskMsisdn(msisdn)}) was registered on your account and a KES ${this.config.verificationAmount} verification payment has been requested. If this was not you, contact your admin now.`
    );

    const outcome = await this.b2c.b2cPayment({
      originatorConversationId: claimed.destinationId,
      phone: msisdn,
      amount: this.config.verificationAmount,
      remarks: 'SalesMesh payout destination check',
    });
    this.metrics.payouts[outcome.kind] += 1;
    let row: DestinationRow = claimed;
    try {
      row = (await recordB2cOutcome(this.db, claimed.destinationId, userId, outcome)) ?? claimed;
    } catch (error) {
      // The row stays PENDING_VERIFICATION: the result or the expiry sweep decides it.
      console.error(`[Payouts] could not record the B2C outcome for destination ${claimed.destinationId}:`, (error as Error).message);
    }
    console.info(`[Payouts] destination ${claimed.destinationId} (${maskMsisdn(msisdn)}): B2C ${outcome.kind}`);
    // Our own failure to send says nothing about the destination: REJECTED (so the agent can retry), no alert, 503.
    if (outcome.kind === 'REJECTED' && isNotSent(outcome.code)) return { kind: 'unavailable' };
    if (outcome.kind === 'REJECTED' && row.status === 'REJECTED') this.alertChange(row);
    return { kind: 'sent', destination: row };
  }

  /** GET: the agent's destinations and recent destination events. */
  async list(userId: string): Promise<AgentFailure | { kind: 'ok'; destinations: DestinationRow[]; events: DestinationEvent[] }> {
    const agent = await findAgentForUser(this.db, userId);
    if (!agent) return { kind: 'not_provisioned' };
    if (agent.userDisabled) return { kind: 'disabled' };
    const [destinations, events] = await Promise.all([listDestinations(this.db, agent.agentId), listDestinationEvents(this.db, userId)]);
    return { kind: 'ok', destinations, events };
  }

  /** DELETE /:id with the PIN: cancels the agent's own destination while it is cooling off. */
  async cancel(userId: string, id: string, pin: unknown, client: ClientInfo): Promise<CancelResult> {
    const agent = await findAgentForUser(this.db, userId);
    if (!agent) return { kind: 'not_provisioned' };
    if (agent.userDisabled) return { kind: 'disabled' };
    const confirmed = await this.auth.confirmPin(userId, pin, client);
    if (confirmed.kind !== 'ok') return confirmed;
    return this.cancelled(await cancelCoolingOff(this.db, id, { agentId: agent.agentId }));
  }

  /** `npm run payout:cancel <destination_id>`: an admin cancels any COOLING_OFF destination. */
  async adminCancel(id: string): Promise<CancelOutcome> {
    return this.cancelled(await cancelCoolingOff(this.db, id, { admin: true }));
  }

  private cancelled(result: CancelOutcome): CancelOutcome {
    if (result.kind === 'cancelled') {
      this.metrics.payouts.cancelled += 1;
      this.alertChange(result.destination);
    }
    return result;
  }

  /** A B2C result callback: applied at most once; unknown and repeated results change nothing. */
  async applyResult(result: B2cResult): Promise<ApplyOutcome> {
    const outcome = await applyVerificationResult(this.db, result, this.config.coolingOffMs);
    if (outcome.kind === 'applied') {
      const d = outcome.destination;
      if (d.status === 'REJECTED') this.metrics.payouts.rejected += 1;
      else if (d.status === 'ACTIVE') this.metrics.payouts.activated += 1;
      console.info(`[Payouts] destination ${d.destinationId} (${maskMsisdn(d.msisdn)}): ${d.status}${d.rejectReason ? ` (${d.rejectReason})` : ''}`);
      this.alertChange(d);
    } else if (outcome.kind === 'late') console.warn(`[Payouts] late B2C result for expired destination ${result.originatorConversationId} (ResultCode ${result.resultCode}) recorded`);
    return outcome;
  }

  /** Worker sweep: promote cooled-off replacements, expire verifications that got no result. */
  async sweep(): Promise<{ promoted: number; expired: number }> {
    // Each half on its own: a failed promotion must not stop expiry, and vice versa.
    const promoted = await promoteDue(this.db).catch((e) => {
      console.error('[Payouts] promotion sweep failed:', (e as Error).message);
      return [];
    });
    const expired = await expireStale(this.db, this.config.expireAfterMs).catch((e) => {
      console.error('[Payouts] expiry sweep failed:', (e as Error).message);
      return [];
    });
    this.metrics.payouts.activated += promoted.length;
    this.metrics.payouts.expired += expired.length;
    for (const c of [...promoted, ...expired]) this.alertChange(c.destination);
    for (const c of promoted) {
      // The old phone is no longer open, so alertChange would miss it.
      if (c.superseded) this.send([c.superseded.msisdn], `SalesMesh: your payouts now go to ${maskMsisdn(c.destination.msisdn)}. If this was not you, contact your admin now.`);
    }
    if (promoted.length + expired.length > 0) console.info(`[Payouts] sweep: ${promoted.length} promoted, ${expired.length} expired`);
    return { promoted: promoted.length, expired: expired.length };
  }

  /** Waits for the alerts still being sent (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.inflightAlerts]);
  }

  private alertChange(d: DestinationRow): void {
    const phone = maskMsisdn(d.msisdn);
    const reason = d.rejectReason ? (REASONS[d.rejectReason] ?? 'the verification payment failed') : '';
    const message: Partial<Record<DestinationRow['status'], string>> = {
      ACTIVE: `SalesMesh: ${phone} is now your active M-Pesa payout destination. If this was not you, contact your admin now.`,
      COOLING_OFF: `SalesMesh: ${phone} was verified as your NEW payout destination. It becomes active on ${d.coolingOffUntil?.toISOString()} unless you cancel it in the app. If this was not you, cancel it and contact your admin now.`,
      REJECTED: `SalesMesh: payout destination ${phone} was not verified: ${reason}.`,
      EXPIRED: `SalesMesh: payout destination ${phone} was not verified: ${reason}. You can register it again.`,
      CANCELLED: `SalesMesh: the pending payout destination ${phone} was cancelled. Your current destination is unchanged.`,
    };
    const text = message[d.status];
    if (text) this.alert(d, text);
  }

  /** Fire-and-forget: the destination's phone plus the agent's other open destinations. */
  private alert(d: DestinationRow, message: string): void {
    this.track(
      (async () => {
        const others = await findOpenDestinations(this.db, d.agentId).catch(() => [] as DestinationRow[]);
        await this.deliver([d.msisdn, ...others.map((o) => o.msisdn)], message);
      })()
    );
  }

  /** Fire-and-forget to exactly these phones. */
  private send(to: string[], message: string): void {
    this.track(this.deliver(to, message));
  }

  private async deliver(to: string[], message: string): Promise<void> {
    await Promise.all([...new Set(to)].map((msisdn) => notifySafely(this.notifier, msisdn, message, this.metrics)));
  }

  private track(p: Promise<unknown>): void {
    this.inflightAlerts.add(p);
    void p.finally(() => this.inflightAlerts.delete(p));
  }
}

export const payoutDestinationService = new PayoutDestinationService();
