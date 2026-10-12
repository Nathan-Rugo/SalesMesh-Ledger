/**
 * @file webhook.controller.ts
 * @description Safaricom M-Pesa Daraja Callback Ingestion Controller (the hot path).
 *
 * Thesis Requirements Addressed:
 *   NFR-01 — Sub-200ms Ingestion SLA: validate → hash → Redis claim → intake insert → ACK.
 *            Claim + insert share one ~150 ms deadline on a separately sized hot pool; all
 *            settlement (agent resolution, ML, escrow) happens in the settlement worker.
 *   FR-02  — Atomic Deduplication: Redis SET NX is the fast path; Postgres
 *            (mpesa_callbacks UNIQUE receipt) is the source of truth.
 *   UC-01  — The non-duplicate payload is durable (PENDING) BEFORE the 200. If Postgres is
 *            down or slow, the gateway answers 503 so Daraja retries, and spools the redacted
 *            payload to Redis as a safety net.
 *   Sec 2.2.3 — Keyed hash of the raw bytes as received, stored for tamper-evidence;
 *            a mutated retry raises a persisted security alarm and keeps the original. The
 *            same receipt and amount on the other channel (STK callback + C2B confirmation of
 *            one payment) is recorded as a cross-channel echo instead (audit row, no hold).
 *   gh-5   — A failed STK callback (ResultCode != 0) marks its stk_requests row FAILED with the
 *            code (no intake row, no settlement); 503 when that cannot be recorded.
 *   gh-6-recon — A genuine callback for a receipt recovered from an M-Pesa statement (RECONCILED
 *            intake row) is checked BEFORE the channel-echo check: it confirms the row
 *            (RECONCILED_CALLBACK_LATE, 200, escrow untouched) only on positive attribution
 *            (STK: its CheckoutRequestID's request belongs to the recovered row's agent; C2B: same
 *            account) and no phone contradiction; a different amount is a PAYLOAD_MUTATION, any
 *            other difference a RECONCILE_ATTRIBUTION_CONFLICT. Confirmation is atomic: of two
 *            different concurrent deliveries one confirms, the other is a mutation.
 *   Kenya DPA 2019 — payloads are redacted before storage and never logged.
 */

import { Request, Response } from 'express';
import { field } from '../domain/unknown';
import { hotPool, HOT_PATH_TIMEOUT_MS } from '../config/db';
import { KEYED_HASH_RE, keyedHashMatches } from '../config/pii';
import {
  callbackIdentity,
  extractIngress,
  isPhoneLike,
  normaliseAgentCode,
  parseStoredCallback,
  payloadShape,
  phoneHashVerdict,
  plainMsisdn,
  redactPayload,
  toCents,
  type SourceChannel,
} from '../domain/callback';
import { consumeStkRequest, findAgentByCode, findStkAttribution, type StkAttribution } from '../repositories/agent.repository';
import { withTransaction } from '../repositories/db.types';
import {
  bindReconciledRow,
  confirmReconciledByCallback,
  findIntakeSummary,
  findStoredIdentity,
  insertIntake,
  isChannelEcho,
  type StoredIntakeIdentity,
} from '../repositories/intake.repository';
import { insertSecurityEvent, recordChannelEcho, recordPayloadMutation, recordReceiptHold } from '../repositories/security.repository';
import { markStkFailed } from '../repositories/stk.repository';
import { metrics } from '../services/metrics.service';
import { idempotencyService } from '../services/idempotency.service';
import { spoolService } from '../services/spool.service';
import { settlementWorker } from '../workers/settlement.worker';
import { parseB2cResult } from '../daraja/client';
import { payoutDestinationService } from '../services/payout_destination.service';

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' } as const;
const RETRY_LATER = { ResultCode: 1, ResultDesc: 'Temporarily unavailable; retry' } as const;

class DeadlineExceeded extends Error {}

/** Resolves with `promise`, or rejects once the absolute `deadline` (epoch ms) passes. */
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    promise.catch(() => undefined);
    return Promise.reject(new DeadlineExceeded('hot-path deadline exceeded'));
  }
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded('hot-path deadline exceeded')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Same payload? Compared under whichever configured key made the stored hash (key rotation). */
function samePayload(storedHash: string, incomingHash: string, rawBytes: Buffer): boolean {
  if (storedHash === incomingHash) return true;
  // null: made with a key no longer configured — cannot verify, so fail closed (alarm).
  return keyedHashMatches(storedHash, 'payload', rawBytes) === true;
}

