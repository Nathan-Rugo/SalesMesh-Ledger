/**
 * @file payments.controller.ts
 * @description POST /api/v1/payments/stk — an authenticated SALES_AGENT triggers a Daraja STK
 * Push to a customer (spec gh-5).
 *
 * Order of operations (recording before calling Daraja is what makes this safe):
 *   validate → agent from the token's user_id (never the body) → Idempotency-Key replay? →
 *   per-agent rate limit → soft duplicate guard → claim the key (INSERT PENDING) → Daraja →
 *   record the outcome → 201 ACCEPTED / 202 UNKNOWN / 502 REJECTED.
 *
 * A lost Daraja response leaves the row PENDING → UNKNOWN, never "did not happen": its callback
 * is still attributed by the settlement worker's fallback match. Replaying a key returns the
 * original outcome (latest status) and never sends a second prompt; concurrent same-key requests
 * wait on the row. Only the customer phone's HMAC is stored; it is never logged.
 */

import type { Request, Response } from 'express';
import pool from '../config/db';
import { alternateKeyedHashes, keyedHash, keyedHashMatches } from '../config/pii';
import { paymentsConfig, type PaymentsConfig } from '../config/stk';
import { normaliseKenyanMsisdn, normalisedMsisdnHash } from '../domain/callback';
import { DarajaClient, darajaClient as defaultDaraja } from '../daraja/client';
import { StkRateLimiter, ThrottleUnavailableError } from '../auth/throttle';
import { findAgentForUser } from '../repositories/agent.repository';
import { withTransaction, type TxDb } from '../repositories/db.types';
import {
  claimStkRequest,
  expireStalePending,
  findByIdempotencyKey,
  findStkById,
  hasRecentDuplicate,
  lockDuplicateGuard,
  recordStkOutcome,
  type StkRow,
} from '../repositories/stk.repository';
import { metrics as defaultMetrics, type GatewayMetrics } from '../services/metrics.service';

export const STK_MIN_AMOUNT = 1;
export const STK_MAX_AMOUNT = 250_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export type { PaymentsConfig };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaymentsDeps {
  db?: TxDb;
  daraja?: Pick<DarajaClient, 'stkPush'>;
  rateLimiter?: StkRateLimiter;
  metrics?: GatewayMetrics;
  config?: Partial<PaymentsConfig>;
}

interface Validated {
  amount: number;
  msisdn: string;
  key: string;
  confirmDuplicate: boolean;
}

