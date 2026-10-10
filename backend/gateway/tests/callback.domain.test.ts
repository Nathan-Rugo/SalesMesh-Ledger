/**
 * @file callback.domain.test.ts
 * @description Pure callback logic: parser, time, counterparty, redaction, agent codes, keyed hashes.
 */

import {
  extractIngress,
  msisdnHash,
  normaliseAgentCode,
  parseDarajaTime,
  parseStoredCallback,
  receiptCounterpartyHash,
  redactPayload,
  counterpartyHash,
  toCents,
  centsToDecimal,
  CallbackParseError,
} from '../src/domain/callback';
import { assertPiiKey, keyedHash, keyedHashMatches, KEYED_HASH_RE } from '../src/config/pii';
import { buildRawRequest } from '../src/domain/risk_request';

const stk = (items: Array<{ Name: string; Value?: unknown }>, extra: Record<string, unknown> = {}) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: 'ws_CO_191220191020363925',
      ResultCode: 0,
      ResultDesc: 'ok',
      CallbackMetadata: { Item: items },
      ...extra,
    },
  },
});

const STK_ITEMS = [
  { Name: 'Amount', Value: 1500.0 },
  { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
  { Name: 'TransactionDate', Value: 20191219102115 },
  { Name: 'PhoneNumber', Value: 254708374149 },
];

describe('test environment', () => {
  it('runs under TZ=Africa/Nairobi (EAT, UTC+3)', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-180);
  });
});

describe('PII keyed hashing', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is HMAC-SHA256 with a key-id prefix and domain separation', () => {
    const a = keyedHash('payload', 'x');
    const b = keyedHash('counterparty', 'x');
    expect(a).toMatch(KEYED_HASH_RE);
    expect(a.startsWith('k1:')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('refuses keys shorter than 32 bytes, accepts hex/base64 encodings', () => {
    process.env.PII_HMAC_KEY = 'short';
    expect(() => assertPiiKey()).toThrow(/32 bytes/);
    delete process.env.PII_HMAC_KEY;
    expect(() => assertPiiKey()).toThrow(/not set/);
    process.env.PII_HMAC_KEY = `hex:${'ab'.repeat(32)}`;
    expect(() => assertPiiKey()).not.toThrow();
    process.env.PII_HMAC_KEY = `base64:${Buffer.alloc(32, 7).toString('base64')}`;
    expect(() => assertPiiKey()).not.toThrow();
  });

  it('verifies hashes made under the previous key during a rotation', () => {
    const old = keyedHash('payload', 'body');
    process.env.PII_HMAC_KEY_PREVIOUS = process.env.PII_HMAC_KEY;
    process.env.PII_HMAC_KEY_PREVIOUS_ID = 'k1';
    process.env.PII_HMAC_KEY = 'a-brand-new-rotated-key-of-at-least-32-bytes!!';
    process.env.PII_HMAC_KEY_ID = 'k2';
    expect(keyedHash('payload', 'body').startsWith('k2:')).toBe(true);
    expect(keyedHashMatches(old, 'payload', 'body')).toBe(true);
    expect(keyedHashMatches(old, 'payload', 'other')).toBe(false);
    expect(keyedHashMatches('k9:' + 'a'.repeat(64), 'payload', 'body')).toBeNull();
  });
});

describe('amounts (integer cents, Daraja string/number coercion)', () => {
  it.each([
    [1500, 150000],
    ['500.00', 50000],
    [1500.5, 150050],
    ['0.01', 1],
    ['12.340', 1234],
  ])('%p → %p cents', (v, cents) => expect(toCents(v)).toBe(cents));

  it.each(['abc', '0', '-50', '', null, '1e3', '1.234', '12345678901'])('%p is rejected', (v) => {
    expect(toCents(v)).toBeNull();
  });

  it('formats cents exactly', () => {
    expect(centsToDecimal(150050)).toBe('1500.50');
    expect(centsToDecimal(7)).toBe('0.07');
  });
});

