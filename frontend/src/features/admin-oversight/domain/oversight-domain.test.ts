import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/core/domain/result';
import { featureCopy, formatAge, validNote, validReceipt, waterfall } from './entities/oversight';
import type { OversightRepository } from './repositories/oversight-repository';
import { OverrideUseCase } from './usecases/oversight-usecases';

describe('oversight domain', () => {
  it('note: trimmed, 10–280 characters', () => {
    expect(validNote('  short  ')).toBeNull();
    expect(validNote(' '.repeat(20))).toBeNull();
    expect(validNote('  ten chars!  ')).toBe('ten chars!');
    expect(validNote('x'.repeat(280))).toHaveLength(280);
    expect(validNote('x'.repeat(281))).toBeNull();
  });

  it('receipt: 8–20 letters and digits, upper-cased', () => {
    expect(validReceipt(' sgh12abc34 ')).toBe('SGH12ABC34');
    expect(validReceipt('ABC123')).toBeNull();
    expect(validReceipt('SGH12-ABC34')).toBeNull();
  });

  it('waterfall: running totals from 0 and an axis covering 0 and every total', () => {
    const w = waterfall([
      { feature: 'a', attribution: 1.5, value: 0 },
      { feature: 'b', attribution: -2, value: 0 },
      { feature: 'c', attribution: 0.25, value: 0 },
    ]);
    expect(w.steps.map((s) => [s.from, s.to])).toEqual([
      [0, 1.5],
      [1.5, -0.5],
      [-0.5, -0.25],
    ]);
    expect([w.min, w.max]).toEqual([-0.5, 1.5]);
  });

  it('plain-language feature names; an unknown feature keeps its raw name', () => {
    expect(featureCopy('velocity_v_i').label).toBe('Sales pace (payments per hour)');
    expect(featureCopy('split_ratio_r_s').format(0.5)).toBe('50%');
    expect(featureCopy('new_feature').label).toBe('new_feature');
  });

  it('age: minutes, hours, then days', () => {
    expect(formatAge(45 * 60_000)).toBe('45 min');
    expect(formatAge(5 * 3600_000)).toBe('5 h');
    expect(formatAge(76 * 3600_000)).toBe('3 d 4 h');
    expect(formatAge(-1)).toBe('0 min');
  });

  it('override: a bad note, a bad receipt or an empty PIN never reaches the gateway', async () => {
    const repo: OversightRepository = { queue: vi.fn(), override: vi.fn(async () => ok(undefined)) };
    const uc = new OverrideUseCase(repo);
    const escrow = { kind: 'escrow', id: 'e-1', action: 'release' } as const;
    expect(await uc.execute({ target: escrow, pin: '4826', note: 'too short' })).toEqual({ ok: false, error: { kind: 'override_refused', code: 'invalid_note' } });
    expect(await uc.execute({ target: escrow, pin: '', note: 'A proper reason here' })).toMatchObject({ ok: false, error: { kind: 'invalid_pin' } });
    expect(
      await uc.execute({ target: { kind: 'payout', id: 'p-1', outcome: 'paid', receipt: 'nope' }, pin: '4826', note: 'A proper reason here' })
    ).toEqual({ ok: false, error: { kind: 'invalid_request' } });
    expect(repo.override).not.toHaveBeenCalled();

    expect((await uc.execute({ target: { kind: 'payout', id: 'p-1', outcome: 'paid', receipt: ' sgh12abc34' }, pin: '4826', note: '  Org portal shows it paid  ' })).ok).toBe(true);
    expect(repo.override).toHaveBeenCalledWith({ kind: 'payout', id: 'p-1', outcome: 'paid', receipt: 'SGH12ABC34' }, '4826', 'Org portal shows it paid');
  });
});
