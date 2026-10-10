/**
 * @file trust.domain.test.ts
 * @description Spec gh-23 I/O matrix on the pure formulas (exact expected numbers), the escrow
 * outcome, the validated config, the feature_vector contract and the operator CLI arguments.
 */

import { assess, effectiveRating, ewma, penalise, trustIndex, type TrustAssessment } from '../src/domain/trust';
import { trustConfig, trustConfigHash } from '../src/config/trust';
import { escrowOutcome } from '../src/services/escrow.service';
import { ResilientRiskClient, type RiskEvaluationResponse } from '../src/services/risk_client.service';
import { parseAdjustArgs } from '../src/scripts/trust-adjust';

const P = trustConfig({});
const MATURE = { cleanHolds: 20, distinctDays: 7, settledValue: 10_000 };
const NEW = { cleanHolds: 0, distinctDays: 0, settledValue: 0 };
const xgb = (p: number) => ({ layer2_adjudicated: true, xgb_probability: p, isolation_score: 0.5 });
const run = (risk: Parameters<typeof assess>[0]['risk'], rating: number, over: Partial<Parameters<typeof assess>[0]> = {}, params = P) =>
  assess({ risk, rating, maturity: MATURE, amount: 1000, median: 1000, settledCount: 10, ...over }, params);

const model = (over: Partial<RiskEvaluationResponse> = {}): RiskEvaluationResponse => ({
  transaction_id: 'R', isolation_score: 0.5, xgb_probability: 0.02, model_version: 'v1', model_sha256: null, decision: 'CLEAR',
  triggered_layer: 2, layer2_adjudicated: true, reason: '', latency_ms: 1, evaluated_at: '', is_fail_safe: false, fail_safe_cause: null,
  feature_vector: { velocity_v_i: 1, split_ratio_r_s: 0, entropy_gaps: 0, agent_zscore: 0, amount_to_median_ratio: 1, recipient_reuse_count: 0 },
  ...over,
});

