/**
 * @file reconcile.sweep.test.ts
 * @description STK Push Query (Daraja mocked via fetch) and the reconciliation sweep worker with
 * a mocked repository (spec gh-6-recon I/O matrix: overdue paid / failed / still processing /
 * callback won the race / Daraja down; throttling; attempt cap; rate limit).
 */

import { DarajaClient, mapStkQueryResponse, STK_QUERY_RESULT_OUTCOMES, type StkQueryOutcome } from '../src/daraja/client';
import type { ReconcileClaim } from '../src/repositories/reconcile.repository';
import { GatewayMetrics } from '../src/services/metrics.service';
import { ReconcileWorker, type ReconcileRepo } from '../src/workers/reconcile.worker';
import { darajaFetch, TEST_DARAJA_CONFIG, type StkHandler } from './support/daraja-fetch';

const OURS = 'ws_CO_09102026101500123';
const answer = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ResponseCode: '0', ResponseDescription: 'The service request has been accepted successsfully', MerchantRequestID: 'm-1', CheckoutRequestID: OURS, ResultCode: '0', ResultDesc: 'The service request is processed successfully.', ...over },
});

let logs: jest.SpyInstance[];
beforeEach(() => {
  logs = (['info', 'warn', 'error', 'log'] as const).map((l) => jest.spyOn(console, l).mockImplementation(() => undefined));
});
afterEach(() => {
  const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
  expect(logged).not.toMatch(/tok-1|tok-2|ck-secret-key|cs-secret-value|bfb279f9aa9b/);
  logs.forEach((s) => s.mockRestore());
});

