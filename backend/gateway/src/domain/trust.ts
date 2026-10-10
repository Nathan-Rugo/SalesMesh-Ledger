/**
 * @file trust.ts
 * @description Risk-adaptive escrow hold (spec gh-23): the thesis trust index S_t (Message 7), the
 * hold T_hold (Message 8), the trust freeze (Message 14) and the outcome-based agent rating
 * (Table 4). Pure functions; every input is validated and anything out of range fails closed (null).
 *
 *   p_eff  = layer2 ? p_xgb : ½ · review_p · (s / fast_clear_s)      (isolation proxy, [0, 0.25))
 *   S_t    = (1 − p_eff)^w · R_eff^(1−w)
 *   T_hold = min(T_max, (T_min + (T_max − T_min)·(1 − S_t)^γ) · max(1, m)^κ)
 *   freeze = S_t ≤ TRUST_FREEZE_AT                                    (a model CLEAR is quarantined)
 *
 * p, R, m and S_t are rounded to 6 decimals BEFORE use (they are stored NUMERIC(7,6)), so a trust
 * row is recomputable from its stored columns and the freeze compares exactly what is stored.
 */

export const FORMULA_VERSION = 'gh23-v1';

/** Every quarantine waits the standard 72 h; T_hold never exceeds it. */
export const QUARANTINE_HOLD_HOURS = 72;
/** Upper bound on the amount factor m (keeps it inside NUMERIC(14,6); the hold is capped long before). */
export const MAX_AMOUNT_FACTOR = 1e6;

export interface TrustParams {
  /** w: weight of the transaction term (TRUST_TX_WEIGHT). */
  txWeight: number;
  holdMinHours: number;
  holdMaxHours: number;
  /** γ: convexity of the hold curve. */
  gamma: number;
  /** κ: amount-factor exponent. */
  kappa: number;
  /** β: moving-average credit step. */
  beta: number;
  /** Rating penalty per security-hold event. */
  penalty: number;
  /** ml-engine review_xgb_threshold and filter_isolation_threshold (mirrored, not changed). */
  reviewP: number;
  fastClearS: number;
  /** A model CLEAR with S_t at or below this is frozen (QUARANTINED). Default (1 − review_p)^w. */
  freezeAt: number;
  /** KES: the amount-factor denominator for agents with too little history. */
  referenceAmount: number;
  /** Settled payments in the median window needed to use the agent's own median. */
  minHistory: number;
  medianDays: number;
  /** R_eff = min(R, cap) until the agent is mature. */
  newAgentCap: number;
  matureHolds: number;
  matureDays: number;
  matureValue: number;
  maxCreditsPerDay: number;
}

export type PSource = 'xgb' | 'isolation_proxy';
export type HoldReason = 'transaction' | 'agent' | 'amount';

export interface AgentMaturity {
  cleanHolds: number;
  distinctDays: number;
  settledValue: number;
}

export interface TrustAssessment {
  pUsed: number;
  pSource: PSource;
  agentRatingUsed: number;
  amountFactor: number;
  trustIndex: number;
  holdSeconds: number;
  holdReason: HoldReason;
  frozen: boolean;
}

export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const isUnit = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** p_eff and its source, or null (fail closed) when the model output cannot give one. */
export function effectiveP(
  r: { layer2_adjudicated: boolean | null; xgb_probability: number | null; isolation_score: number | null },
  params: Pick<TrustParams, 'reviewP' | 'fastClearS'>
): { p: number; source: PSource } | null {
  if (r.layer2_adjudicated === true) return isUnit(r.xgb_probability) ? { p: round6(r.xgb_probability), source: 'xgb' } : null;
  if (r.layer2_adjudicated !== false || !isUnit(r.isolation_score)) return null;
  // Clamped into [0, ½·review_p) — [0, 0.25) by default — even when s ≥ fast_clear_s (out of cohort).
  const ceiling = round6(0.5 * params.reviewP - 1e-6);
  const p = Math.min(round6(0.5 * params.reviewP * (r.isolation_score / params.fastClearS)), ceiling);
  return isUnit(p) ? { p, source: 'isolation_proxy' } : null;
}

