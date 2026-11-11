import { betaCdf, clopperPearson, percentile, rate, summarise } from './stats';

// Reference values from scipy.stats.beta.ppf (ml-engine/.venv) and numpy.percentile.
describe('Clopper–Pearson exact interval', () => {
  it.each([
    [84, 84, 0.9570350803704349, 1], // the ml-engine offline stuffing baseline (metrics.json)
    [0, 84, 0, 0.04296491962956506],
    [5, 10, 0.18708602844739855, 0.8129139715526015],
    [1, 3, 0.008403758659612636, 0.9057006759497539],
    [95, 100, 0.8871650888945373, 0.9835681208179479],
    [0, 1, 0, 0.975],
    [1, 1, 0.025, 1],
    [50, 1000, 0.03733539760466175, 0.06539048791549364],
  ])('k=%i n=%i → [%f, %f]', (k, n, low, high) => {
    const ci = clopperPearson(k, n);
    expect(ci.low).toBeCloseTo(low, 9);
    expect(ci.high).toBeCloseTo(high, 9);
  });

  it('k = n has the closed-form lower bound (α/2)^(1/n), and k = 0 mirrors it', () => {
    for (const n of [1, 7, 84, 500]) {
      expect(clopperPearson(n, n).low).toBeCloseTo(0.025 ** (1 / n), 12);
      expect(clopperPearson(0, n).high).toBeCloseTo(1 - 0.025 ** (1 / n), 12);
    }
  });

  it('stays monotone and inside [0, 1] for a large n (a 60 s load run)', () => {
    const a = clopperPearson(3, 12_000);
    const b = clopperPearson(4, 12_000);
    expect(a.low).toBeGreaterThan(0);
    expect(a.low).toBeLessThan(3 / 12_000);
    expect(a.high).toBeGreaterThan(3 / 12_000);
    expect(b.low).toBeGreaterThan(a.low);
    expect(b.high).toBeGreaterThan(a.high);
  });

  it('rejects impossible counts; rate() reports null for n = 0', () => {
    expect(() => clopperPearson(5, 4)).toThrow(RangeError);
    expect(() => clopperPearson(-1, 4)).toThrow(RangeError);
    expect(() => clopperPearson(1.5, 4)).toThrow(RangeError);
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, point: null, ci95: null });
    expect(rate(1, 4)).toMatchObject({ k: 1, n: 4, point: 0.25 });
  });

  it('betaCdf matches the uniform and a symmetric case', () => {
    expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    expect(betaCdf(0.5, 4, 4)).toBeCloseTo(0.5, 12);
  });
});

describe('percentiles (numpy linear interpolation)', () => {
  const x = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
  it('1..100 → p50 50.5, p95 95.05, p99 99.01; unsorted input is fine', () => {
    expect(percentile(x, 50)).toBeCloseTo(50.5, 12);
    expect(percentile(x, 95)).toBeCloseTo(95.05, 12);
    expect(percentile(x, 99)).toBeCloseTo(99.01, 12);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
  it('summarise', () => {
    expect(summarise(x)).toMatchObject({ n: 100, max: 100, mean: 50.5 });
    expect(summarise([])).toMatchObject({ n: 0, p95: null, max: null });
  });
});