describe('trust index and hold (spec gh-23 matrix)', () => {
  it('defaults: w 0.7, 1–72 h, γ 2, κ 1, freeze (1 − 0.5)^0.7 stored to 6 dp', () => {
    expect(P).toMatchObject({ txWeight: 0.7, holdMinHours: 1, holdMaxHours: 72, gamma: 2, kappa: 1, beta: 0.05, penalty: 0.15, freezeAt: 0.615572 });
  });

  it('trusted agent: p 0.02, R_eff 0.98 → S_t 0.98, T_hold ≈ 1.03 h', () => {
    expect(run(xgb(0.02), 0.98)).toEqual({
      pUsed: 0.02, pSource: 'xgb', agentRatingUsed: 0.98, amountFactor: 1, trustIndex: 0.98, holdSeconds: 3702, holdReason: 'transaction', frozen: false,
    });
  });

  it('risky agent: same transaction, R_eff 0.50 → S_t ≈ 0.801, T_hold ≈ 3.82 h (agent-dominated)', () => {
    expect(run(xgb(0.02), 0.5)).toMatchObject({ trustIndex: 0.800846, holdSeconds: 13738, holdReason: 'agent', frozen: false });
  });

  it('big amount: m = 10 → ≈ 10.3 h; capped at 72 h', () => {
    expect(run(xgb(0.02), 0.98, { amount: 10_000 })).toMatchObject({ amountFactor: 10, holdSeconds: 37022, holdReason: 'amount' });
    expect(run(xgb(0.02), 0.98, { amount: 1_000_000 })).toMatchObject({ holdSeconds: 72 * 3600, holdReason: 'amount' });
  });

  it('amount factor: the median is floored at KES 1 and m capped at 1e6 (fits NUMERIC(14,6)); κ = 0 disables it', () => {
    expect(run(xgb(0.02), 0.98, { amount: 1000, median: 0.01 })).toMatchObject({ amountFactor: 1000, holdSeconds: 72 * 3600 });
    expect(run(xgb(0.02), 0.98, { amount: 1e9, median: 1 })!.amountFactor).toBe(1e6);
    expect(run(xgb(0.02), 0.98, { amount: 10_000 }, trustConfig({ TRUST_AMOUNT_KAPPA: '0' }))).toMatchObject({ amountFactor: 10, holdSeconds: 3702 });
  });

  it('no history (< 5 settled payments) → the reference amount (KES 1,000) instead of the median', () => {
    expect(run(xgb(0.02), 0.98, { amount: 5000, median: 50, settledCount: 4 })).toMatchObject({ amountFactor: 5 });
    expect(run(xgb(0.02), 0.98, { amount: 5000, median: 50, settledCount: 5 })).toMatchObject({ amountFactor: 100 });
    expect(run(xgb(0.02), 0.98, { amount: 500, median: null, settledCount: 0 })).toMatchObject({ amountFactor: 0.5, holdSeconds: 3702 });
  });

  it('fast-clear: layer-1 CLEAR, s 0.30 → isolation proxy p ≈ 0.167, S_t ≈ 0.875, T_hold ≈ 2.11 h', () => {
    expect(run({ layer2_adjudicated: false, xgb_probability: 0.9, isolation_score: 0.3 }, 0.98)).toMatchObject({
      pUsed: 0.166667, pSource: 'isolation_proxy', trustIndex: 0.874865, holdSeconds: 7602,
    });
    // The proxy stays below 0.25 inside the fast-clear band (s < 0.45) — and is clamped there beyond it.
    expect(run({ layer2_adjudicated: false, xgb_probability: 0, isolation_score: 0.449999 }, 1)!.pUsed).toBeLessThan(0.25);
    expect(run({ layer2_adjudicated: false, xgb_probability: 0, isolation_score: 0.9 }, 1)!.pUsed).toBe(0.249999);
  });

  it('no freeze at full trust: p 0.40, R_eff 1 → S_t ≈ 0.699 > 0.6156, HELD ≈ 7.4 h', () => {
    const a = run(xgb(0.4), 1)!;
    expect(a).toMatchObject({ trustIndex: 0.699368, holdSeconds: 26701, frozen: false });
    expect(escrowOutcome(model({ xgb_probability: 0.4 }), false, a)).toEqual({ status: 'HELD', reason: null, holdSeconds: 26701 });
    // At R = 1 the freeze never overrides ml-engine's CLEAR band (p < review_p = 0.5).
    expect(run(xgb(0.499999), 1)!.frozen).toBe(false);
  });

  it('trust freeze: p 0.40, R_eff 0.5 → S_t ≈ 0.568 → QUARANTINED, trust_below_threshold, 72 h', () => {
    const a = run(xgb(0.4), 0.5)!;
    expect(a).toMatchObject({ trustIndex: 0.568063, frozen: true });
    expect(escrowOutcome(model({ xgb_probability: 0.4 }), false, a)).toEqual({ status: 'QUARANTINED', reason: 'trust_below_threshold', holdSeconds: 72 * 3600 });
  });

  it('implied cutoffs: at R_eff 0.5 a CLEAR with p ≳ 0.327 is frozen; R ≤ 0.198 is frozen even at p = 0', () => {
    expect(run(xgb(0.328), 0.5)!.frozen).toBe(true);
    expect(run(xgb(0.326), 0.5)!.frozen).toBe(false);
    expect(run(xgb(0), 0.198)!.frozen).toBe(true);
    expect(run(xgb(0), 0.199)!.frozen).toBe(false);
  });

  it('new agent: rating 1.0 but not mature → R_eff 0.85 (every criterion is required)', () => {
    expect(run(xgb(0.02), 1, { maturity: NEW })).toMatchObject({ agentRatingUsed: 0.85 });
    expect(effectiveRating(1, { ...MATURE, cleanHolds: 19 }, P)).toBe(0.85);
    expect(effectiveRating(1, { ...MATURE, distinctDays: 6 }, P)).toBe(0.85);
    expect(effectiveRating(1, { ...MATURE, settledValue: 9_999.99 }, P)).toBe(0.85);
    expect(effectiveRating(1, MATURE, P)).toBe(1);
    expect(effectiveRating(0.6, NEW, P)).toBe(0.6);
  });

  it('precision: the freeze compares the stored 6-dp S_t with ≤', () => {
    const at6156 = trustConfig({ TRUST_FREEZE_AT: '0.6156' });
    const a = run(xgb(0.499968), 1, {}, at6156)!;
    expect(a.trustIndex).toBe(0.6156);
    expect(a.trustIndex.toFixed(6)).toBe('0.615600');
    expect(a.frozen).toBe(true);
    expect(run(xgb(0.5), 1)).toMatchObject({ trustIndex: 0.615572, frozen: true }); // equals the default exactly
  });

  it('recomputable from the stored columns: S_t = (1 − p_used)^w · R_eff^(1−w)', () => {
    for (const a of [run(xgb(0.02), 0.98)!, run(xgb(0.02), 0.5)!, run({ layer2_adjudicated: false, xgb_probability: 0, isolation_score: 0.3 }, 0.98)!]) {
      expect(trustIndex(a.pUsed, a.agentRatingUsed, P.txWeight)).toBe(a.trustIndex);
    }
  });

  it('bad inputs fail closed: no S_t → QUARANTINED (trust_input_invalid)', () => {
    expect(run(xgb(NaN), 0.9)).toBeNull();
    expect(run(xgb(1.2), 0.9)).toBeNull();
    expect(run({ layer2_adjudicated: null, xgb_probability: 0.1, isolation_score: 0.1 }, 0.9)).toBeNull();
    expect(run({ layer2_adjudicated: false, xgb_probability: 0.1, isolation_score: -0.1 }, 0.9)).toBeNull();
    expect(run(xgb(0.1), NaN)).toBeNull();
    expect(run(xgb(0.1), 1.5)).toBeNull();
    expect(trustIndex(Infinity, 1, 0.7)).toBeNull();
    expect(escrowOutcome(model(), false, null)).toMatchObject({ status: 'QUARANTINED', reason: 'trust_input_invalid' });
  });
});

