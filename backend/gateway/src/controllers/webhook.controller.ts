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
 *            a mutated retry raises a persisted security alarm and keeps the original.
 *   Kenya DPA 2019 — payloads are redacted before storage and never logged.
 */

import { Request, Response } from 'express';
import { hotPool, HOT_PATH_TIMEOUT_MS } from '../config/db';
import { keyedHashMatches } from '../config/pii';
import {
  extractIngress,
  isPhoneLike,
  normaliseAgentCode,
  payloadShape,
  redactPayload,
  toCents,
  type SourceChannel,
} from '../domain/callback';
import { findAgentByCode } from '../repositories/agent.repository';
import { insertIntake } from '../repositories/intake.repository';
import { recordPayloadMutation } from '../repositories/security.repository';
import { idempotencyService } from '../services/idempotency.service';
import { spoolService } from '../services/spool.service';
import { settlementWorker } from '../workers/settlement.worker';

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
      if (ingress.reason.startsWith('stk_result_')) {
        console.info(`[Webhook] STK Push not completed (${ingress.reason}) — ACK and drop.`);
      } else {
        // Malformed — ACK to prevent a retry storm; nothing here can ever settle.
        console.warn(`[Webhook] ${ingress.reason} payload (${payloadShape(body)}) — ACK and drop.`);
      }
      ack();
      return;
    }
    const { receipt, channel } = ingress;

    // ── STEP 2 — KEYED HASH OF THE BYTES AS RECEIVED ────────────────────
    const rawBytes: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(body), 'utf-8');
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
          else await this.mutation(receipt, claim.storedHash, hash, 'redis', deadline);
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
        await this.mutation(receipt, result.storedHash, hash, 'postgres', deadline);
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
