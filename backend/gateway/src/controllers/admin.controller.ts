/**
 * @file admin.controller.ts
 * @description /api/v1/admin (spec gh-11 part 3c, gh-14) — HTTP mapping only. Phones are always masked.
 *
 *   GET  /frozen-payouts             → 200 {sla, totals, overdue, total_available, escrows[], payouts[]} (overdue first, then oldest)
 *   GET  /agents                     -> 200 {agents:[{agent_code, full_name, msisdn (masked), activated, disabled, payout: {status, msisdn (masked)}|null}]}
 *   POST /escrows/:id/release {pin, note}               → 200 {escrow} | 409 already_decided | security_hold | 404
 *   POST /escrows/:id/keep    {pin, note}               → 200 {escrow} | 409 already_decided | security_hold | 404
 *   POST /payouts/:id/resolve {pin, note, outcome: paid|failed, receipt?} → 200 {payout} | 409 not_unresolved | 404
 * Every override: 400 invalid_note / invalid_request before the PIN is checked; 401 invalid_credentials
 * (wrong PIN, a throttled attempt spent); 429 too_many_attempts. None of them moves money.
 */

import type { Request, Response } from 'express';
import pool from '../config/db';
import { listAgentDirectory } from '../repositories/agent.repository';
import type { Db } from '../repositories/db.types';
import { RECEIPT_RE } from '../domain/callback';
import { maskMsisdn } from '../domain/payout_destination';
import type { EscrowOverride } from '../repositories/frozen.repository';
import { FrozenPayoutService, frozenPayoutService } from '../services/frozen.service';
import { client, common, pinOf } from './payout_destination.controller';

const NOTE_MIN = 10;
const NOTE_MAX = 280;

/** The mandatory reason note, trimmed, 10–280 characters; null when missing or out of range. */
export function noteOf(req: Request): string | null {
  const note = ((req.body ?? {}) as Record<string, unknown>).note;
  if (typeof note !== 'string') return null;
  const t = note.trim();
  return t.length >= NOTE_MIN && t.length <= NOTE_MAX ? t : null;
}

export class AdminController {
  constructor(
    private readonly frozen: FrozenPayoutService = frozenPayoutService,
    private readonly db: Db = pool
  ) {}

  async agents(_req: Request, res: Response): Promise<void> {
    const rows = await listAgentDirectory(this.db);
    res.status(200).json({
      agents: rows.map((a) => ({
        agent_code: a.agentCode,
        full_name: a.fullName,
        msisdn: maskMsisdn(a.msisdn),
        activated: a.activated,
        disabled: a.disabled,
        payout: a.payout && { status: a.payout.status, msisdn: maskMsisdn(a.payout.msisdn) },
      })),
    });
  }

  async frozenPayouts(_req: Request, res: Response): Promise<void> {
    const r = await this.frozen.list();
    res.status(200).json({
      sla: { escrow_hours: r.sla.escrowHours, payout_hours: r.sla.payoutHours },
      totals: r.totals,
      overdue: r.overdue,
      total_available: r.totals.escrows + r.totals.payouts,
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
        reviewed_at: e.reviewedAt?.toISOString() ?? null,
        overdue: e.overdue,
        risk: e.risk && {
          decision: e.risk.decision,
          iso_score: e.risk.isoScore,
          xgb_prob: e.risk.xgbProb,
          model_version: e.risk.modelVersion,
          shap: e.risk.shap,
          units: e.risk.units,
        },
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

  async overrideEscrow(req: Request, res: Response, action: EscrowOverride): Promise<void> {
    const note = noteOf(req);
    if (!note) {
      res.status(400).json({ error: 'invalid_note' });
      return;
    }
    const r = await this.frozen.overrideEscrow(req.auth!.userId, String(req.params.id ?? ''), action, pinOf(req), note, client(req));
    switch (r.kind) {
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'security_hold':
      case 'already_decided':
        res.status(409).json({ error: r.kind });
        return;
      case 'done':
        res.status(200).json({
          escrow: {
            escrow_id: req.params.id,
            status: r.status,
            release_due_at: r.releaseDueAt.toISOString(),
            reviewed_at: r.reviewedAt?.toISOString() ?? null,
          },
        });
        return;
      default:
        common(res, r.kind, 'retryAfterS' in r ? r.retryAfterS : null);
    }
  }

  async resolvePayout(req: Request, res: Response): Promise<void> {
    const note = noteOf(req);
    if (!note) {
      res.status(400).json({ error: 'invalid_note' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const receipt = typeof body.receipt === 'string' ? body.receipt.trim().toUpperCase() : '';
    const o =
      body.outcome === 'failed'
        ? ({ paid: false } as const)
        : body.outcome === 'paid' && RECEIPT_RE.test(receipt)
          ? ({ paid: true, receipt } as const)
          : null;
    if (!o) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const r = await this.frozen.resolvePayout(req.auth!.userId, String(req.params.id ?? ''), o, pinOf(req), note, client(req));
    switch (r.kind) {
      case 'not_found':
        res.status(404).json({ error: 'not_found' });
        return;
      case 'not_unresolved':
        res.status(409).json({ error: 'not_unresolved', status: r.status });
        return;
      case 'resolved':
        res.status(200).json({
          payout: { payout_id: r.payout.payoutId, status: r.payout.status, amount: r.payout.amount, msisdn: maskMsisdn(r.payout.msisdn), receipt: r.payout.receipt },
        });
        return;
      default:
        common(res, r.kind, 'retryAfterS' in r ? r.retryAfterS : null);
    }
  }
}
