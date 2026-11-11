import { darajaTime, rng } from './common';
import { sampleSplits } from './stuffing-e2e';

describe('sampleSplits (port of fraud_injector.sample_splits)', () => {
  it('seeded property: splits sum exactly to A in cents, each within [100, 0.98θ)', () => {
    const r = rng(42);
    const theta = 5000;
    for (let i = 0; i < 300; i++) {
      const total = Math.round((theta + 1 + r() * (6.79 * theta - theta - 1)) * 100) / 100;
      const kLo = Math.max(3, Math.ceil(total / (0.97 * theta)));
      const k = kLo + Math.floor(r() * (7 - kLo + 1));
      const a = sampleSplits(r, total, k, 100, 0.98 * theta);
      expect(a).toHaveLength(k);
      expect(a.reduce((s, x) => s + Math.round(x * 100), 0)).toBe(Math.round(total * 100));
      for (const x of a) {
        expect(x).toBeGreaterThanOrEqual(100);
        expect(x).toBeLessThan(0.98 * theta);
        expect(Math.round(x * 100)).toBeCloseTo(x * 100, 6); // whole cents
      }
    }
  });

  it('infeasible input throws', () => {
    const r = rng(1);
    expect(() => sampleSplits(r, 250, 3, 100, 4900)).toThrow(/infeasible/); // floor(A/k) < lower
    expect(() => sampleSplits(r, 40_000, 3, 100, 4900)).toThrow(/infeasible/); // ceil(A/k) >= upper
  });
});

describe('darajaTime', () => {
  it('formats EAT (UTC+3) as yyyyMMddHHmmss', () => {
    expect(darajaTime(new Date('2026-10-01T09:00:00Z'))).toBe('20261001120000');
    expect(darajaTime(new Date('2026-12-31T22:30:05Z'))).toBe('20270101013005'); // crosses the year in EAT
  });
});
