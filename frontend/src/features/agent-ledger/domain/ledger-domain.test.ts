import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/core/domain/result';
import { fromGatewayEscrow } from '@/shared/domain/escrow-status';
import { formatHold, holdRemaining, nextMaturity, openPayout, type LedgerSnapshot, type Payout } from './entities/ledger';
import type { LedgerRepository } from './repositories/ledger-repository';
import { ClaimPayoutUseCase } from './usecases/claim-payout';
import { VerifyPayoutLineUseCase } from './usecases/verify-payout-line';

const payout = (status: Payout['status']): Payout => ({ id: status, status, amountCents: 100, msisdn: 'm', receipt: null, failureReason: null, createdAt: 0, resolvedAt: null });
const snap = (o: Partial<LedgerSnapshot> = {}): LedgerSnapshot => ({
  balance: { cents: 0, payableNowCents: 0, minAmountCents: 1000, maxAmountCents: 15_000_000 },
  destination: null,
  destinationChanging: false,
  disclosure: { version: '1', text: 't' },
  payouts: [],
  accruals: [],
  pendingCount: 0,
  pendingCents: 0,
  ...o,
});

describe('ledger domain', () => {
  it('holdRemaining never goes negative', () => {
    expect(holdRemaining(1_000, 5_000)).toBe(4_000);
    expect(holdRemaining(9_000, 5_000)).toBe(0);
  });

  it('formatHold: days, hours, then a ticking clock', () => {
    expect(formatHold(2 * 86_400_000 + 4 * 3600_000)).toBe('2d 4h');
    expect(formatHold(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
    expect(formatHold(4 * 60_000 + 9_000)).toBe('4:09');
    expect(formatHold(0)).toBe('0:00');
  });

  it('nextMaturity: the soonest future in-escrow hold only', () => {
    const a = (id: string, releaseDueAt: number, status: 'ESCROW_HOLD' | 'QUARANTINED' = 'ESCROW_HOLD') => ({ id, amountCents: 1, status, releaseDueAt, quarantineReason: null });
    expect(nextMaturity(snap({ accruals: [a('q', 50, 'QUARANTINED'), a('late', 300), a('soon', 200), a('past', 10)] }), 100)).toBe(200);
    expect(nextMaturity(snap(), 0)).toBeNull();
  });

  it('openPayout: SENT, UNKNOWN or UNRESOLVED', () => {
    expect(openPayout(snap({ payouts: [payout('PAID'), payout('UNKNOWN')] }))?.id).toBe('UNKNOWN');
    expect(openPayout(snap({ payouts: [payout('PAID'), payout('FAILED')] }))).toBeNull();
  });

  it('gateway escrow states map onto the lifecycle', () => {
    expect(fromGatewayEscrow('HELD', { matured: false, securityHold: false })).toBe('ESCROW_HOLD');
    expect(fromGatewayEscrow('HELD', { matured: true, securityHold: false })).toBe('CLEAR');
    expect(fromGatewayEscrow('CLAIMED', { matured: true, securityHold: false })).toBe('CLEAR');
    expect(fromGatewayEscrow('HELD', { matured: true, securityHold: true })).toBe('QUARANTINED');
    expect(fromGatewayEscrow('QUARANTINED', { matured: true, securityHold: false })).toBe('QUARANTINED');
    expect(fromGatewayEscrow('RELEASED', { matured: true, securityHold: false })).toBe('RELEASED');
    expect(fromGatewayEscrow('REMITTED', { matured: true, securityHold: false })).toBe('REMITTED');
  });
});

describe('use cases reject before any request', () => {
  const repo = (): LedgerRepository => ({
    snapshot: vi.fn(),
    claim: vi.fn(async () => ok(payout('SENT'))),
    payoutLines: vi.fn(),
    verifyPayoutLine: vi.fn(),
  });

  it('ClaimPayout: an unaccepted disclosure or an empty PIN never reaches the repository', async () => {
    const r = repo();
    const uc = new ClaimPayoutUseCase(r);
    expect(await uc.execute({ pin: '4826', acceptedDisclosure: null })).toEqual({ ok: false, error: { kind: 'invalid_request' } });
    expect(await uc.execute({ pin: '', acceptedDisclosure: '1' })).toMatchObject({ ok: false, error: { kind: 'invalid_pin', field: 'pin' } });
    expect(r.claim).not.toHaveBeenCalled();
    expect((await uc.execute({ pin: '4826', acceptedDisclosure: '1' })).ok).toBe(true);
    expect(r.claim).toHaveBeenCalledWith('4826', '1');
  });

  it('VerifyPayoutLine: an empty PIN never reaches the repository', async () => {
    const r = repo();
    expect((await new VerifyPayoutLineUseCase(r).execute({ pin: '' })).ok).toBe(false);
    expect(r.verifyPayoutLine).not.toHaveBeenCalled();
  });
});