describe('STK Push Query outcome table', () => {
  it('PAID only with ResponseCode "0", ResultCode "0" and our echoed CheckoutRequestID', () => {
    expect(mapStkQueryResponse(200, answer().body, OURS)).toMatchObject({ kind: 'PAID', resultCode: '0' });
    expect(mapStkQueryResponse(200, answer({ ResultCode: 0 }).body, OURS)).toMatchObject({ kind: 'PAID' }); // numeric 0
    expect(mapStkQueryResponse(200, answer({ CheckoutRequestID: 'ws_CO_OTHER' }).body, OURS)).toMatchObject({ kind: 'UNKNOWN', code: 'checkout_mismatch' });
    expect(mapStkQueryResponse(200, answer({ ResponseCode: '1' }).body, OURS)).toMatchObject({ kind: 'UNKNOWN' });
    expect(mapStkQueryResponse(200, answer({ ResultCode: undefined }).body, OURS)).toMatchObject({ kind: 'UNKNOWN', code: 'result_missing' });
  });

  it.each(['1032', '1037', '2001', '1', '1019'])('ResultCode %s → FAILED with that code', (code) => {
    expect(mapStkQueryResponse(200, answer({ ResultCode: code, ResultDesc: 'x' }).body, OURS)).toEqual({ kind: 'FAILED', resultCode: code, resultDesc: 'x' });
  });

  it.each(['4999', '1001', '1025', '9999'])('ResultCode %s → retried (PENDING), never FAILED', (code) => {
    expect(mapStkQueryResponse(200, answer({ ResultCode: code }).body, OURS).kind).toBe('PENDING');
  });

  it('an unlisted ResultCode is retried (UNKNOWN), never FAILED', () => {
    expect(STK_QUERY_RESULT_OUTCOMES['17']).toBeUndefined();
    expect(mapStkQueryResponse(200, answer({ ResultCode: '17' }).body, OURS)).toMatchObject({ kind: 'UNKNOWN', code: 'result_17' });
  });

  it('500.001.1001 "being processed" → PENDING; other 500.001.1001 → UNKNOWN; token errors; throttling', () => {
    expect(mapStkQueryResponse(500, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }, OURS)).toMatchObject({ kind: 'PENDING' });
    expect(mapStkQueryResponse(500, { errorCode: '500.001.1001', errorMessage: 'Something else' }, OURS)).toMatchObject({ kind: 'UNKNOWN' });
    expect(mapStkQueryResponse(404, { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' }, OURS)).toMatchObject({ kind: 'TOKEN_INVALID' });
    expect(mapStkQueryResponse(401, null, OURS)).toMatchObject({ kind: 'TOKEN_INVALID' });
    expect(mapStkQueryResponse(500, { errorCode: '500.003.02', errorMessage: 'Spike arrest' }, OURS)).toMatchObject({ kind: 'PENDING', throttled: true });
    expect(mapStkQueryResponse(429, null, OURS)).toMatchObject({ kind: 'PENDING', throttled: true });
    expect(mapStkQueryResponse(503, null, OURS)).toMatchObject({ kind: 'UNKNOWN', code: 'http_503' });
  });
});

describe('DarajaClient.stkQuery()', () => {
  function client(stk: StkHandler, cfg: Partial<typeof TEST_DARAJA_CONFIG> = {}) {
    const f = darajaFetch(stk);
    return { c: new DarajaClient({ ...TEST_DARAJA_CONFIG, ...cfg }, f.fn as any, new GatewayMetrics()), ...f };
  }

  it('POSTs the documented query fields (shortcode, EAT password/timestamp, CheckoutRequestID)', async () => {
    const { c, fn, calls } = client(() => answer());
    expect(await c.stkQuery(OURS)).toMatchObject({ kind: 'PAID' });
    const [url] = fn.mock.calls.find(([u]) => String(u).includes('stkpushquery'))!;
    expect(url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query');
    expect(calls.stkBodies[0]).toEqual({ BusinessShortCode: 174379, Password: expect.any(String), Timestamp: expect.stringMatching(/^\d{14}$/), CheckoutRequestID: OURS });
  });

  it('token invalid (404.001.03) → one refresh and one retry of the query', async () => {
    const { c, calls } = client((_b, n) => (n === 1 ? { status: 404, body: { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' } } : answer()));
    expect(await c.stkQuery(OURS)).toMatchObject({ kind: 'PAID' });
    expect(calls.stk).toBe(2);
    expect(calls.oauth).toBe(2);
  });

  it('token rejected again after the refresh → UNKNOWN unreachable (deferred, attempt refunded), never an attempt burnt', async () => {
    const { c, calls } = client(() => ({ status: 404, body: { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' } }));
    expect(await c.stkQuery(OURS)).toMatchObject({ kind: 'UNKNOWN', code: '404.001.03', unreachable: true });
    expect(calls.stk).toBe(2);
  });

  it('timeout / network error → UNKNOWN unreachable (never FAILED)', async () => {
    const t = client(() => 'timeout', { timeoutMs: 50 });
    expect(await t.c.stkQuery(OURS)).toMatchObject({ kind: 'UNKNOWN', code: 'timeout', unreachable: true });
    const n = client(() => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    expect(await n.c.stkQuery(OURS)).toMatchObject({ kind: 'UNKNOWN', code: 'network_ECONNRESET', unreachable: true });
  });
});

// ── Sweep worker ─────────────────────────────────────────────────────────────

function claim(n: number, attempts = 1): ReconcileClaim {
  return { stkRequestId: `stk-${n}`, checkoutRequestId: `ws_CO_${n}`, token: `tok-${n}`, attempts };
}

function harness(outcomes: Record<string, StkQueryOutcome>, claims: ReconcileClaim[], over: Partial<Record<keyof ReconcileRepo, any>> = {}) {
  const repo = {
    sweepExhaustedLeases: jest.fn(async () => 0),
    claimReconcileBatch: jest.fn(async () => claims),
    intakeExistsForRequest: jest.fn(async () => false),
    markPaidUnconfirmed: jest.fn(async () => true),
    markQueryFailed: jest.fn(async () => true),
    releaseReconcileLease: jest.fn(async () => true),
    ...over,
  };
  const daraja = { stkQuery: jest.fn(async (id: string) => outcomes[id]) };
  const sleep = jest.fn(async () => undefined);
  const w = new ReconcileWorker({
    pool: {} as any,
    daraja,
    repo: repo as any,
    sleep,
    config: { qps: 1, maxAttempts: 3, backoffBaseMs: 60_000, backoffMaxMs: 600_000, graceMs: 600_000, maxAgeMs: 7 * 86_400_000, leaseMs: 300_000, batchSize: 10 },
  });
  return { w, repo, daraja, sleep };
}

describe('reconciliation sweep (mocked repository)', () => {
  it('claims overdue ACCEPTED requests: STK_TTL + grace, RECONCILE_MAX_AGE, attempt cap, lease', async () => {
    const { w, repo } = harness({}, []);
    await w.runOnce();
    expect(repo.claimReconcileBatch).toHaveBeenCalledWith(expect.anything(), {
      limit: 10, overdueMs: 180_000 + 600_000, maxAgeMs: 7 * 86_400_000, maxAttempts: 3, leaseMs: 300_000,
    });
    expect(repo.sweepExhaustedLeases).toHaveBeenCalledWith(expect.anything(), 300_000, 3);
  });

  it('overdue paid STK (ResultCode 0) → PAID_UNCONFIRMED with evidence (codes only)', async () => {
    const { w, repo } = harness({ ws_CO_1: { kind: 'PAID', resultCode: '0', resultDesc: 'processed' } }, [claim(1)]);
    expect(await w.runOnce()).toEqual(['paid']);
    const [, c, evidence] = repo.markPaidUnconfirmed.mock.calls[0] as any[];
    expect(c).toMatchObject({ stkRequestId: 'stk-1', token: 'tok-1' });
    expect(JSON.parse(evidence)).toMatchObject({ kind: 'PAID', resultCode: '0' });
  });

  it.each(['1032', '1037', '2001', '1'])('overdue failed STK (%s) → FAILED with the code', async (code) => {
    const { w, repo } = harness({ ws_CO_1: { kind: 'FAILED', resultCode: code, resultDesc: 'no' } }, [claim(1)]);
    expect(await w.runOnce()).toEqual(['failed']);
    expect(repo.markQueryFailed.mock.calls[0].slice(2, 4)).toEqual([code, 'no']);
  });

  it('still processing / 5xx → retried with exponential backoff; the attempt cap → RECONCILE_EXHAUSTED; never FAILED', async () => {
    const { w, repo } = harness(
      {
        ws_CO_1: { kind: 'PENDING', code: 'result_4999', message: 'still processing' },
        ws_CO_2: { kind: 'UNKNOWN', code: 'http_503', message: 'x' },
        ws_CO_3: { kind: 'PENDING', code: '500.001.1001', message: 'being processed' },
      },
      [claim(1, 1), claim(2, 2), claim(3, 3)]
    );
    expect(await w.runOnce()).toEqual(['retry', 'retry', 'exhausted']);
    const calls = repo.releaseReconcileLease.mock.calls.map((c: any[]) => c[2]);
    expect(calls[0]).toMatchObject({ delayMs: 60_000, exhaust: false, queried: true });
    expect(calls[1]).toMatchObject({ delayMs: 120_000, exhaust: false });
    expect(calls[2]).toMatchObject({ delayMs: 240_000, exhaust: true });
    expect(repo.markQueryFailed).not.toHaveBeenCalled();
  });

  it('callback won the race (intake row with that CheckoutRequestID) → skipped, nothing changes, attempt refunded', async () => {
    const { w, repo, daraja } = harness({}, [claim(1)], { intakeExistsForRequest: jest.fn(async () => true) });
    expect(await w.runOnce()).toEqual(['skipped']);
    // Checked by CheckoutRequestID OR bound stk_request_id (a RECONCILED row), like the claim predicate.
    expect(repo.intakeExistsForRequest).toHaveBeenCalledWith(expect.anything(), claim(1));
    expect(daraja.stkQuery).not.toHaveBeenCalled();
    expect(repo.releaseReconcileLease.mock.calls[0][2]).toEqual({ delayMs: 0, refund: true });
    expect(repo.markPaidUnconfirmed).not.toHaveBeenCalled();
  });

  it('Daraja down (timeout) → lease released, attempt refunded, rest of the batch deferred untouched; never FAILED', async () => {
    const { w, repo, daraja } = harness({ ws_CO_1: { kind: 'UNKNOWN', code: 'timeout', message: 'x', unreachable: true } }, [claim(1), claim(2)]);
    expect(await w.runOnce()).toEqual(['deferred', 'deferred']);
    expect(daraja.stkQuery).toHaveBeenCalledTimes(1);
    expect(repo.releaseReconcileLease.mock.calls.map((c: any[]) => c[2].refund)).toEqual([true, true]);
    expect(repo.markQueryFailed).not.toHaveBeenCalled();
  });

  it('throttling (500.003.02 / 429) does not consume an attempt and backs the batch off', async () => {
    const { w, repo, daraja } = harness({ ws_CO_1: { kind: 'PENDING', code: '500.003.02', message: 'x', throttled: true } }, [claim(1, 2), claim(2)]);
    expect(await w.runOnce()).toEqual(['throttled', 'deferred']);
    expect(daraja.stkQuery).toHaveBeenCalledTimes(1);
    expect(repo.releaseReconcileLease.mock.calls[0][2]).toMatchObject({ refund: true, delayMs: 120_000 });
  });

  it('a lost lease (another sweeper) changes nothing', async () => {
    const { w } = harness({ ws_CO_1: { kind: 'PAID', resultCode: '0', resultDesc: '' } }, [claim(1)], { markPaidUnconfirmed: jest.fn(async () => false) });
    expect(await w.runOnce()).toEqual(['lease_lost']);
  });

  it('RECONCILE_QPS: queries are spaced at least 1/qps apart', async () => {
    const paid: StkQueryOutcome = { kind: 'PAID', resultCode: '0', resultDesc: '' };
    const { w, sleep } = harness({ ws_CO_1: paid, ws_CO_2: paid, ws_CO_3: paid }, [claim(1), claim(2), claim(3)]);
    await w.runOnce();
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of sleep.mock.calls as any[]) expect(ms).toBeGreaterThan(900);
    expect(w.lastSweepAt).toBeInstanceOf(Date);
    expect(w.counters.paid).toBe(3);
  });
});
