import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/core/domain/result';
import { destinationFor, roleForPath, safeNextPath, type Session } from './entities/session';
import type { AuthRepository } from './repositories/auth-repository';
import { ChangePinUseCase } from './usecases/change-pin';
import { LoginUseCase } from './usecases/login';

const session = (role: Session['user']['role'], pinChangeRequired = false): Session => ({
  accessToken: 't',
  expiresAt: Date.now() + 900_000,
  pinChangeRequired,
  user: { id: 'u', role },
});

function repoDouble() {
  const login = vi.fn(async () => ok(session('SALES_AGENT')));
  const changePin = vi.fn(async () => ok(session('SALES_AGENT')));
  return { repo: { login, changePin } as unknown as AuthRepository, login, changePin };
}

describe('safeNextPath', () => {
  it.each(['/agent', '/admin/queue?x=1', '/agent#top'])('accepts %s', (p) => expect(safeNextPath(p)).toBe(p));
  it.each([null, '', 'agent', '//evil.example', '/\\evil.example', 'https://evil.example', '/a\\b', '/a\nb', `/${'a'.repeat(600)}`])(
    'rejects %j',
    (p) => expect(safeNextPath(p)).toBeNull()
  );
});

describe('destinationFor', () => {
  it('forced PIN change wins over everything', () => expect(destinationFor(session('SALES_AGENT', true), '/agent')).toBe('/register'));
  it('honours next= for the right role', () => expect(destinationFor(session('MERCHANT_ADMIN'), '/admin/x')).toBe('/admin/x'));
  it('a SALES_AGENT sent to /admin lands on /agent', () => expect(destinationFor(session('SALES_AGENT'), '/admin')).toBe('/agent'));
  it('ignores unsafe next=', () => expect(destinationFor(session('MERCHANT_ADMIN'), '//evil.example')).toBe('/admin'));
  it('maps roles to areas', () => {
    expect(roleForPath('/admin')).toBe('MERCHANT_ADMIN');
    expect(roleForPath('/agents')).toBeNull();
  });
});

describe('LoginUseCase', () => {
  it('normalises the phone before calling the gateway', async () => {
    const d = repoDouble();
    await new LoginUseCase(d.repo).execute({ phone: '0712 345 678', pin: '4829' });
    expect(d.login).toHaveBeenCalledWith('254712345678', '4829');
  });
  it('refuses a bad phone or PIN shape without a request', async () => {
    const d = repoDouble();
    const uc = new LoginUseCase(d.repo);
    expect(await uc.execute({ phone: '0812 345 678', pin: '4829' })).toEqual({ ok: false, error: { kind: 'invalid_phone' } });
    expect(await uc.execute({ phone: '0712345678', pin: '12' })).toMatchObject({ ok: false, error: { kind: 'invalid_pin', field: 'pin' } });
    expect(d.login).not.toHaveBeenCalled();
  });
});

describe('ChangePinUseCase', () => {
  it.each([
    ['', '4829', '4829', 'current_pin_missing', 'current_pin'],
    ['4829', '1234', '1234', 'pin_sequence', 'new_pin'],
    ['4829', '7777', '7777', 'pin_repeated', 'new_pin'],
    ['4829', '2580', '2580', 'pin_common', 'new_pin'],
    ['4829', '48', '48', 'pin_format', 'new_pin'],
    ['4829', '4829', '4829', 'pin_unchanged', 'new_pin'],
    ['4829', '5830', '5831', 'pin_mismatch', 'confirm_pin'],
  ])('current=%s new=%s confirm=%s → %s on %s', async (currentPin, newPin, confirmPin, reason, field) => {
    const d = repoDouble();
    const r = await new ChangePinUseCase(d.repo).execute({ currentPin, newPin, confirmPin });
    expect(r).toEqual({ ok: false, error: { kind: 'invalid_pin', reason, field } });
    expect(d.changePin).not.toHaveBeenCalled();
  });
  it('calls the gateway when valid', async () => {
    const d = repoDouble();
    const r = await new ChangePinUseCase(d.repo).execute({ currentPin: '4829', newPin: '5830', confirmPin: '5830' });
    expect(r.ok).toBe(true);
    expect(d.changePin).toHaveBeenCalledWith('4829', '5830');
  });
});
