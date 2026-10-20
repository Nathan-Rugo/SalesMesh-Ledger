import { describe, expect, it } from 'vitest';
import { frozenEscrowView, queueBody, unresolvedPayoutView } from '@/test/fake-gateway';
import { toOversightQueue } from './oversight-dto';

describe('GET /api/v1/admin/frozen-payouts validator', () => {
  it('maps a full body: KES to cents, timestamps to epoch ms, SHAP kept in server order', () => {
    const q = toOversightQueue(queueBody({ escrows: [frozenEscrowView()], payouts: [unresolvedPayoutView()] }))!;
    expect(q.slaHours).toEqual({ escrow: 72, payout: 24 });
    expect(q.totals).toEqual({ escrows: 1, payouts: 1 });
    expect(q.overdue).toEqual({ escrows: 1, payouts: 1 });
    expect(q.escrows[0]).toMatchObject({ id: 'e-1', amountCents: 42_550, reason: 'model_decision', securityHold: false, reviewedAt: null, overdue: true });
    expect(q.escrows[0]!.risk!.shap!.map((s) => s.feature)).toEqual(['velocity_v_i', 'split_ratio_r_s', 'recipient_reuse_count']);
    expect(q.payouts[0]).toMatchObject({ id: 'p-9', amountCents: 150_000, msisdn: '2547******78' });
  });

  it('no explanation recorded: risk null, or shap null / empty', () => {
    const q = toOversightQueue(
      queueBody({
        escrows: [
          frozenEscrowView({ escrow_id: 'a', risk: null }),
          frozenEscrowView({ escrow_id: 'b', risk: { ...frozenEscrowView().risk, shap: null, units: null } }),
          frozenEscrowView({ escrow_id: 'c', risk: { ...frozenEscrowView().risk, shap: [] } }),
        ],
      })
    )!;
    expect(q.escrows.map((e) => e.risk?.shap ?? null)).toEqual([null, null, null]);
  });

  it.each([
    ['not an object', null],
    ['missing totals', { ...queueBody(), totals: undefined }],
    ['negative amount', queueBody({ escrows: [frozenEscrowView({ amount: -1 })] })],
    ['bad frozen_at', queueBody({ escrows: [frozenEscrowView({ frozen_at: 'yesterday' })] })],
    ['non-numeric attribution', queueBody({ escrows: [frozenEscrowView({ risk: { ...frozenEscrowView().risk, shap: [{ feature: 'x', attribution: 'big', value: 1 }] } })] })],
    ['security_hold not boolean', queueBody({ escrows: [frozenEscrowView({ security_hold: 'no' })] })],
    ['payout without msisdn', queueBody({ payouts: [unresolvedPayoutView({ msisdn: undefined })] })],
  ])('malformed (%s) → null, never a crash', (_name, body) => {
    expect(toOversightQueue(body)).toBeNull();
  });
});
