import type { FrozenItem, OversightQueue, RiskRun, ShapContribution, UnresolvedPayout } from '../../domain/entities/oversight';

// Validators for GET /api/v1/admin/frozen-payouts (admin.controller.ts). Each returns null on any
// malformed field: the caller reports `unexpected`, never crashes.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const time = (v: unknown): number => (isStr(v) ? Date.parse(v) : NaN);
/** null stays null; a bad timestamp is undefined (malformed). */
const timeOrNull = (v: unknown): number | null | undefined => (v === null ? null : Number.isFinite(time(v)) ? time(v) : undefined);
/** KES as the gateway sends it (2 decimals at most) → integer cents, or null. */
const cents = (v: unknown): number | null => (isNum(v) && v >= 0 && Number.isSafeInteger(Math.round(v * 100)) ? Math.round(v * 100) : null);

function all<T>(v: unknown, f: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const m = f(x);
    if (m === null) return null;
    out.push(m);
  }
  return out;
}

export function toShap(v: unknown): ShapContribution | null {
  if (!isObj(v) || !isStr(v.feature) || !isNum(v.attribution) || !isNum(v.value)) return null;
  return { feature: v.feature, attribution: v.attribution, value: v.value };
}

export function toRiskRun(v: unknown): RiskRun | null {
  if (!isObj(v) || !isStr(v.decision) || !isStr(v.model_version) || !numOrNull(v.iso_score) || !numOrNull(v.xgb_prob)) return null;
  const shap = v.shap === null ? null : all(v.shap, toShap);
  if (shap === null && v.shap !== null) return null;
  return { decision: v.decision, isoScore: v.iso_score, xgbProb: v.xgb_prob, modelVersion: v.model_version, shap: shap && shap.length ? shap : null };
}

export function toFrozenItem(v: unknown): FrozenItem | null {
  if (!isObj(v)) return null;
  const amountCents = cents(v.amount);
  const frozenAt = time(v.frozen_at);
  const reviewedAt = timeOrNull(v.reviewed_at);
  const risk = v.risk === null ? null : toRiskRun(v.risk);
  if (!isStr(v.escrow_id) || !strOrNull(v.agent_code) || !isStr(v.agent_name) || amountCents === null || !strOrNull(v.quarantine_reason)) return null;
  if (typeof v.security_hold !== 'boolean' || !isStr(v.receipt) || !Number.isFinite(frozenAt) || reviewedAt === undefined || typeof v.overdue !== 'boolean') return null;
  if (risk === null && v.risk !== null) return null;
  return {
    id: v.escrow_id,
    agentCode: v.agent_code,
    agentName: v.agent_name,
    amountCents,
    reason: v.quarantine_reason,
    securityHold: v.security_hold,
    receipt: v.receipt,
    frozenAt,
    reviewedAt,
    overdue: v.overdue,
    risk,
  };
}

export function toUnresolvedPayout(v: unknown): UnresolvedPayout | null {
  if (!isObj(v)) return null;
  const amountCents = cents(v.amount);
  const unresolvedAt = timeOrNull(v.unresolved_at);
  if (!isStr(v.payout_id) || !strOrNull(v.agent_code) || !isStr(v.agent_name) || amountCents === null || !isStr(v.msisdn)) return null;
  if (unresolvedAt === undefined || typeof v.overdue !== 'boolean') return null;
  return { id: v.payout_id, agentCode: v.agent_code, agentName: v.agent_name, amountCents, msisdn: v.msisdn, unresolvedAt, overdue: v.overdue };
}

const pair = (v: unknown): { escrows: number; payouts: number } | null =>
  isObj(v) && isCount(v.escrows) && isCount(v.payouts) ? { escrows: v.escrows, payouts: v.payouts } : null;

/** GET /api/v1/admin/frozen-payouts. */
export function toOversightQueue(body: unknown): OversightQueue | null {
  if (!isObj(body) || !isObj(body.sla) || !isCount(body.sla.escrow_hours) || !isCount(body.sla.payout_hours)) return null;
  const totals = pair(body.totals);
  const overdue = pair(body.overdue);
  const escrows = all(body.escrows, toFrozenItem);
  const payouts = all(body.payouts, toUnresolvedPayout);
  if (!totals || !overdue || !escrows || !payouts) return null;
  return { slaHours: { escrow: body.sla.escrow_hours, payout: body.sla.payout_hours }, escrows, payouts, totals, overdue };
}
