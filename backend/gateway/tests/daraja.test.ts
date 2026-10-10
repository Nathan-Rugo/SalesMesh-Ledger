/**
 * @file daraja.test.ts
 * @description Daraja STK Push client (spec gh-5), Daraja mocked via fetch: EAT password and
 * timestamp, request fields and limits, OAuth cache / single flight / early refresh, the
 * errorCode → outcome table, the one token-retry, and "never retried blindly".
 */

import { DarajaClient, darajaConfig, mapStkResponse, stkPassword } from '../src/daraja/client';
import { GatewayMetrics } from '../src/services/metrics.service';
import { accepted, darajaFetch, TEST_DARAJA_CONFIG, type StkHandler } from './support/daraja-fetch';

const PUSH = { amount: 1500, phone: '254712345678', accountReference: 'AG042' };

function client(stk: StkHandler, oauth?: Parameters<typeof darajaFetch>[1], cfg: Partial<typeof TEST_DARAJA_CONFIG> = {}) {
  const f = darajaFetch(stk, oauth);
  const metrics = new GatewayMetrics();
  return { c: new DarajaClient({ ...TEST_DARAJA_CONFIG, ...cfg }, f.fn as any, metrics), ...f, metrics };
}

let logs: jest.SpyInstance[];
beforeEach(() => {
  logs = (['info', 'warn', 'error', 'log'] as const).map((l) => jest.spyOn(console, l).mockImplementation(() => undefined));
});
afterEach(() => {
  const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
  // Never the customer MSISDN, the OAuth token, or a Daraja secret.
  expect(logged).not.toMatch(/712345678|tok-1|tok-2|ck-secret-key|cs-secret-value|bfb279f9aa9b/);
  logs.forEach((s) => s.mockRestore());
});

describe('request', () => {
  it('Password = base64(shortcode + passkey + timestamp), timestamp in EAT', () => {
    const { password, timestamp } = stkPassword('174379', 'pk', new Date('2026-10-09T21:30:05Z'));
    expect(timestamp).toBe('20261010003005'); // 00:30:05 EAT the next day
    expect(Buffer.from(password, 'base64').toString()).toBe('174379pk20261010003005');
  });

  it('sends the documented STK Push fields (Paybill); AccountReference ≤ 12, TransactionDesc ≤ 13, integer amount', async () => {
    const { c, calls } = client(() => accepted({ CheckoutRequestID: 'ws_CO_1' }), undefined, { transactionDesc: 'SalesMesh pay ok' });
    const out = await c.stkPush({ ...PUSH, accountReference: 'AG042-LONGER-CODE' });
    expect(out).toMatchObject({ kind: 'ACCEPTED', checkoutRequestId: 'ws_CO_1', responseCode: '0' });
    const b = calls.stkBodies[0];
    expect(b).toMatchObject({
      BusinessShortCode: 174379,
      TransactionType: 'CustomerPayBillOnline',
      Amount: 1500,
      PartyA: 254712345678,
      PartyB: 174379,
      PhoneNumber: 254712345678,
      CallBackURL: TEST_DARAJA_CONFIG.callbackUrl,
    });
    expect(b.AccountReference.length).toBeLessThanOrEqual(12);
    expect(b.TransactionDesc.length).toBeLessThanOrEqual(13);
    expect(b.Timestamp).toMatch(/^\d{14}$/);
    expect(Buffer.from(b.Password, 'base64').toString()).toBe(`174379${TEST_DARAJA_CONFIG.passkey}${b.Timestamp}`);
    expect(calls.stkAuth[0]).toBe('Bearer tok-1');
  });

  it('Buy Goods: BusinessShortCode (store) can differ from PartyB (till)', async () => {
    const { c, calls } = client(() => accepted(), undefined, { transactionType: 'CustomerBuyGoodsOnline' as any, shortCode: '600000', partyB: '600111' });
    await c.stkPush(PUSH);
    expect(calls.stkBodies[0]).toMatchObject({ TransactionType: 'CustomerBuyGoodsOnline', BusinessShortCode: 600000, PartyB: 600111 });
  });
});

