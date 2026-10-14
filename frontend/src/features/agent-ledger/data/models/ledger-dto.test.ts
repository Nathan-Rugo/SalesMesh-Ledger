import { describe, expect, it } from 'vitest';
import { accrualView, ledgerBody, lineView, payoutView } from '@/test/fake-gateway';
import { toLedgerSnapshot, toPayout, toPayoutLines } from './ledger-dto';

describe('ledger DTO validators', () => {
  it('maps a full GET /payouts body (shillings → cents, ISO → epoch ms)', () => {
    const due = '2026-10-14T10:00:00.000Z';
    const s = toLedgerSnapshot(
      ledgerBody({
        payouts: [payoutView({ status: 'PAID', receipt: 'TJK1ABC2DE', resolved_at: '2026-10-14T08:01:00.000Z' })],
        accruals: [
          accrualView({ release_due_at: due }),
          accrualView({ escrow_id: 'e-2', status: 'QUARANTINED', quarantine_reason: 'model_decision' }),
          accrualView({ escrow_id: 'e-3', status: 'CLAIMED', quarantine_reason: 'security_hold' }),
          accrualView({ escrow_id: 'e-4', status: 'CLAIMED' }),
        ],
        pending_count: 1,
        pending_cents: 35_000,
      })
    );
    expect(s).not.toBeNull();
    expect(s!.balance).toEqual({ cents: 123_523, payableNowCents: 123_500, minAmountCents: 1_000, maxAmountCents: 15_000_000 });
    expect(s!.payouts[0]).toMatchObject({ status: 'PAID', amountCents: 123_500, receipt: 'TJK1ABC2DE', resolvedAt: Date.parse('2026-10-14T08:01:00.000Z') });
    expect(s!.accruals.map((a) => a.status)).toEqual(['ESCROW_HOLD', 'QUARANTINED', 'QUARANTINED', 'CLEAR']);
    expect(s!.accruals[0]!.releaseDueAt).toBe(Date.parse(due));
  });

  it('a HELD accrual past due stays "in escrow" until a refetch says otherwise', () => {
    const s = toLedgerSnapshot(ledgerBody({ accruals: [accrualView({ release_due_at: '2000-01-01T00:00:00.000Z' })] }));
    expect(s!.accruals[0]!.status).toBe('ESCROW_HOLD');
  });

  it.each([
    ['not an object', 'x'],
    ['no balance', { ...ledgerBody(), balance: null }],
    ['fractional cents', ledgerBody({ balance: { cents: 1.5 } })],
    ['negative cents', ledgerBody({ balance: { cents: -1 } })],
    ['string destination_changing', ledgerBody({ destination_changing: 'no' })],
    ['missing accruals (old gateway)', { ...ledgerBody(), accruals: undefined }],
    ['missing pending_cents', { ...ledgerBody(), pending_cents: undefined }],
    ['bad accrual status', ledgerBody({ accruals: [accrualView({ status: 'RELEASED' })] })],
    ['bad accrual date', ledgerBody({ accruals: [accrualView({ release_due_at: 'soon' })] })],
    ['bad payout status', ledgerBody({ payouts: [payoutView({ status: 'DONE' })] })],
    ['bad payout date', ledgerBody({ payouts: [payoutView({ created_at: 7 })] })],
    ['no disclosure text', ledgerBody({ disclosure: { version: '1' } })],
  ])('malformed (%s) → null', (_name, body) => {
    expect(toLedgerSnapshot(body)).toBeNull();
  });

  it('payout and payout-line items', () => {
    expect(toPayout(payoutView({ resolved_at: 'garbage' }))).toBeNull();
    expect(toPayoutLines({ destinations: [lineView({ status: 'COOLING_OFF', cooling_off_until: '2026-10-15T08:00:00.000Z' })] })).toEqual([
      { id: 'd-1', msisdn: '2547******78', status: 'COOLING_OFF', rejectReason: null, coolingOffUntil: Date.parse('2026-10-15T08:00:00.000Z') },
    ]);
    expect(toPayoutLines({ destinations: [lineView({ status: 'MAYBE' })] })).toBeNull();
    expect(toPayoutLines({})).toBeNull();
  });
});
