/** Programmable Daraja stand-in for fetch (OAuth + STK Push endpoints). */

export interface FakeResponse {
  status: number;
  body?: unknown;
  raw?: string;
}

export type StkHandler = (body: any, call: number) => FakeResponse | Promise<FakeResponse> | 'timeout' | Error;

export function accepted(over: Record<string, unknown> = {}): FakeResponse {
  return {
    status: 200,
    body: {
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: `ws_CO_${Math.random().toString(36).slice(2, 12)}`,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
      ...over,
    },
  };
}

export function darajaFetch(stk: StkHandler, oauth: () => FakeResponse | Error = () => ({ status: 200, body: { access_token: 'tok-1', expires_in: '3599' } })) {
  const calls = { oauth: 0, stk: 0, stkBodies: [] as any[], stkAuth: [] as string[] };
  const respond = (r: FakeResponse) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: async () => (r.raw !== undefined ? r.raw : r.body === undefined ? '' : JSON.stringify(r.body)),
  });
  const fn = jest.fn(async (url: string, init: any) => {
    if (url.includes('/oauth/v1/generate')) {
      calls.oauth += 1;
      const r = oauth();
      if (r instanceof Error) throw r;
      return respond(r);
    }
    calls.stk += 1;
    const body = JSON.parse(init.body);
    calls.stkBodies.push(body);
    calls.stkAuth.push(init.headers.Authorization);
    const r = await stk(body, calls.stk);
    if (r === 'timeout') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
      });
    }
    if (r instanceof Error) throw r;
    return respond(r);
  });
  return { fn, calls };
}

export const TEST_DARAJA_CONFIG = {
  baseUrl: 'https://sandbox.safaricom.co.ke',
  consumerKey: 'ck-secret-key',
  consumerSecret: 'cs-secret-value',
  shortCode: '174379',
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  partyB: '174379',
  transactionType: 'CustomerPayBillOnline' as const,
  callbackUrl: 'https://gw.example/api/v1/mpesa/callback/tok',
  transactionDesc: 'SalesMesh',
  // Generous: these tests are not about timing; the timeout cases set their own short value.
  timeoutMs: 5000,
  oauthTimeoutMs: 5000,
  totalTimeoutMs: 20_000,
};