describe('OAuth token', () => {
  it('is cached across pushes', async () => {
    const { c, calls } = client(() => accepted());
    await c.stkPush(PUSH);
    await c.stkPush(PUSH);
    expect(calls.oauth).toBe(1);
  });

  it('is refreshed before expiry (60 s early)', async () => {
    const { c, calls } = client(() => accepted(), () => ({ status: 200, body: { access_token: 'tok-1', expires_in: '30' } }));
    await c.stkPush(PUSH);
    await c.stkPush(PUSH);
    expect(calls.oauth).toBe(2);
  });

  it('concurrent refreshes are coalesced (single flight)', async () => {
    const { c, calls } = client(() => accepted());
    await Promise.all(Array.from({ length: 8 }, () => c.accessToken()));
    expect(calls.oauth).toBe(1);
  });

  it('a failed token fetch is retried once (the token fetch only); then the push is REJECTED, not sent', async () => {
    let n = 0;
    const flaky = client(() => accepted(), () => (++n === 1 ? { status: 500 } : { status: 200, body: { access_token: 'tok-1', expires_in: 3599 } }));
    expect((await flaky.c.stkPush(PUSH)).kind).toBe('ACCEPTED');
    expect(flaky.calls.oauth).toBe(2);

    const down = client(() => accepted(), () => new Error('ECONNREFUSED'));
    expect(await down.c.stkPush(PUSH)).toMatchObject({ kind: 'REJECTED', code: 'oauth_unavailable' });
    expect(down.calls.oauth).toBe(2);
    expect(down.calls.stk).toBe(0);
  });

  it('invalid/expired token answer (401 or 404.001.03) → refresh, then exactly one push retry', async () => {
    let tok = 0;
    const oauth = () => ({ status: 200, body: { access_token: `tok-${++tok}`, expires_in: 3599 } });
    const r = client((_b, call) => (call === 1 ? { status: 401, body: { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' } } : accepted()), oauth);
    expect((await r.c.stkPush(PUSH)).kind).toBe('ACCEPTED');
    expect(r.calls.stk).toBe(2);
    expect(r.calls.stkAuth).toEqual(['Bearer tok-1', 'Bearer tok-2']);

    const still = client(() => ({ status: 401, body: {} }), oauth);
    expect((await still.c.stkPush(PUSH)).kind).toBe('REJECTED');
    expect(still.calls.stk).toBe(2); // never a third
  });
});

describe('outcome mapping (never retried blindly)', () => {
  it.each([
    ['ResponseCode "0" → ACCEPTED', accepted({ CheckoutRequestID: 'ws_CO_9' }), 'ACCEPTED'],
    ['numeric ResponseCode 0 compares as the string "0"', accepted({ ResponseCode: 0 }), 'ACCEPTED'],
    ['ResponseCode "1" → REJECTED', { status: 200, body: { ResponseCode: '1', ResponseDescription: 'Rejected' } }, 'REJECTED'],
    ['"0" without a CheckoutRequestID → UNKNOWN', { status: 200, body: { ResponseCode: '0' } }, 'UNKNOWN'],
    ['400.002.02 invalid field → REJECTED', { status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' } }, 'REJECTED'],
    ['500.001.1001 definitive → REJECTED', { status: 500, body: { errorCode: '500.001.1001', errorMessage: 'Unable to lock subscriber' } }, 'REJECTED'],
    ['500.003.03 quota → REJECTED', { status: 500, body: { errorCode: '500.003.03', errorMessage: 'Quota Violation' } }, 'REJECTED'],
    ['500.003.1001 internal → UNKNOWN', { status: 500, body: { errorCode: '500.003.1001', errorMessage: 'Internal Server Error' } }, 'UNKNOWN'],
    ['unlisted 4xx errorCode → REJECTED', { status: 400, body: { errorCode: '400.999.99' } }, 'REJECTED'],
    ['503 without a body → UNKNOWN', { status: 503, raw: '<html>gateway</html>' }, 'UNKNOWN'],
    ['200 with garbage → UNKNOWN', { status: 200, raw: 'not json' }, 'UNKNOWN'],
  ])('%s', async (_name, response, kind) => {
    const { c, calls } = client(() => response as any);
    expect((await c.stkPush(PUSH)).kind).toBe(kind);
    expect(calls.stk).toBe(1);
  });

  it('timeout after sending → UNKNOWN, never retried', async () => {
    const { c, calls, metrics } = client(() => 'timeout', undefined, { timeoutMs: 50 });
    expect(await c.stkPush(PUSH)).toMatchObject({ kind: 'UNKNOWN', code: 'timeout' });
    expect(calls.stk).toBe(1);
    expect(metrics.snapshot().darajaLatencyMs.samples).toBe(1);
  });

  it('one overall deadline bounds every sub-call: slow OAuth retries eat the budget → not sent (REJECTED)', async () => {
    const slowOauth = client(() => accepted(), () => new Error('ECONNRESET'), { totalTimeoutMs: 120, oauthTimeoutMs: 100 });
    const started = Date.now();
    expect((await slowOauth.c.stkPush(PUSH)).kind).toBe('REJECTED');
    expect(slowOauth.calls.stk).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('the push timeout is cut to what is left of the overall deadline (→ UNKNOWN, sent)', async () => {
    const r = client(() => 'timeout', undefined, { totalTimeoutMs: 150, timeoutMs: 10_000 });
    const started = Date.now();
    expect(await r.c.stkPush(PUSH)).toMatchObject({ kind: 'UNKNOWN', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a token-invalid retry never runs past the overall deadline', async () => {
    let tok = 0;
    const r = client(
      async (_b, call) => {
        if (call === 1) {
          await new Promise((res) => setTimeout(res, 150));
          return { status: 401, body: { errorCode: '404.001.03' } };
        }
        return accepted();
      },
      () => ({ status: 200, body: { access_token: `tok-${++tok}`, expires_in: 3599 } }),
      { totalTimeoutMs: 100 }
    );
    expect((await r.c.stkPush(PUSH)).kind).toBe('REJECTED'); // budget gone: the retry is not sent
    expect(r.calls.stk).toBe(1);
  });

  it('connection reset after sending → UNKNOWN; connection refused (never sent) → REJECTED', async () => {
    const reset = client(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    expect(await reset.c.stkPush(PUSH)).toMatchObject({ kind: 'UNKNOWN', code: 'network_ECONNRESET' });
    const refused = client(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect(await refused.c.stkPush(PUSH)).toMatchObject({ kind: 'REJECTED', code: 'network_ECONNREFUSED' });
    expect(reset.calls.stk + refused.calls.stk).toBe(2);
  });

  it('error messages are sanitised (no long digit runs)', () => {
    const m = mapStkResponse(400, { errorCode: '400.002.02', errorMessage: 'Invalid PhoneNumber 254712345678' });
    expect(m).toMatchObject({ kind: 'REJECTED', message: 'Invalid PhoneNumber [digits]' });
  });
});

describe('configuration', () => {
  const env = {
    DARAJA_CONSUMER_KEY: 'k',
    DARAJA_CONSUMER_SECRET: 's',
    DARAJA_BUSINESS_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'p',
    MPESA_CALLBACK_TOKEN: 'cbtok123',
    DARAJA_CALLBACK_URL: 'https://gw.example/api/v1/mpesa/callback/cbtok123',
  };
  it('sandbox / production base URLs; Paybill default; Buy Goods with its own PartyB', () => {
    expect(darajaConfig(env)).toMatchObject({ baseUrl: 'https://sandbox.safaricom.co.ke', transactionType: 'CustomerPayBillOnline', partyB: '174379' });
    expect(darajaConfig({ ...env, DARAJA_ENVIRONMENT: 'production', DARAJA_TRANSACTION_TYPE: 'BuyGoods', DARAJA_PARTY_B: '600111' })).toMatchObject({
      baseUrl: 'https://api.safaricom.co.ke',
      transactionType: 'CustomerBuyGoodsOnline',
      partyB: '600111',
    });
  });
  it('refuses missing credentials, a non-https callback, an unknown environment or type', () => {
    expect(() => darajaConfig({})).toThrow(/missing DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET/);
    expect(() => darajaConfig({ ...env, DARAJA_CALLBACK_URL: 'http://gw.example/cb' })).toThrow(/https/);
    expect(() => darajaConfig({ ...env, DARAJA_ENVIRONMENT: 'staging' })).toThrow(/sandbox or production/);
    expect(() => darajaConfig({ ...env, DARAJA_TRANSACTION_TYPE: 'B2C' })).toThrow(/Paybill or BuyGoods/);
  });
  it('refuses a callback URL with an unexpanded ${...} or one that does not end with the callback token', () => {
    expect(() =>
      darajaConfig({ ...env, DARAJA_CALLBACK_URL: 'https://gw.example/api/v1/mpesa/callback/${MPESA_CALLBACK_TOKEN}' })
    ).toThrow(/unexpanded/);
    expect(() => darajaConfig({ ...env, DARAJA_CALLBACK_URL: 'https://gw.example/api/v1/mpesa/callback/other' })).toThrow(
      /must end with \/api\/v1\/mpesa\/callback\/<MPESA_CALLBACK_TOKEN>/
    );
    expect(() => darajaConfig({ ...env, MPESA_CALLBACK_TOKEN: '' })).toThrow(/MPESA_CALLBACK_TOKEN must be set/);
    // The error never echoes the token.
    try {
      darajaConfig({ ...env, DARAJA_CALLBACK_URL: 'https://gw.example/x' });
    } catch (e) {
      expect((e as Error).message).not.toContain('cbtok123');
    }
    expect(darajaConfig(env).totalTimeoutMs).toBe(25_000);
    expect(darajaConfig({ ...env, DARAJA_TOTAL_TIMEOUT_MS: '9000' }).totalTimeoutMs).toBe(9000);
  });
});
