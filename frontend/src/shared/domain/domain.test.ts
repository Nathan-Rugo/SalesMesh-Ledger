import { describe, expect, it } from 'vitest';
import { err, mapResult, ok } from '@/core/domain/result';
import { escrowLabel, escrowTone, isEscrowStatus } from './escrow-status';
import { formatMoney, moneyParts } from './money';
import { formatMsisdnLocal, normaliseKenyanMsisdn } from './msisdn';
import { isPinShaped, pinPolicyViolation } from './pin-policy';

describe('normaliseKenyanMsisdn (mirrors the gateway)', () => {
  it.each([
    ['0712 345 678', '254712345678'],
    ['0712-345-678', '254712345678'],
    ['+254 712 345 678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['(0712) 345678', '254712345678'],
    ['  0712345678  ', '254712345678'],
  ])('%s → %s', (raw, out) => expect(normaliseKenyanMsisdn(raw)).toBe(out));

  it.each(['', '0812345678', '071234567', '07123456789', '2547123456789', '0712.345.678', 'abc', '+44 7700 900123'])('rejects %s', (raw) =>
    expect(normaliseKenyanMsisdn(raw)).toBeNull()
  );

  it('rejects non-strings', () => {
    expect(normaliseKenyanMsisdn(712345678)).toBeNull();
    expect(normaliseKenyanMsisdn(null)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatMsisdnLocal('254712345678')).toBe('0712 345 678');
    expect(formatMsisdnLocal('nope')).toBe('nope');
  });
});

describe('pinPolicyViolation (mirrors the gateway)', () => {
  it.each([
    ['', 'pin_format'],
    ['123', 'pin_format'],
    ['1234567', 'pin_format'],
    ['12a4', 'pin_format'],
    ['1111', 'pin_repeated'],
    ['000000', 'pin_repeated'],
    ['1234', 'pin_sequence'],
    ['3456', 'pin_sequence'],
    ['987654', 'pin_sequence'],
    ['1212', 'pin_common'],
    ['2580', 'pin_common'],
    ['147258', 'pin_common'],
    ['4829', null],
    ['90817', null],
    ['583920', null],
    // 0→9 is not a run: the gateway compares digit values, not wrap-around.
    ['8901', null],
  ])('%s → %s', (pin, violation) => expect(pinPolicyViolation(pin)).toBe(violation));

  it('refuses non-strings', () => expect(pinPolicyViolation(1234)).toBe('pin_format'));
  it('shape check', () => {
    expect(isPinShaped('1234')).toBe(true);
    expect(isPinShaped('12345678')).toBe(false);
  });
});

describe('money', () => {
  it('splits the Currency Rule parts from integer cents', () => {
    expect(moneyParts(4_525_000)).toEqual({ currency: 'KES', negative: false, integer: '45,250', decimals: '.00' });
    expect(moneyParts(5)).toEqual({ currency: 'KES', negative: false, integer: '0', decimals: '.05' });
    expect(moneyParts(-150)).toMatchObject({ negative: true, integer: '1', decimals: '.50' });
  });

  it('handles bigint beyond Number precision', () => {
    expect(moneyParts(123456789012345678901n).integer).toBe('1,234,567,890,123,456,789');
  });

  it('refuses floats and unsafe numbers', () => {
    expect(() => moneyParts(1.5)).toThrow(RangeError);
    expect(() => moneyParts(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it('formats plain text', () => {
    expect(formatMoney(4_525_000)).toBe('KES 45,250.00');
    expect(formatMoney(-150)).toBe('-KES 1.50');
    expect(formatMoney(0)).toBe('KES 0.00');
  });
});

describe('escrow status', () => {
  it('maps every status to a tone and label', () => {
    expect(escrowTone('RELEASED')).toBe('clear');
    expect(escrowTone('ESCROW_HOLD')).toBe('hold');
    expect(escrowLabel('REMITTED')).toBe('Remitted (UFAA)');
    expect(isEscrowStatus('CANARY_VERIFYING')).toBe(true);
    expect(isEscrowStatus('PENDING')).toBe(false);
  });
});

describe('Result', () => {
  it('maps ok and passes errors through', () => {
    expect(mapResult(ok(2), (n) => n * 2)).toEqual({ ok: true, value: 4 });
    const e = err({ kind: 'unavailable' as const });
    expect(mapResult(e, () => 1)).toBe(e);
  });
});
