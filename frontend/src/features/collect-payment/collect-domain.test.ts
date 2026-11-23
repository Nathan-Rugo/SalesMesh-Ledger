import { describe, expect, it } from 'vitest';
import { stkView } from '@/test/fake-gateway';
import { toStkRequest } from './data/models/stk-dto';
import { maskMsisdn, newIdempotencyKey, parseStkAmount } from './domain/entities/stk-request';
import { validatePaymentForm } from './domain/usecases/collect-usecases';

describe('payment form validation (mirrors the gateway)', () => {
  it.each([
    ['1', 1],
    ['250000', 250_000],
    [' 1,500 ', 1500],
    ['0', null],
    ['250001', null],
    ['1.5', null],
    ['-5', null],
    ['', null],
    ['1e3', null],
    ['250,000', 250_000],
    ['1,00', null],
    [',,5', null],
    ['1,0000', null],
  ])('amount %j → %j', (raw, want) => expect(parseStkAmount(raw)).toBe(want));

  it('normalises the phone and reports each bad field', () => {
    expect(validatePaymentForm({ phone: '0798 765 432', amount: '1' })).toEqual({ ok: true, value: { msisdn: '254798765432', amount: 1 } });
    expect(validatePaymentForm({ phone: '0612345678', amount: '0' })).toEqual({
      ok: false,
      error: { kind: 'invalid_payment_input', phone: true, amount: true },
    });
  });

  it('masks the phone and makes a fresh 128-bit key each time', () => {
    expect(maskMsisdn('254798765432')).toBe('0798 ••• 432');
    expect(maskMsisdn('nonsense')).toBe('•••');
    const a = newIdempotencyKey();
    expect(a).toMatch(/^stk-[0-9a-f]{32}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe('STK DTO validator', () => {
  it('maps statuses; paid wins over the raw status; PENDING-like states read as UNKNOWN', () => {
    expect(toStkRequest(stkView())).toEqual({ id: 's-1', status: 'ACCEPTED', resultCode: null, receipt: null });
    expect(toStkRequest(stkView({ paid: true, receipt: 'UAB1C2D3E4' }))).toMatchObject({ status: 'PAID', receipt: 'UAB1C2D3E4' });
    expect(toStkRequest(stkView({ status: 'FAILED', result_code: '1032' }))).toMatchObject({ status: 'FAILED', resultCode: '1032' });
    for (const s of ['PENDING', 'PAID_UNCONFIRMED', 'RECONCILE_EXHAUSTED', 'UNKNOWN']) expect(toStkRequest(stkView({ status: s }))?.status).toBe('UNKNOWN');
    // Initiation replies carry no paid / receipt fields.
    expect(toStkRequest({ stk_request_id: 's-1', status: 'ACCEPTED' })).toMatchObject({ status: 'ACCEPTED', receipt: null });
  });

  it.each([null, [], {}, stkView({ stk_request_id: '' }), stkView({ status: 'BOGUS' }), stkView({ paid: 'yes' }), stkView({ paid: true, receipt: null }), stkView({ result_code: 1032 })])(
    'rejects a malformed body %#',
    (body) => expect(toStkRequest(body)).toBeNull()
  );
});