/** The request fingerprint: keyed HMAC of (phone, amount); replays must match it. */
const fingerprintInput = (msisdn: string, amount: number) => `msisdn:${msisdn}|amount:${amount}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PaymentsController {
  private readonly db: TxDb;
  private readonly daraja: Pick<DarajaClient, 'stkPush'>;
  private readonly rateLimiter: StkRateLimiter;
  private readonly metrics: GatewayMetrics;
  readonly config: PaymentsConfig;

  constructor(deps: PaymentsDeps = {}) {
    this.db = deps.db ?? pool;
    this.daraja = deps.daraja ?? defaultDaraja;
    this.rateLimiter = deps.rateLimiter ?? new StkRateLimiter();
    this.metrics = deps.metrics ?? defaultMetrics;
    this.config = { ...paymentsConfig(), ...deps.config };
  }

  private validate(req: Request): { ok: true; value: Validated } | { ok: false; fields: Record<string, string> } {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};

    let amount = NaN;
    if (typeof body.amount === 'number') amount = body.amount;
    else if (typeof body.amount === 'string' && /^\d{1,7}$/.test(body.amount.trim())) amount = Number(body.amount.trim());
    if (!Number.isInteger(amount) || amount < STK_MIN_AMOUNT || amount > STK_MAX_AMOUNT) {
      fields.amount = `must be a whole number of shillings between ${STK_MIN_AMOUNT} and ${STK_MAX_AMOUNT}`;
    }
    const msisdn = typeof body.phone === 'string' ? normaliseKenyanMsisdn(body.phone) : null;
    if (!msisdn) fields.phone = 'must be a Safaricom number (07XXXXXXXX, 01XXXXXXXX or 254XXXXXXXXX)';
    const key = req.get('Idempotency-Key')?.trim() ?? '';
    if (!IDEMPOTENCY_KEY_RE.test(key)) fields['Idempotency-Key'] = 'header is required (1-100 of A-Z a-z 0-9 _ . : -)';
    if (body.confirm_duplicate !== undefined && typeof body.confirm_duplicate !== 'boolean') {
      fields.confirm_duplicate = 'must be a boolean';
    }
    if (Object.keys(fields).length) return { ok: false, fields };
    return { ok: true, value: { amount, msisdn: msisdn!, key, confirmDuplicate: body.confirm_duplicate === true } };
  }

  /** POST /api/v1/payments/stk */
  public async initiate(req: Request, res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    const v = this.validate(req);
    if (!v.ok) {
      res.status(400).json({ error: 'invalid_request', fields: v.fields });
      return;
    }
    const { amount, msisdn, key, confirmDuplicate } = v.value;

    const agent = await findAgentForUser(this.db, req.auth!.userId);
    if (agent?.userDisabled) {
      res.status(403).json({ error: 'account_disabled' });
      return;
    }
    if (!agent || !agent.agentCode || agent.agentCode.length > 12) {
      res.status(409).json({ error: 'agent_not_provisioned' });
      return;
    }

    const fpInput = fingerprintInput(msisdn, amount);
    const existing = await findByIdempotencyKey(this.db, agent.agentId, key);
    if (existing) return this.replay(res, existing, fpInput);

    try {
      const limit = await this.rateLimiter.hit(agent.agentId, key);
      if (!limit.allowed) {
        this.metrics.stk.rateLimited += 1;
        res.set('Retry-After', String(limit.retryAfterS));
        res.status(429).json({ error: 'rate_limited' });
        return;
      }
    } catch (error) {
      if (!(error instanceof ThrottleUnavailableError)) throw error;
      console.error('[Payments] STK rate limiter unavailable (Redis) — refusing initiation (fail closed)');
      res.status(503).json({ error: 'temporarily_unavailable' });
      return;
    }

    const phoneHash = normalisedMsisdnHash(msisdn);
    const agentCode = agent.agentCode;
    // The duplicate guard and the claim run under one lock on (agent, phone, amount), so two
    // concurrent requests with different keys cannot both pass the guard and prompt twice.
    const guarded = await withTransaction(this.db, async (tx) => {
      await lockDuplicateGuard(tx, agent.agentId, phoneHash, amount);
      if (!confirmDuplicate) {
        const phoneHashes = [phoneHash, ...alternateKeyedHashes('counterparty', `msisdn:${msisdn}`)];
        const dup = await hasRecentDuplicate(tx, {
          agentId: agent.agentId,
          phoneHashes,
          amount,
          idempotencyKey: key,
          windowMs: this.config.duplicateWindowMs,
        });
        if (dup) return 'duplicate' as const;
      }
      return claimStkRequest(tx, {
        agentId: agent.agentId,
        idempotencyKey: key,
        fingerprint: keyedHash('stk_fingerprint', fpInput),
        phoneHash,
        amount,
        accountReference: agentCode,
      });
    });
    if (guarded === 'duplicate') {
      this.metrics.stk.possibleDuplicate += 1;
      res.status(409).json({
        error: 'possible_duplicate',
        message: 'The same amount was requested from this customer in the last minute. Resend with confirm_duplicate: true to prompt again.',
      });
      return;
    }
    const claimed = guarded;
    if (!claimed) {
      // A concurrent request with the same key won the claim: answer with its outcome.
      const row = await findByIdempotencyKey(this.db, agent.agentId, key);
      if (!row) throw new Error('idempotency claim conflict without a visible row');
      return this.replay(res, row, fpInput);
    }

    const outcome = await this.daraja.stkPush({ amount, phone: msisdn, accountReference: agent.agentCode });
    this.metrics.stk[outcome.kind] += 1;
    let row: StkRow | null = null;
    try {
      row = (await recordStkOutcome(this.db, claimed.stkRequestId, outcome)) ?? (await findStkById(this.db, claimed.stkRequestId));
    } catch (error) {
      // The row stays PENDING; a replay (or the worker's fallback) turns it UNKNOWN later.
      console.error(`[Payments] could not record the STK outcome for ${claimed.stkRequestId}:`, (error as Error).message);
    }
    this.reply(res, row ?? claimed);
  }

  /** GET /api/v1/payments/stk/:id — the agent's own request only (404 otherwise). */
  public async status(req: Request, res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.id ?? '');
    const agent = UUID_RE.test(id) ? await findAgentForUser(this.db, req.auth!.userId) : null;
    const row = agent && !agent.userDisabled ? await findStkById(this.db, id) : null;
    if (!row || row.agentId !== agent!.agentId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({
      stk_request_id: row.stkRequestId,
      status: row.status,
      checkout_request_id: row.checkoutRequestId,
      result_code: row.resultCode,
      customer_message: row.customerMessage,
    });
  }

  /**
   * Same key again: the original outcome (latest status), never a second prompt. Only a
   * fingerprint that provably differs is a reuse; one made under a PII key no longer configured
   * (unverifiable, null) is treated as a match and the stored outcome is returned.
   */
  private async replay(res: Response, row: StkRow, fpInput: string): Promise<void> {
    const same = row.requestFingerprint ? keyedHashMatches(row.requestFingerprint, 'stk_fingerprint', fpInput) : null;
    if (same === false) {
      res.status(409).json({ error: 'idempotency_key_reused', message: 'This Idempotency-Key was used for a different request.' });
      return;
    }
    this.metrics.stk.replayed += 1;
    // Derived from the overall Daraja deadline: the waiter outlasts the claimant's whole stkPush().
    const staleMs = this.config.stalePendingMs;
    const deadline = Date.now() + this.config.waiterTimeoutMs;
    let current: StkRow | null = row;
    while (current && current.status === 'PENDING') {
      if ((current.pendingAgeMs ?? 0) > staleMs) {
        current = (await expireStalePending(this.db, current.stkRequestId, staleMs)) ?? (await findStkById(this.db, current.stkRequestId));
        continue;
      }
      if (Date.now() >= deadline) {
        const retryAfter = Math.max(1, Math.ceil((staleMs - (current.pendingAgeMs ?? 0)) / 1000));
        res.set('Retry-After', String(Math.min(retryAfter, 30)));
        res.status(409).json({ error: 'idempotency_in_progress' });
        return;
      }
      await sleep(this.config.pollIntervalMs);
      current = await findStkById(this.db, current.stkRequestId);
    }
    this.reply(res, current ?? row);
  }

  private reply(res: Response, row: StkRow): void {
    const base = { stk_request_id: row.stkRequestId, status: row.status };
    switch (row.status) {
      case 'ACCEPTED':
        res.status(201).json({ ...base, checkout_request_id: row.checkoutRequestId, customer_message: row.customerMessage });
        return;
      case 'FAILED':
        // Accepted by Daraja, then not completed by the customer (latest status of the request).
        res.status(201).json({ ...base, checkout_request_id: row.checkoutRequestId, result_code: row.resultCode, customer_message: row.customerMessage });
        return;
      case 'REJECTED':
        res.status(502).json({ ...base, error: 'stk_rejected', code: row.responseCode, message: 'M-Pesa did not accept the payment request. No prompt was sent; try again.' });
        return;
      case 'EXPIRED':
        res.status(200).json({ ...base, message: 'No M-Pesa confirmation was received for this request. Check with the customer before resending.' });
        return;
      default:
        // UNKNOWN (or PENDING when the outcome could not be recorded): never retried automatically.
        res.status(202).json({ ...base, status: 'UNKNOWN', message: 'Pending confirmation: the payment will be matched when M-Pesa confirms it. Do not resend.' });
    }
  }
}
