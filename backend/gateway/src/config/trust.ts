/**
 * @file trust.ts
 * @description Risk-adaptive hold / trust-score parameters (spec gh-23), from env, validated.
 * An invalid value refuses the start (preflight); see .env.example for the defaults.
 */

import crypto from 'crypto';
import { QUARANTINE_HOLD_HOURS, round6, type TrustParams } from '../domain/trust';

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}")`);
  return n;
}

/** Parses and validates the trust parameters; throws on an invalid configuration. */
export function trustConfig(env: NodeJS.ProcessEnv = process.env): TrustParams {
  const txWeight = num(env, 'TRUST_TX_WEIGHT', 0.7);
  const reviewP = num(env, 'TRUST_REVIEW_P', 0.5);
  const p: TrustParams = {
    txWeight,
    holdMinHours: num(env, 'TRUST_HOLD_MIN_HOURS', 1),
    holdMaxHours: num(env, 'TRUST_HOLD_MAX_HOURS', 72),
    gamma: num(env, 'TRUST_HOLD_GAMMA', 2),
    kappa: num(env, 'TRUST_AMOUNT_KAPPA', 1),
    beta: num(env, 'TRUST_CREDIT_BETA', 0.05),
    penalty: num(env, 'TRUST_PENALTY', 0.15),
    reviewP,
    fastClearS: num(env, 'TRUST_FAST_CLEAR_S', 0.45),
    // Default: at R = 1 the freeze never overrides ml-engine's CLEAR band (p < review_p).
    freezeAt: round6(num(env, 'TRUST_FREEZE_AT', (1 - reviewP) ** txWeight)),
    referenceAmount: num(env, 'TRUST_REFERENCE_AMOUNT', 1000),
    minHistory: num(env, 'TRUST_MIN_HISTORY', 5),
    medianDays: num(env, 'TRUST_MEDIAN_DAYS', 30),
    newAgentCap: num(env, 'TRUST_NEW_AGENT_CAP', 0.85),
    matureHolds: num(env, 'TRUST_MATURE_HOLDS', 20),
    matureDays: num(env, 'TRUST_MATURE_DAYS', 7),
    matureValue: num(env, 'TRUST_MATURE_VALUE', 10000),
    maxCreditsPerDay: num(env, 'TRUST_MAX_CREDITS_PER_DAY', 10),
  };
  const problems: string[] = [];
  const unit = (name: string, v: number) => {
    if (!(v >= 0 && v <= 1)) problems.push(`${name} must be within [0, 1]`);
  };
  if (!(p.txWeight > 0 && p.txWeight <= 1)) problems.push('TRUST_TX_WEIGHT must be in (0, 1]');
  // ≤ 72 h (the quarantine hold) also keeps hold_seconds far inside INTEGER.
  if (!(p.holdMinHours > 0 && p.holdMinHours < p.holdMaxHours && p.holdMaxHours <= QUARANTINE_HOLD_HOURS)) {
    problems.push(`need 0 < TRUST_HOLD_MIN_HOURS < TRUST_HOLD_MAX_HOURS ≤ ${QUARANTINE_HOLD_HOURS}`);
  }
  for (const [name, v] of [['TRUST_HOLD_GAMMA', p.gamma], ['TRUST_CREDIT_BETA', p.beta]] as const) {
    if (!(v > 0)) problems.push(`${name} must be > 0`);
  }
  if (!(p.kappa >= 0)) problems.push('TRUST_AMOUNT_KAPPA must be ≥ 0 (0 disables the amount factor)');
  unit('TRUST_CREDIT_BETA', p.beta);
  unit('TRUST_PENALTY', p.penalty);
  unit('TRUST_REVIEW_P', p.reviewP);
  unit('TRUST_FREEZE_AT', p.freezeAt);
  unit('TRUST_NEW_AGENT_CAP', p.newAgentCap);
  if (!(p.fastClearS > 0 && p.fastClearS <= 1)) problems.push('TRUST_FAST_CLEAR_S must be in (0, 1]');
  if (!(p.referenceAmount >= 1)) problems.push('TRUST_REFERENCE_AMOUNT must be ≥ 1');
  if (!(p.medianDays > 0)) problems.push('TRUST_MEDIAN_DAYS must be > 0');
  for (const [name, v] of [['TRUST_MIN_HISTORY', p.minHistory], ['TRUST_MATURE_HOLDS', p.matureHolds], ['TRUST_MATURE_DAYS', p.matureDays], ['TRUST_MATURE_VALUE', p.matureValue], ['TRUST_MAX_CREDITS_PER_DAY', p.maxCreditsPerDay]] as const) {
    if (!(Number.isInteger(v) && v >= 0)) problems.push(`${name} must be a whole number ≥ 0`);
  }
  // A new agent's best S_t is cap^(1−w) (at p = 0): at or below the freeze, nobody new could ever be HELD.
  if (p.newAgentCap ** (1 - p.txWeight) <= p.freezeAt) {
    problems.push('TRUST_NEW_AGENT_CAP^(1 − TRUST_TX_WEIGHT) must be above TRUST_FREEZE_AT (otherwise no new agent can ever be HELD)');
  }
  if (problems.length) throw new Error(`invalid trust configuration: ${problems.join('; ')}`);
  return p;
}

let cached: TrustParams | undefined;

/** The process-wide parameter set, parsed once from process.env (every caller shares the same object). */
export function trustParams(): TrustParams {
  return (cached ??= trustConfig());
}

/** Tests: forget the cached set so the next trustParams() re-reads process.env. */
export function resetTrustParams(): void {
  cached = undefined;
}

/** SHA-256 of the canonical parameter set: the trust_config_snapshots key every trust row points at. */
export function trustConfigHash(p: TrustParams): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
