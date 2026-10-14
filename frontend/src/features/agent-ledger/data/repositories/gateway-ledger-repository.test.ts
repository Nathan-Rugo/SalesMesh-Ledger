import { describe, expect, it } from 'vitest';
import { HttpClient } from '@/core/data/http-client';
import { ok } from '@/core/domain/result';
import { bodyOf, fakeFetch, json, ledgerBody, payoutView, token } from '@/test/fake-gateway';
import { GatewayLedgerDataSource } from '../datasources/gateway-ledger-datasource';
import { GatewayLedgerRepository } from './gateway-ledger-repository';

const GET = '/api/v1/payouts';
const CLAIM = '/api/v1/payouts/claim';
const LINES = '/api/v1/payout-destinations';

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const gw = fakeFetch(routes);
  const http = new HttpClient(gw.fetch);
  let refreshes = 0;
  http.setTokenSource({ currentAccessToken: () => token(1), refreshAccessToken: async () => (refreshes++, ok(token(2))) });
  return { gw, repo: new GatewayLedgerRepository(new GatewayLedgerDataSource(http)), refreshes: () => refreshes };
}

describe('GatewayLedgerRepository (fake gateway)', () => {
  it('snapshot is single-flight: concurrent callers share one GET', async () => {
    const { gw, repo } = setup({ [GET]: () => json(200, ledgerBody()) });
    const [a, b, c] = await Promise.all([repo.snapshot(), repo.snapshot(), repo.snapshot()]);
    expect(gw.count(GET)).toBe(1);
    expect(a.ok && b.ok && c.ok).toBe(true);
    await repo.snapshot();
    expect(gw.count(GET)).toBe(2);
  });

  it('a snapshot after a claim never joins a GET that started before the POST', async () => {
    let gets = 0;
    let releaseFirst: (r: Response) => void = () => undefined;
    const { gw, repo } = setup({
      // Odd GETs hang (a poll in flight across the POST); even ones answer at once.
      [GET]: () => (++gets % 2 === 1 ? (new Promise<Response>((r) => (releaseFirst = r)) as unknown as Response) : json(200, ledgerBody({ balance: { cents: 0, payable_now: 0 } }))),
      [CLAIM]: () => json(202, { payout: payoutView() }),
      [LINES]: () => json(202, { destination: { destination_id: 'd', msisdn: 'm', status: 'PENDING_VERIFICATION', reject_reason: null, cooling_off_until: null } }),
    });
    const poll = repo.snapshot(); // in flight with the pre-claim balance
    await repo.claim('4826', '1');
    const after = await repo.snapshot();
    expect(gw.count(GET)).toBe(2);
    expect(after).toMatchObject({ ok: true, value: { balance: { cents: 0 } } });
    releaseFirst(json(200, ledgerBody()));
    await poll;

    const poll2 = repo.snapshot();
    await repo.verifyPayoutLine('4826');
    await repo.snapshot();
    expect(gw.count(GET)).toBe(4);
    releaseFirst(json(200, ledgerBody()));
    await poll2;
  });

  it('a malformed body is unexpected, never a crash', async () => {
    const { repo } = setup({ [GET]: () => json(200, { balance: 'lots' }) });
    expect(await repo.snapshot()).toEqual({ ok: false, error: { kind: 'unexpected', status: 200 } });
  });

  it('claim posts {pin, disclosure_version}; 202 maps the payout', async () => {
    const { gw, repo } = setup({ [CLAIM]: () => json(202, { payout: payoutView() }) });
    const r = await repo.claim('4826', '1');
    expect(r).toMatchObject({ ok: true, value: { status: 'SENT', amountCents: 123_500 } });
    expect(bodyOf(gw.calls[0]!.init)).toEqual({ pin: '4826', disclosure_version: '1' });
  });

  it.each([
    [409, 'payout_in_progress'],
    [409, 'below_minimum'],
    [409, 'no_active_destination'],
    [409, 'destination_changing'],
    [409, 'above_maximum'],
    [409, 'disclosure_changed'],
    [503, 'temporarily_unavailable'],
    [503, 'payouts_disabled'],
    [502, 'payout_failed'],
  ])('%i %s → payout_refused with the code', async (status, code) => {
    const { repo } = setup({ [CLAIM]: () => json(status, { error: code, payout: payoutView({ status: 'FAILED' }) }) });
    expect(await repo.claim('4826', '1')).toEqual({ ok: false, error: { kind: 'payout_refused', code } });
  });

  it('a bare 503 (the rewrite, gateway down) is unavailable; an unknown 409 is unexpected', async () => {
    expect(await setup({ [GET]: () => json(503) }).repo.snapshot()).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(await setup({ [GET]: () => json(409, { error: 'nope' }) }).repo.snapshot()).toEqual({ ok: false, error: { kind: 'unexpected', status: 409 } });
  });

  it('a wrong claim PIN (401 invalid_credentials) is never refreshed and retried: one POST, one lockout attempt', async () => {
    const { gw, repo, refreshes } = setup({ [CLAIM]: () => json(401, { error: 'invalid_credentials' }) });
    expect(await repo.claim('0000', '1')).toEqual({ ok: false, error: { kind: 'invalid_credentials' } });
    expect(gw.count(CLAIM)).toBe(1);
    expect(refreshes()).toBe(0);
  });

  it('429 keeps Retry-After', async () => {
    const { repo } = setup({ [CLAIM]: () => json(429, { error: 'too_many_attempts' }, { 'Retry-After': '90' }) });
    expect(await repo.claim('4826', '1')).toEqual({ ok: false, error: { kind: 'throttled', retryAfterS: 90 } });
  });

  it('verify line: 202 PENDING_VERIFICATION; 409 / 502 refusals', async () => {
    const pending = { destination_id: 'd', msisdn: 'm', status: 'PENDING_VERIFICATION', reject_reason: null, cooling_off_until: null };
    expect(await setup({ [LINES]: () => json(202, { destination: pending }) }).repo.verifyPayoutLine('4826')).toMatchObject({ ok: true, value: { status: 'PENDING_VERIFICATION' } });
    for (const [s, code] of [[409, 'already_active'], [409, 'destination_pending'], [409, 'phone_not_payable'], [502, 'verification_failed']] as const) {
      expect(await setup({ [LINES]: () => json(s, { error: code }) }).repo.verifyPayoutLine('4826')).toEqual({ ok: false, error: { kind: 'payout_refused', code } });
    }
  });
});