/** S_t, rounded to 6 decimals; null on a non-finite / out-of-range p or R. */
export function trustIndex(p: number, rating: number, w: number): number | null {
  if (!isUnit(p) || !isUnit(rating) || !(w > 0 && w <= 1)) return null;
  const s = round6((1 - p) ** w * rating ** (1 - w));
  return isUnit(s) ? s : null;
}

/** m = amount ÷ the agent's 30-day median, or ÷ the reference amount for agents with little history. */
export function amountFactor(amount: number, median: number | null, settledCount: number, params: Pick<TrustParams, 'referenceAmount' | 'minHistory'>): number {
  const base = settledCount >= params.minHistory && median !== null ? median : params.referenceAmount;
  return round6(Math.min(MAX_AMOUNT_FACTOR, amount / Math.max(1, base))); // median floored at KES 1
}

/** T_hold in whole seconds, and the term that dominated it. */
export function holdSeconds(
  s: number,
  m: number,
  p: number,
  rating: number,
  params: Pick<TrustParams, 'holdMinHours' | 'holdMaxHours' | 'gamma' | 'kappa' | 'txWeight'>
): { seconds: number; reason: HoldReason } {
  const { holdMinHours: tMin, holdMaxHours: tMax } = params;
  const base = tMin + (tMax - tMin) * (1 - s) ** params.gamma;
  const hours = Math.min(tMax, base * Math.max(1, m) ** params.kappa);
  // Dominant term: the amount when it added more than the risk did; otherwise the larger log-term of S_t.
  const txRisk = -params.txWeight * Math.log(1 - p);
  const agentRisk = -(1 - params.txWeight) * Math.log(rating);
  const reason: HoldReason = hours - base > base - tMin ? 'amount' : agentRisk > txRisk ? 'agent' : 'transaction';
  return { seconds: Math.round(hours * 3600), reason };
}

/** Credit: R ← R + β·(1 − R). */
export const ewma = (rating: number, beta: number): number => round6(rating + beta * (1 - rating));

/** Penalty: R ← max(0, R − penalty). */
export const penalise = (rating: number, penalty: number): number => round6(Math.max(0, rating - penalty));

/** R_eff = min(R, cap) until ≥ matureHolds clean matured holds over ≥ matureDays days and ≥ matureValue KES. */
export function effectiveRating(rating: number, m: AgentMaturity, params: Pick<TrustParams, 'newAgentCap' | 'matureHolds' | 'matureDays' | 'matureValue'>): number {
  const mature = m.cleanHolds >= params.matureHolds && m.distinctDays >= params.matureDays && m.settledValue >= params.matureValue;
  return round6(mature ? rating : Math.min(rating, params.newAgentCap));
}

/**
 * The whole assessment for one model-scored verification, or null (fail closed: no S_t, QUARANTINE).
 * `frozen` is only meaningful for a model CLEAR (the caller decides).
 */
export function assess(
  input: {
    risk: { layer2_adjudicated: boolean | null; xgb_probability: number | null; isolation_score: number | null };
    rating: number;
    maturity: AgentMaturity;
    amount: number;
    median: number | null;
    settledCount: number;
  },
  params: TrustParams
): TrustAssessment | null {
  const pe = effectiveP(input.risk, params);
  if (!pe || !isUnit(input.rating) || !(input.amount > 0)) return null;
  const rEff = effectiveRating(input.rating, input.maturity, params);
  const s = trustIndex(pe.p, rEff, params.txWeight);
  if (s === null) return null;
  const m = amountFactor(input.amount, input.median, input.settledCount, params);
  if (!Number.isFinite(m)) return null;
  const hold = holdSeconds(s, m, pe.p, rEff, params);
  return {
    pUsed: pe.p,
    pSource: pe.source,
    agentRatingUsed: rEff,
    amountFactor: m,
    trustIndex: s,
    holdSeconds: hold.seconds,
    holdReason: hold.reason,
    frozen: s <= params.freezeAt,
  };
}