describe('escrow outcome (fail closed)', () => {
  const ok: TrustAssessment = run(xgb(0.02), 0.98)!;
  it('REVIEW / QUARANTINE / fail-safe / security hold → QUARANTINED 72 h with the reason', () => {
    expect(escrowOutcome(model({ decision: 'REVIEW' }), false, ok)).toMatchObject({ status: 'QUARANTINED', reason: 'model_decision', holdSeconds: 259_200 });
    expect(escrowOutcome(model({ decision: 'QUARANTINE' }), false, ok)).toMatchObject({ reason: 'model_decision' });
    expect(escrowOutcome(model({ is_fail_safe: true, decision: 'QUARANTINE' }), false, null)).toMatchObject({ reason: 'fail_safe' });
    expect(escrowOutcome(model(), true, ok)).toMatchObject({ status: 'QUARANTINED', reason: 'security_hold' });
    expect(escrowOutcome(model(), false, ok)).toEqual({ status: 'HELD', reason: null, holdSeconds: 3702 });
  });
});

describe('rating moves only on evidence', () => {
  it('credit R ← R + β(1 − R); penalty R ← max(0, R − 0.15)', () => {
    expect(ewma(0.5, 0.05)).toBe(0.525);
    expect(ewma(1, 0.05)).toBe(1);
    expect(penalise(0.5, 0.15)).toBe(0.35);
    expect(penalise(0.1, 0.15)).toBe(0);
  });
});

