/** Programmable Daraja stand-in for fetch (OAuth, STK Push and B2C endpoints). */

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

/** A synchronous B2C acceptance (the result arrives later on the ResultURL). */
export function b2cAccepted(over: Record<string, unknown> = {}): FakeResponse {
  return {
    status: 200,
    body: {
      ConversationID: `AG_${Math.random().toString(36).slice(2, 12)}`,
      OriginatorConversationID: 'echo',
      ResponseCode: '0',
      ResponseDescription: 'Accept the service request successfully.',
      ...over,
    },
  };
}

/** A B2C result callback body (ReceiverPartyPublicName in Daraja's "2547… - NAME" form). */
export function b2cResultBody(originatorConversationId: string, o: { code?: number; name?: string | null; conversationId?: string } = {}) {
  const params: any[] = [{ Key: 'TransactionAmount', Value: 1 }, { Key: 'TransactionReceipt', Value: 'NLJ41HAY6Q' }];
  if (o.name !== null) params.push({ Key: 'ReceiverPartyPublicName', Value: o.name ?? '254712345678 - JOHN KAMAU' });
  return {
    Result: {
      ResultType: 0,
      ResultCode: o.code ?? 0,
      ResultDesc: o.code ? 'The service request failed.' : 'The service request is processed successfully.',
      OriginatorConversationID: originatorConversationId,
      ConversationID: o.conversationId ?? 'AG_20261012_1',
      TransactionID: 'NLJ41HAY6Q',
      ResultParameters: { ResultParameter: params },
      ReferenceData: { ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'https://gw.example/api/v1/mpesa/b2c/timeout/tok' } },
    },
  };
}

export function darajaFetch(
  stk: StkHandler,
  oauth: () => FakeResponse | Error = () => ({ status: 200, body: { access_token: 'tok-1', expires_in: '3599' } }),
  b2c: StkHandler = () => b2cAccepted()
) {
  const calls = { oauth: 0, stk: 0, stkBodies: [] as any[], stkAuth: [] as string[], b2c: 0, b2cBodies: [] as any[] };
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
    const body = JSON.parse(init.body);
    let r: Awaited<ReturnType<StkHandler>>;
    if (url.includes('/mpesa/b2c/')) {
      calls.b2c += 1;
      calls.b2cBodies.push(body);
      r = await b2c(body, calls.b2c);
    } else {
      calls.stk += 1;
      calls.stkBodies.push(body);
      calls.stkAuth.push(init.headers.Authorization);
      r = await stk(body, calls.stk);
    }
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

export const TEST_B2C_CONFIG = {
  baseUrl: 'https://sandbox.safaricom.co.ke',
  consumerKey: 'ck-secret-key',
  consumerSecret: 'cs-secret-value',
  shortCode: '600000',
  initiatorName: 'testapi',
  securityCredential: 'SECURITY-CREDENTIAL-SECRET',
  resultUrl: 'https://gw.example/api/v1/mpesa/b2c/result/tok',
  timeoutUrl: 'https://gw.example/api/v1/mpesa/b2c/timeout/tok',
  timeoutMs: 5000,
  oauthTimeoutMs: 5000,
  totalTimeoutMs: 20_000,
};