/** The account (agent code, or its HMAC when phone-like) a statement-recovered row was paid to. */
function reconciledAccount(payload: unknown): string | null {
  const v = field(payload, 'Reconciliation', 'accountNo') ?? field(payload, 'BillRefNumber');
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A C2B BillRefNumber equals the stored account: normalised, or under the same HMAC when it was phone-like. */
function billRefMatches(stored: string | null, incoming: string | null): boolean {
  if (!stored || !incoming) return false;
  if (KEYED_HASH_RE.test(stored)) return keyedHashMatches(stored, 'counterparty', `billref:${incoming.replace(/[\s+()-]/g, '')}`) === true;
  return normaliseAgentCode(stored) === normaliseAgentCode(incoming);
}

/**
 * WebhookController
 * Handles incoming Daraja STK Push and C2B callback payloads.
 */
class WebhookController {
  /**
   * Primary handler bound to POST /api/v1/mpesa/callback/:token (STK callback and C2B confirmation).
   */
  public async handleMpesaCallback(req: Request, res: Response): Promise<void> {
    const startNs = process.hrtime.bigint();
    const ack = () => {
      if (!res.headersSent) res.status(200).json(ACK);
    };
    const retryLater = () => {
      if (!res.headersSent) res.status(503).json(RETRY_LATER);
    };
    const body = req.body;

    // ── STEP 1 — EXTRACT & VALIDATE ─────────────────────────────────────
    const ingress = extractIngress(body);
    if (ingress.kind === 'drop') {
      if (ingress.stkFailure) {
        const f = ingress.stkFailure;
        try {
          const n = await withDeadline(
            markStkFailed(hotPool, f.checkoutRequestId, f.resultCode, f.resultDesc),
            Date.now() + HOT_PATH_TIMEOUT_MS
          );
          if (n > 0) metrics.stkCallbacksFailed.recorded += 1;
          else metrics.stkCallbacksFailed.unmatched += 1;
          console.info(`[Webhook] STK Push not completed (${ingress.reason}); ${n > 0 ? 'request marked FAILED' : 'no matching STK request'} — ACK.`);
        } catch (error) {
          console.error(`[Webhook] could not record the failed STK push (${(error as Error).message}) — 503.`);
          retryLater();
          return;
        }
      } else if (ingress.reason.startsWith('stk_result_')) {
        console.info(`[Webhook] STK Push not completed (${ingress.reason}) — ACK and drop.`);
      } else {
        // Malformed — ACK to prevent a retry storm; nothing here can ever settle.
        console.warn(`[Webhook] ${ingress.reason} payload (${payloadShape(body)}) — ACK and drop.`);
      }
      ack();
      return;
    }
    const { receipt, channel, amountCents } = ingress;

    // ── STEP 2 — KEYED HASH OF THE BYTES AS RECEIVED ────────────────────
    const rawBytes: Buffer = req.rawBody ?? Buffer.from(JSON.stringify(body), 'utf-8');
    let hash: string;
    let redacted: unknown;
    try {
      hash = idempotencyService.hashPayload(rawBytes);
      redacted = redactPayload(body);
    } catch (error) {
      console.error('[Webhook] cannot hash payload (PII_HMAC_KEY):', (error as Error).message);
      retryLater();
      return;
    }

    const deadline = Date.now() + HOT_PATH_TIMEOUT_MS;
    try {
      // ── STEP 3 — REDIS FAST PATH (FR-02) ──────────────────────────────
      const claim = await withDeadline(idempotencyService.claim(receipt, hash), deadline).catch(
        () => ({ kind: 'unverified' }) as const
      );
      // Only a STORED claim may short-circuit; anything else must reach Postgres, because the
      // first attempt may never have been stored (a PENDING claim proves nothing durable).
      let redisMismatch: string | null = null;
      if (claim.kind === 'existing') {
        const same = samePayload(claim.storedHash, hash, rawBytes);
        if (claim.stored) {
          if (same) console.info(`[Webhook] Duplicate for receipt ${receipt} already stored — ACK.`);
          else await this.conflict(receipt, claim.storedHash, hash, { channel, amountCents, body, rawBytes }, 'redis', deadline);
          ack();
          return;
        }
        if (!same) redisMismatch = claim.storedHash;
      }

      // ── STEP 4 — DURABLE INTAKE (Postgres, ON CONFLICT) ─────────────────
      const result = await withDeadline(
        insertIntake(hotPool, { receipt, hash, channel, payload: redacted }),
        deadline
      );
      if (result.outcome === 'existing' && !samePayload(result.storedHash, hash, rawBytes)) {
        await this.conflict(receipt, result.storedHash, hash, { channel, amountCents, body, rawBytes }, 'postgres', deadline);
        ack();
        return;
      }
      if (result.outcome === 'inserted' && redisMismatch) {
        // Stored now, but an earlier attempt with different bytes was claimed: security hold.
        await this.mutation(receipt, redisMismatch, hash, 'redis', deadline);
        ack();
        settlementWorker.wake();
        return;
      }
      const storedHash = result.outcome === 'existing' ? result.storedHash : hash;

      // ── STEP 5 — ACK, then mark STORED and wake the worker ─────────────
      ack();
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      if (elapsedMs > 50) console.warn(`[SLA] Hot path exceeded 50 ms budget: ${elapsedMs.toFixed(2)} ms`);
      else console.info(`[Webhook] ${result.outcome === 'inserted' ? 'Stored' : 'Re-confirmed'} ${receipt}; ACK in ${elapsedMs.toFixed(2)} ms`);
      void idempotencyService.markStored(receipt, storedHash);
      if (result.outcome === 'inserted') settlementWorker.wake();
    } catch (error) {
      // Nothing durable (or the alarm could not be persisted): 503 so Daraja retries.
      console.error(`[Webhook] intake for ${receipt} failed (${(error as Error).message}) — 503, spooling.`);
      retryLater();
      await this.spool(receipt, hash, channel, redacted);
    }
  }

  /**
   * Same receipt, different bytes, intake row exists: a cross-channel echo (other channel, same
   * amount: audit row only) or a payload mutation (alarm + security hold). The original is kept.
   */
  private async conflict(
    receipt: string,
    storedHash: string,
    incomingHash: string,
    incoming: { channel: SourceChannel; amountCents: number; body: unknown; rawBytes: Buffer },
    source: string,
    deadline: number
  ): Promise<void> {
    // A receipt recovered from the statement: checked before the channel-echo check.
    const identity = await withDeadline(findStoredIdentity(hotPool, receipt), deadline);
    if (identity?.origin === 'RECONCILED') {
      await this.lateCallback(receipt, identity, incomingHash, incoming, deadline);
      return;
    }
    const stored = await withDeadline(findIntakeSummary(hotPool, receipt), deadline);
    if (stored && isChannelEcho(stored, incoming)) {
      console.warn(`[Webhook] Receipt ${receipt} delivered on both STK and C2B (same amount) — cross-channel echo recorded, no settlement.`);
      const detail = `${stored.channel} intake echoed by ${incoming.channel} (${source})`;
      await withDeadline(recordChannelEcho(hotPool, receipt, storedHash, incomingHash, detail), deadline);
      return;
    }
    await this.mutation(receipt, storedHash, incomingHash, source, deadline);
  }

  /**
   * The genuine callback for a statement-recovered receipt. Confirms the RECONCILED row only when
   * amount, channel, CheckoutRequestID / agent and the phone HMAC (when stored) all match; never
   * changes escrow. Later deliveries are compared against the confirmed callback's hash.
   */
  private async lateCallback(
    receipt: string,
    identity: StoredIntakeIdentity,
    incomingHash: string,
    incoming: { channel: SourceChannel; amountCents: number; body: unknown; rawBytes: Buffer },
    deadline: number
  ): Promise<void> {
    const storedIngress = extractIngress(identity.payload);
    const storedCents = storedIngress.kind === 'ok' ? storedIngress.amountCents : null;
    if (identity.confirmedHash) {
      if (samePayload(identity.confirmedHash, incomingHash, incoming.rawBytes)) {
        console.info(`[Webhook] Late callback for recovered receipt ${receipt} already confirmed — ACK.`);
        void idempotencyService.markStored(receipt, identity.confirmedHash);
        return;
      }
      if (isChannelEcho({ channel: identity.channel, amountCents: storedCents }, incoming)) {
        await withDeadline(recordChannelEcho(hotPool, receipt, identity.confirmedHash, incomingHash, `${identity.channel} recovered row echoed by ${incoming.channel}`), deadline);
        return;
      }
      await this.mutation(receipt, identity.confirmedHash, incomingHash, 'late-callback', deadline);
      return;
    }
    // A different amount is a mutation, never a late confirmation.
    if (storedCents !== incoming.amountCents) {
      await this.mutation(receipt, identity.rawPayloadHash, incomingHash, 'late-callback', deadline);
      return;
    }

    // Confirm only on positive attribution evidence; anything else is a conflict (+ hold).
    const id = callbackIdentity(incoming.body);
    const storedAccount = reconciledAccount(identity.payload);
    const differs: string[] = [];
    let request: StkAttribution | null = null; // the request this genuine callback belongs to
    if (incoming.channel === 'DARAJA_STK') {
      request = id.checkoutRequestId ? await withDeadline(findStkAttribution(hotPool, { checkoutRequestId: id.checkoutRequestId }), deadline) : null;
      if (!request && identity.stkRequestId) {
        // Daraja's answer to the initiation was lost (UNKNOWN): the bound request has no CheckoutRequestID.
        // Accepted only if that request is unbound to any id and its customer phone positively matches.
        const bound = await withDeadline(findStkAttribution(hotPool, { stkRequestId: identity.stkRequestId }), deadline);
        const msisdn = plainMsisdn(id.phoneRaw);
        if (bound && !bound.checkoutRequestId && bound.phoneHash && msisdn && phoneHashVerdict(bound.phoneHash, 'counterparty', msisdn) === true) request = bound;
      }
      if (!request) differs.push('CheckoutRequestID not on file');
      else {
        if (identity.stkRequestId && request.stkRequestId !== identity.stkRequestId) differs.push('CheckoutRequestID of another request');
        if (request.consumedReceipt && request.consumedReceipt !== receipt) differs.push('request consumed by another receipt');
        if (!storedAccount || !request.agentCode || normaliseAgentCode(storedAccount) !== request.agentCode) differs.push('agent');
      }
    } else if (!billRefMatches(storedAccount, id.billRefNumber)) differs.push('account');

    // Phone: the recovered row's own full phone, else the bound request's phone / masked fingerprint.
    // Masked, provider-hashed or retired-key values cannot be compared and never count as a mismatch.
    const msisdn = plainMsisdn(id.phoneRaw);
    if (msisdn && differs.length === 0) {
      let storedPhone: string | null = null;
      try {
        storedPhone = parseStoredCallback(identity.payload).counterpartyHash;
      } catch {
        storedPhone = null;
      }
      const req = request ?? (identity.stkRequestId ? await withDeadline(findStkAttribution(hotPool, { stkRequestId: identity.stkRequestId }), deadline) : null);
      const verdict = storedPhone
        ? phoneHashVerdict(storedPhone, 'counterparty', msisdn)
        : req?.phoneHash
          ? phoneHashVerdict(req.phoneHash, 'counterparty', msisdn)
          : req?.phoneMaskHash
            ? phoneHashVerdict(req.phoneMaskHash, 'phone_mask', msisdn)
            : null;
      if (verdict === false) differs.push('phone');
    }

    if (differs.length > 0) {
      console.error(`[SECURITY ALARM] Late callback for recovered receipt ${receipt} not attributable (${differs.join(', ')}) — conflict.`);
      await withDeadline(
        recordReceiptHold(hotPool, {
          type: 'RECONCILE_ATTRIBUTION_CONFLICT',
          receipt,
          originalHash: identity.rawPayloadHash,
          incomingHash,
          detail: `late genuine callback not attributable to the statement-recovered row: ${differs.join(', ')}`,
        }),
        deadline
      );
      return;
    }

    const won = await withDeadline(
      withTransaction(hotPool, async (tx) => {
        const confirmed = await confirmReconciledByCallback(tx, receipt, incomingHash);
        if (confirmed !== incomingHash) return confirmed; // another delivery confirmed first
        if (request && !identity.stkRequestId) {
          // The import could not bind it (ambiguous); the genuine callback proves the request.
          if (!(await consumeStkRequest(tx, request.stkRequestId, receipt))) throw new Error('request consumed meanwhile');
          await bindReconciledRow(tx, receipt, request.stkRequestId);
        }
        await insertSecurityEvent(tx, {
          type: 'RECONCILED_CALLBACK_LATE',
          receipt,
          originalHash: identity.rawPayloadHash,
          incomingHash,
          detail: 'genuine callback arrived after the payment was recovered from the statement; attribution verified, row confirmed',
        });
        if (request && (request.status === 'FAILED' || request.status === 'REJECTED')) {
          await insertSecurityEvent(tx, {
            type: 'STK_STATUS_CONFLICT',
            receipt,
            originalHash: identity.rawPayloadHash,
            incomingHash,
            detail: `genuine paid callback for an STK request recorded ${request.status}`,
            stkRequestId: request.stkRequestId,
          });
        }
        return confirmed;
      }),
      deadline
    );
    if (won !== incomingHash) {
      if (won && samePayload(won, incomingHash, incoming.rawBytes)) return;
      await this.mutation(receipt, won ?? identity.rawPayloadHash, incomingHash, 'late-callback', deadline);
      return;
    }
    console.info(`[Webhook] Late genuine callback confirms recovered receipt ${receipt} — ACK (escrow unchanged).`);
    void idempotencyService.markStored(receipt, incomingHash);
  }

  /** Same receipt, different bytes: persist the alarm (escrow → QUARANTINED) and keep the original. */
  private async mutation(
    receipt: string,
    storedHash: string,
    incomingHash: string,
    source: string,
    deadline: number
  ): Promise<void> {
    console.error(`[SECURITY ALARM] Payload mutation on receipt ${receipt} (${source}) — stored hash differs from incoming hash!`);
    await withDeadline(recordPayloadMutation(hotPool, receipt, storedHash, incomingHash), deadline);
  }

  private async spool(receipt: string, hash: string, channel: SourceChannel, payload: unknown): Promise<void> {
    await spoolService.spool({ receipt, hash, channel, payload, receivedAt: new Date().toISOString() });
  }

  /**
   * POST /api/v1/mpesa/b2c/result/:token — the result of a payout-destination verification
   * (spec gh-11). Applied at most once; unknown or repeated results are ACKed. 503 (Daraja
   * retries) only when the result could not be recorded. The registered name is never logged.
   */
  public async handleB2cResult(req: Request, res: Response): Promise<void> {
    const result = parseB2cResult(req.body);
    if (!result) {
      console.warn(`[Webhook] B2C result unparseable (${payloadShape(req.body)}) — ACK and drop.`);
      res.status(200).json(ACK);
      return;
    }
    try {
      const outcome = await payoutDestinationService.applyResult(result);
      if (outcome.kind !== 'applied') console.info(`[Webhook] B2C result ${outcome.kind} (ResultCode ${result.resultCode}) — ACK.`);
      res.status(200).json(ACK);
    } catch (error) {
      console.error(`[Webhook] could not apply the B2C result (${(error as Error).message}) — 503.`);
      if (!res.headersSent) res.status(503).json(RETRY_LATER);
    }
  }

  /**
   * POST /api/v1/mpesa/b2c/timeout/:token — Daraja's queue timeout. Logged and ACKed only: the
   * row stays PENDING_VERIFICATION until a result arrives or the expiry sweep (never a resend).
   */
  public handleB2cTimeout(req: Request, res: Response): void {
    const id = field(req.body, 'Result', 'OriginatorConversationID');
    console.warn(`[Webhook] B2C queue timeout for ${typeof id === 'string' ? id.slice(0, 64) : 'an unknown request'} — ACK.`);
    res.status(200).json(ACK);
  }

  /**
   * POST /api/v1/mpesa/c2b/validation/:token — Daraja C2B validation (before money moves).
   * Never writes intake. Rejects unknown agent codes with C2B00012 and bad amounts with
   * C2B00013; fails closed (C2B00016) when the agent lookup cannot complete in time.
   */
  public async handleC2BValidation(req: Request, res: Response): Promise<void> {
    const body = req.body ?? {};
    const reply = (ResultCode: string, ResultDesc: string) => {
      if (!res.headersSent) res.status(200).json({ ResultCode, ResultDesc });
    };
    if (toCents(body.TransAmount) === null) {
      reply('C2B00013', 'Rejected');
      return;
    }
    const code = normaliseAgentCode(body.BillRefNumber);
    // A phone-like account number is redacted before storage, so it could never resolve.
    if (!code || isPhoneLike(body.BillRefNumber)) {
      reply('C2B00012', 'Rejected');
      return;
    }
    try {
      const agentId = await withDeadline(findAgentByCode(hotPool, code), Date.now() + HOT_PATH_TIMEOUT_MS);
      if (!agentId) {
        console.info('[Webhook] C2B validation rejected: unknown agent code');
        reply('C2B00012', 'Rejected');
        return;
      }
      reply('0', 'Accepted');
    } catch (error) {
      console.error('[Webhook] C2B validation lookup failed — rejecting (fail closed):', (error as Error).message);
      reply('C2B00016', 'Rejected');
    }
  }
}

/** Singleton controller instance */
export const webhookController = new WebhookController();
export default webhookController;