describe('trust config (validated at startup)', () => {
  it.each([
    ['TRUST_TX_WEIGHT', '0'],
    ['TRUST_TX_WEIGHT', '1.5'],
    ['TRUST_HOLD_MIN_HOURS', '80'],
    ['TRUST_HOLD_GAMMA', '0'],
    ['TRUST_AMOUNT_KAPPA', '-1'],
    ['TRUST_CREDIT_BETA', '0'],
    ['TRUST_FREEZE_AT', '1.2'],
    ['TRUST_REVIEW_P', 'abc'],
    ['TRUST_REFERENCE_AMOUNT', '0'],
    ['TRUST_REFERENCE_AMOUNT', '0.5'],
    ['TRUST_HOLD_MIN_HOURS', '0'],
    ['TRUST_HOLD_MAX_HOURS', '73'],
    ['TRUST_MIN_HISTORY', '2.5'],
    ['TRUST_MATURE_HOLDS', '1.5'],
    ['TRUST_MATURE_DAYS', '0.5'],
    ['TRUST_MAX_CREDITS_PER_DAY', '3.2'],
    ['TRUST_NEW_AGENT_CAP', '0.1'], // 0.1^0.3 ≈ 0.50 ≤ the freeze: no new agent could ever be HELD
  ])('%s=%s is refused', (name, value) => {
    expect(() => trustConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('TRUST_AMOUNT_KAPPA = 0 and TRUST_HOLD_MAX_HOURS = 72 are accepted', () => {
    expect(trustConfig({ TRUST_AMOUNT_KAPPA: '0', TRUST_HOLD_MAX_HOURS: '72' })).toMatchObject({ kappa: 0, holdMaxHours: 72 });
  });

  it('the snapshot hash is stable and changes with any parameter', () => {
    expect(trustConfigHash(trustConfig({}))).toBe(trustConfigHash(P));
    expect(trustConfigHash(trustConfig({ TRUST_HOLD_GAMMA: '3' }))).not.toBe(trustConfigHash(P));
  });
});

describe('ml-engine contract: feature_vector', () => {
  const request = {
    transaction_id: 'R1',
    transaction: { agent_id: 'a', timestamp: '2026-10-01T00:00:00Z', amount: 10, counterparty_id: 'c' },
    history: [],
  };
  const respond = (body: Record<string, unknown>) =>
    ((global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  const base = { transaction_id: 'R1', isolation_score: 0.1, xgb_probability: 0.1, model_version: 'v1', decision: 'CLEAR', layer2_adjudicated: false };

  it('is kept on a model response', async () => {
    respond({ ...base, feature_vector: model().feature_vector });
    const r = await new ResilientRiskClient().evaluate(request);
    expect(r).toMatchObject({ is_fail_safe: false, feature_vector: { velocity_v_i: 1, split_ratio_r_s: 0 } });
  });

  it('missing or malformed → contract failure → fail-safe (no trust row)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    respond(base);
    expect(await new ResilientRiskClient().evaluate(request)).toMatchObject({ is_fail_safe: true, decision: 'QUARANTINE', feature_vector: null });
    respond({ ...base, feature_vector: { ...model().feature_vector, velocity_v_i: 'fast' } });
    expect((await new ResilientRiskClient().evaluate(request)).is_fail_safe).toBe(true);
  });
});

describe('trust:adjust arguments', () => {
  it('parses an audited adjustment; refuses a zero / out-of-range delta or a missing reason', () => {
    expect(parseAdjustArgs(['--agent', 'AG042', '--delta', '0.15', '--reason', 'undo', '--ref', 'T-1'])).toEqual({ agent: 'AG042', delta: 0.15, reason: 'undo', ref: 'T-1' });
    expect(parseAdjustArgs(['--agent', 'AG042', '--delta', '-0.1', '--reason', 'x']).ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => parseAdjustArgs(['--agent', 'AG042', '--delta', '0', '--reason', 'x'])).toThrow(/usage/);
    expect(() => parseAdjustArgs(['--agent', 'AG042', '--delta', '2', '--reason', 'x'])).toThrow(/usage/);
    expect(() => parseAdjustArgs(['--agent', 'AG042', '--delta', '0.1'])).toThrow(/usage/);
    expect(() => parseAdjustArgs(['--bogus', 'x'])).toThrow(/unexpected/);
    expect(parseAdjustArgs(['--agent', 'A', '--delta', '0.1', '--reason', 'x', '--ref', 'r'.repeat(154)]).ref).toHaveLength(154);
    expect(() => parseAdjustArgs(['--agent', 'A', '--delta', '0.1', '--reason', 'x', '--ref', 'r'.repeat(155)])).toThrow(/longer than 154/);
  });
});
