/**
 * @file payout_destination.controller.ts
 * @description /api/v1/payout-destinations (spec gh-11) — HTTP mapping only; the flow lives in
 * services/payout_destination.service.ts. Phones are always masked in responses; names never appear.
 *
 *   POST /        {pin}  → 202 PENDING_VERIFICATION (verification B2C requested) | 502 REJECTED | 503 not sent
 *   GET  /               → 200 {destinations, events}
 *   DELETE /:id   {pin}  → 200 CANCELLED (COOLING_OFF only)
 */

import type { Request, Response } from 'express';
import type { ClientInfo } from '../auth/auth.service';
import { maskMsisdn } from '../domain/payout_destination';
import type { DestinationRow } from '../repositories/payout_destination.repository';
import { PayoutDestinationService, payoutDestinationService } from '../services/payout_destination.service';

const view = (d: DestinationRow) => ({
  destination_id: d.destinationId,
  type: 'PERSONAL_MPESA',
  msisdn: maskMsisdn(d.msisdn),
  status: d.status,
  reject_reason: d.rejectReason,
  verified_at: d.verifiedAt?.toISOString() ?? null,
  cooling_off_until: d.coolingOffUntil?.toISOString() ?? null,
  created_at: d.createdAt.toISOString(),
});

const client = (req: Request): ClientInfo => ({ ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') ?? undefined, deviceCookie: undefined });
const pinOf = (req: Request): unknown => ((req.body ?? {}) as Record<string, unknown>).pin;

/** The answers shared by every route: agent problems and PIN confirmation failures. */
function common(res: Response, kind: string, retryAfterS: number | null = null): boolean {
  switch (kind) {
    case 'not_provisioned':
      res.status(409).json({ error: 'agent_not_provisioned' });
      return true;
    case 'disabled':
      res.status(403).json({ error: 'account_disabled' });
      return true;
    case 'invalid':
      res.status(401).json({ error: 'invalid_credentials' });
      return true;
    case 'throttled':
    case 'rate_limited':
      if (retryAfterS) res.set('Retry-After', String(retryAfterS));
      res.status(429).json({ error: kind === 'throttled' ? 'too_many_attempts' : 'rate_limited' });
      return true;
    case 'unavailable':
      res.status(503).json({ error: 'temporarily_unavailable' });
      return true;
    default:
      return false;
  }
}

export class PayoutDestinationController {
  constructor(private readonly service: PayoutDestinationService = payoutDestinationService) {}

  async register(req: Request, res: Response): Promise<void> {
    const r = await this.service.register(req.auth!.userId, pinOf(req), client(req));
    switch (r.kind) {
      case 'already_active':
        res.status(409).json({ error: 'already_active' });
        return;
      case 'pending':
        res.status(409).json({ error: 'destination_pending' });
        return;
      case 'phone_invalid':
        res.status(409).json({ error: 'phone_not_payable' });
        return;
      case 'sent':
        if (r.destination.status === 'REJECTED') res.status(502).json({ error: 'verification_failed', destination: view(r.destination) });
        else res.status(202).json({ destination: view(r.destination) });
        return;
      default:
        common(res, r.kind, 'retryAfterS' in r ? r.retryAfterS : null);
    }
  }

  async list(req: Request, res: Response): Promise<void> {
    const r = await this.service.list(req.auth!.userId);
    if (common(res, r.kind)) return;
    if (r.kind !== 'ok') return;
    res.status(200).json({
      destinations: r.destinations.map(view),
      events: r.events.map((e) => ({ detail: e.detail, detected_at: e.detectedAt.toISOString() })),
    });
  }

  async cancel(req: Request, res: Response): Promise<void> {
    const r = await this.service.cancel(req.auth!.userId, String(req.params.id ?? ''), pinOf(req), client(req));
    if (common(res, r.kind, 'retryAfterS' in r ? r.retryAfterS : null)) return;
    if (r.kind === 'not_found') res.status(404).json({ error: 'not_found' });
    else if (r.kind === 'not_cancellable') res.status(409).json({ error: 'not_cancellable' });
    else if (r.kind === 'cancelled') res.status(200).json({ destination: view(r.destination) });
  }
}