describe('payment time (yyyyMMddHHmmss EAT → UTC)', () => {
  it('converts EAT to UTC regardless of the process time zone', () => {
    expect(parseDarajaTime(20191219102115)!.toISOString()).toBe('2019-12-19T07:21:15.000Z');
    expect(parseDarajaTime('20260101013000')!.toISOString()).toBe('2025-12-31T22:30:00.000Z');
  });

  it.each(['', '2019121910211', '20190231102115', '20191219252115', 'garbage', null])('%p is unparseable', (v) => {
    expect(parseDarajaTime(v)).toBeNull();
  });
});

describe('C2B agent code', () => {
  it('trims and upper-cases " ag042 " → AG042', () => {
    expect(normaliseAgentCode(' ag042 ')).toBe('AG042');
  });
  it('rejects empty and over-long codes', () => {
    expect(normaliseAgentCode('   ')).toBeNull();
    expect(normaliseAgentCode(undefined)).toBeNull();
    expect(normaliseAgentCode('X'.repeat(33))).toBeNull();
  });
});

describe('counterparty hash', () => {
  it('normalises MSISDN formats to the same HMAC', () => {
    const h = msisdnHash('254708374149');
    expect(h).toMatch(KEYED_HASH_RE);
    expect(msisdnHash(254708374149)).toBe(h);
    expect(msisdnHash('0708374149')).toBe(h);
    expect(msisdnHash('+254 708 374 149')).toBe(h);
    expect(msisdnHash('254708374150')).not.toBe(h);
  });

  it('treats masked MSISDNs as absent', () => {
    expect(msisdnHash('2547******149')).toBeNull();
    expect(msisdnHash('2547XXXXX149')).toBeNull();
    expect(msisdnHash('')).toBeNull();
  });

  it('HMACs a provider-hashed MSISDN as-is', () => {
    const provider = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(msisdnHash(provider)).toBe(msisdnHash(provider.toUpperCase()));
    expect(msisdnHash(provider)).toMatch(KEYED_HASH_RE);
  });

  it('absent → HMAC(receipt): unique per receipt, never a false reuse', () => {
    const a = counterpartyHash({ counterpartyHash: null, receipt: 'NLJ7RT61SV' });
    expect(a).toBe(receiptCounterpartyHash('NLJ7RT61SV'));
    expect(a).not.toBe(counterpartyHash({ counterpartyHash: null, receipt: 'NLJ7RT61SW' }));
  });
});

describe('redaction of the stored payload', () => {
  it('replaces the STK PhoneNumber with its HMAC', () => {
    const red = redactPayload(stk(STK_ITEMS)) as any;
    const items = red.Body.stkCallback.CallbackMetadata.Item;
    const phone = items.find((i: any) => i.Name === 'PhoneNumber').Value;
    expect(phone).toBe(msisdnHash('254708374149'));
    expect(JSON.stringify(red)).not.toMatch(/2547\d{8}/);
    expect(items.find((i: any) => i.Name === 'MpesaReceiptNumber').Value).toBe('NLJ7RT61SV');
  });

  it('redacts C2B MSISDN, payer names and a phone-like BillRefNumber', () => {
    const red = redactPayload({
      TransID: 'OEI2AK4Q16',
      TransAmount: '500.00',
      BillRefNumber: '0708374149',
      MSISDN: '254708374149',
      FirstName: 'John',
      MiddleName: 'J',
      LastName: 'Doe',
    }) as any;
    expect(red.MSISDN).toBe(msisdnHash('254708374149'));
    expect([red.FirstName, red.MiddleName, red.LastName]).toEqual(['[redacted]', '[redacted]', '[redacted]']);
    expect(red.BillRefNumber).toMatch(KEYED_HASH_RE);
    expect(JSON.stringify(red)).not.toMatch(/John|Doe|07083|2547\d{8}/);
  });

  it('marks a masked MSISDN rather than storing it', () => {
    const red = redactPayload({ TransID: 'OEI2AK4Q16', TransAmount: '1', MSISDN: '2547*****149' }) as any;
    expect(red.MSISDN).toBe('[masked]');
  });

  it('leaves the caller’s object untouched', () => {
    const body = stk(STK_ITEMS);
    redactPayload(body);
    expect(body.Body.stkCallback.CallbackMetadata.Item[3].Value).toBe(254708374149);
  });
});

