/**
 * @file admin.controller.ts
 * @description /api/v1/admin (spec gh-11, part 3c) — HTTP mapping only. Read-only: release, reject
 * and override actions belong to the risk-oversight queue (#14). Phones are always masked.
 *
 *   GET /frozen-payouts → 200 {sla, totals, escrows[], payouts[]} (overdue first, then oldest first)
 */

import type { Request, Response } from 'express';
import { maskMsisdn } from '../domain/payout_destination';
import { FrozenPayoutService, frozenPayoutService } from '../services/frozen.service';

export class AdminController {
  constructor(private readonly frozen: FrozenPayoutService = frozenPayoutService) {}

  async frozenPayouts(_req: Request, res: Response): Promise<void> {
    const r = await this.frozen.list();
    res.status(200).json({
      sla: { escrow_hours: r.sla.escrowHours, payout_hours: r.sla.payoutHours },
      totals: r.totals,
      escrows: r.escrows.map((e) => ({
        escrow_id: e.escrowId,
        agent_code: e.agentCode,
        agent_name: e.agentName,
        amount: e.cents / 100,
        quarantine_reason: e.quarantineReason,
        security_hold: e.securityHold,
        ufaa_frozen: e.ufaaFrozen,
        receipt: e.receipt,
        frozen_at: e.frozenAt.toISOString(),
        escalated_at: e.escalatedAt?.toISOString() ?? null,
        overdue: e.overdue,
      })),
      payouts: r.payouts.map((p) => ({
        payout_id: p.payoutId,
        agent_code: p.agentCode,
        agent_name: p.agentName,
        amount: p.amount,
        msisdn: maskMsisdn(p.msisdn),
        unresolved_at: p.unresolvedAt?.toISOString() ?? null,
        escalated_at: p.escalatedAt?.toISOString() ?? null,
        overdue: p.overdue,
      })),
    });
  }
}
