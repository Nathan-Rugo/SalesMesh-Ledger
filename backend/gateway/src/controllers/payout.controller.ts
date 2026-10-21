/**
 * @file payout.controller.ts
 * @description /api/v1/payouts (spec gh-11, part 2) — HTTP mapping only; the flow lives in
 * services/payout.service.ts. Phones are always masked in responses; names never appear.
 *
 *   GET  /                               → 200 {balance, destination, disclosure, payouts, accruals, pending_count, pending_cents, remitted}
 *   POST /claim {pin, disclosure_version} → 202 {payout: SENT | UNKNOWN} | 502 FAILED | 503 not sent | 409 refused
 */

import type { Request, Response } from 'express';
import { maskMsisdn } from '../domain/payout_destination';
import type { PayoutRow } from '../repositories/payout.repository';
import { PayoutService, payoutService } from '../services/payout.service';
import { client, common, pinOf } from './payout_destination.controller';

const view = (p: PayoutRow) => ({
  payout_id: p.payoutId,
  status: p.status,
  amount: p.amount,
  msisdn: maskMsisdn(p.msisdn),
  receipt: p.receipt,
  failure_reason: p.failureReason,
  disclosure_version: p.disclosureVersion,
  consent_hash: p.consentHash,
  created_at: p.createdAt.toISOString(),
  resolved_at: p.resolvedAt?.toISOString() ?? null,
});

export class PayoutController {
  constructor(private readonly service: PayoutService = payoutService) {}

  async list(req: Request, res: Response): Promise<void> {
    const r = await this.service.claimable(req.auth!.userId);
    if (common(res, r.kind) || r.kind !== 'ok') return;
    const cfg = this.service.config();
    res.status(200).json({
      balance: {
        amount: Math.floor(r.balance.cents / 100),
        cents: r.balance.cents,
        escrows: r.balance.escrows,
        carry_cents: r.balance.carryCents,
        payable_now: r.balance.payableNow,
        min_amount: cfg.minAmount,
        max_amount: cfg.maxAmount,
      },
      destination: r.destination,
      destination_changing: r.destinationChanging,
      disclosure: r.disclosure,
      payouts: r.payouts.map(view),
      accruals: r.accruals.map((a) => ({
        escrow_id: a.escrowId,
        amount_cents: a.cents,
        status: a.status,
        release_due_at: a.releaseDueAt.toISOString(),
        quarantine_reason: a.quarantineReason,
      })),
      pending_count: r.pendingCount,
      pending_cents: r.pendingCents,
      remitted: r.remitted.map((x) => ({
        amount: x.cents / 100,
        period_end: x.periodEnd,
        reference: x.reference,
        holder_reference: x.holderReference,
        note: x.reference
          ? 'Transferred to the Unclaimed Financial Assets Authority: claim from UFAA.'
          : 'Being transferred to the Unclaimed Financial Assets Authority (UFAA).',
      })),
    });
  }

  async claim(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = await this.service.claim(req.auth!.userId, pinOf(req), body.disclosure_version, client(req));
    switch (r.kind) {
      case 'disclosure_changed':
        res.status(409).json({ error: 'disclosure_changed', disclosure: this.service.disclosure() });
        return;
      case 'payout_in_progress':
      case 'no_active_destination':
      case 'destination_changing':
      case 'above_maximum':
        res.status(409).json({ error: r.kind });
        return;
      case 'below_minimum':
        res.status(409).json({ error: 'below_minimum', amount: r.amount, min_amount: this.service.config().minAmount });
        return;
      case 'claimed':
        if (r.payout.status !== 'FAILED') res.status(202).json({ payout: view(r.payout) });
        // ledger_auditor_hold: the ledger refused because the auditor holds part of the balance; those escrows
        // were mirrored out of the balance, so the agent can claim the rest now.
        else if (r.payout.failureReason === 'ledger_auditor_hold') res.status(409).json({ error: 'balance_under_review', payout: view(r.payout) });
        // not_sent: B2C unreachable; ledger_*: the AuthorisePayout gate failed closed (nothing was sent).
        else if (r.payout.failureReason === 'not_sent' || r.payout.failureReason?.startsWith('ledger_')) res.status(503).json({ error: 'temporarily_unavailable', payout: view(r.payout) });
        else res.status(502).json({ error: 'payout_failed', payout: view(r.payout) });
        return;
      default:
        common(res, r.kind, 'retryAfterS' in r ? r.retryAfterS : null);
    }
  }
}