describe('hot-path ingress validation', () => {
  it('accepts numeric/string Daraja fields', () => {
    expect(extractIngress(stk(STK_ITEMS))).toEqual({ kind: 'ok', receipt: 'NLJ7RT61SV', amountCents: 150000, channel: 'DARAJA_STK' });
    expect(extractIngress(stk(STK_ITEMS, { ResultCode: '0' })).kind).toBe('ok');
    expect(extractIngress({ TransID: 'OEI2AK4Q16', TransAmount: '500.00' })).toMatchObject({ channel: 'C2B', amountCents: 50000 });
  });
  it('drops cancelled STK, bad receipts and unknown shapes', () => {
    expect(extractIngress(stk(STK_ITEMS, { ResultCode: 1032 })).kind).toBe('drop');
    expect(extractIngress({ TransID: 'bad', TransAmount: '1' }).kind).toBe('drop');
    expect(extractIngress({ hello: 1 }).kind).toBe('drop');
  });
});

describe('stored-payload parser (worker side)', () => {
  it('parses a redacted STK payload: receipt, amount, time, counterparty, CheckoutRequestID', () => {
    const parsed = parseStoredCallback(redactPayload(stk(STK_ITEMS)));
    expect(parsed).toMatchObject({
      receipt: 'NLJ7RT61SV',
      amountCents: 150000,
      channel: 'DARAJA_STK',
      checkoutRequestId: 'ws_CO_191220191020363925',
      billRefNumber: null,
      counterpartyHash: msisdnHash('254708374149'),
    });
    expect(parsed.paymentTime!.toISOString()).toBe('2019-12-19T07:21:15.000Z');
  });

  it('parses a redacted C2B payload; unparseable time → null (worker falls back to received_at)', () => {
    const parsed = parseStoredCallback(
      redactPayload({ TransID: 'OEI2AK4Q16', TransAmount: 500, TransTime: 'whenever', BillRefNumber: ' ag042 ', MSISDN: '2547****49' })
    );
    expect(parsed).toMatchObject({ channel: 'C2B', billRefNumber: 'ag042', counterpartyHash: null, paymentTime: null });
  });

  it('throws CallbackParseError (terminal) on an unusable payload', () => {
    expect(() => parseStoredCallback({ nope: true })).toThrow(CallbackParseError);
  });
});

describe('raw-mode request builder', () => {
  const row = (i: number) => ({
    transaction_id: `RCPT${String(i).padStart(6, '0')}`,
    agent_id: 'agent-1',
    timestamp: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
    amount: 100,
    counterparty_id: 'k1:' + 'a'.repeat(64),
  });

  it('keeps the most recent rows when the body would exceed the ml-engine limit', () => {
    const history = Array.from({ length: 500 }, (_, i) => row(i));
    const { request, truncated } = buildRawRequest({
      receipt: 'NLJ7RT61SV', agentId: 'agent-1', at: new Date(Date.UTC(2026, 0, 1)), amount: 10,
      counterpartyHash: 'k1:' + 'b'.repeat(64), history, maxBodyBytes: 20_000,
    });
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(20_000);
    expect(request.history[0]).toEqual(history[0]);
  });

  it('empty history → []', () => {
    const { request, truncated } = buildRawRequest({
      receipt: 'NLJ7RT61SV', agentId: 'agent-1', at: new Date(), amount: 10,
      counterpartyHash: 'k1:' + 'b'.repeat(64), history: [], maxBodyBytes: 500_000,
    });
    expect(request.history).toEqual([]);
    expect(truncated).toBe(false);
  });
});
