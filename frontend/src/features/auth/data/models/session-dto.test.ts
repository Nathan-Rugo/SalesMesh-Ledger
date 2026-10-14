import { describe, expect, it } from 'vitest';
import { toSession } from './session-dto';

const valid = { access_token: 'h.p.s', token_type: 'Bearer', expires_in: 900, pin_change_required: true, user: { user_id: 'u-1', role: 'MERCHANT_ADMIN' } };

describe('toSession', () => {
  it('maps a valid body; expiresAt = now + expires_in * 1000', () => {
    expect(toSession(valid, 1_000)).toEqual({
      accessToken: 'h.p.s',
      expiresAt: 1_000 + 900_000,
      pinChangeRequired: true,
      user: { id: 'u-1', role: 'MERCHANT_ADMIN' },
    });
  });

  it('pin_change_required absent → false', () => {
    const body: Record<string, unknown> = { ...valid };
    delete body.pin_change_required;
    expect(toSession(body)?.pinChangeRequired).toBe(false);
  });

  it.each([
    ['unknown role', { ...valid, user: { user_id: 'u-1', role: 'ROOT' } }],
    ['expires_in 0', { ...valid, expires_in: 0 }],
    ['expires_in negative', { ...valid, expires_in: -5 }],
    ['expires_in string', { ...valid, expires_in: '900' }],
    ['empty token', { ...valid, access_token: '' }],
    ['missing user', { ...valid, user: undefined }],
    ['null body', null],
    ['string body', 'nope'],
  ])('%s → null', (_name, body) => expect(toSession(body)).toBeNull());
});
