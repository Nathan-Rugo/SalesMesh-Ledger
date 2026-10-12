/**
 * @file payouts.test.ts
 * @description Agent-claimed payouts (spec gh-11, part 2), without a database: the claim split and
 * carry, the consent hash, PAYOUT_* config, the Transaction Status request and result parser, the
 * B2C receipt, webhook routing (payout → status query → destination), the PAYOUTS_ENABLED gate,
 * the payout:resolve arguments and the worker hook. The I/O matrix runs over HTTP against real
 * Postgres in tests/integration/payout_claims.int.test.ts.
 */

import crypto from 'crypto';
import express from 'express';
import { signAccessToken } from '../src/auth/tokens';
import { PayoutController } from '../src/controllers/payout.controller';
import { B2cClient, parseB2cResult, parseTransactionStatusResult } from '../src/daraja/client';
import { consentHash, DISCLOSURES, payoutConfig, PayoutConfigError, splitClaim } from '../src/domain/payout';
import { preflight } from '../src/index';
import { createPayoutRouter } from '../src/routes/payout.routes';
import webhookRoutes from '../src/routes/webhook.routes';
import { parsePayoutResolveArgs } from '../src/scripts/payout-resolve';
import { payoutService, PayoutService } from '../src/services/payout.service';
import { payoutDestinationService } from '../src/services/payout_destination.service';
import { SettlementWorker } from '../src/workers/settlement.worker';
import { b2cAccepted, b2cResultBody, darajaFetch, TEST_B2C_CONFIG, tsResultBody } from './support/daraja-fetch';
import { listen, type TestServer } from './support/http';

const fakeDb: any = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: jest.fn() };
const ID = '0b6f1c2e-6d7a-4b1e-9a51-3f2b8c9d0e1f';

describe('claim split and carry', () => {
  const e = (cents: number, i: number) => ({ escrowId: `e${i}`, cents });

  it('pays floor(gross + carry in) and carries the cents', () => {
    expect(splitClaim([e(123456, 1), e(67, 2)], 0, 150_000)).toEqual({ escrowIds: ['e1', 'e2'], grossCents: 123523, amount: 1235, carryOutCents: 23 });
    expect(splitClaim([e(1080, 1)], 23, 150_000)).toEqual({ escrowIds: ['e1'], grossCents: 1080, amount: 11, carryOutCents: 3 });
    expect(splitClaim([e(77, 1)], 23, 150_000)).toMatchObject({ amount: 1, carryOutCents: 0 });
    expect(splitClaim([], 99, 150_000)).toEqual({ escrowIds: [], grossCents: 0, amount: 0, carryOutCents: 99 });
  });

  it('takes the oldest escrows up to the maximum (a prefix: never skips ahead)', () => {
    expect(splitClaim([e(6000, 1), e(5000, 2), e(1000, 3)], 0, 100)).toMatchObject({ escrowIds: ['e1'], amount: 60 });
    expect(splitClaim([e(10_000, 1), e(1, 2)], 50, 100)).toMatchObject({ escrowIds: ['e1', 'e2'], amount: 100, carryOutCents: 51 });
    expect(splitClaim([e(10_100, 1), e(100, 2)], 0, 100)).toMatchObject({ escrowIds: [], amount: 0 });
  });
});

describe('consent hash', () => {
  const c = {
    agentId: 'a1',
    payoutId: ID,
    msisdn: '254712345678',
    amount: 1235,
    disclosureVersion: '1',
    disclosureText: DISCLOSURES['1'],
    acceptedAt: new Date('2026-10-12T10:00:00.000Z'),
  };
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

  it('is SHA-256 over canonical JSON (sorted keys) including the disclosure text hash', () => {
    const canonical = `{"accepted_at":"2026-10-12T10:00:00.000Z","agent_id":"a1","amount":1235,"disclosure_text_sha256":"${sha(DISCLOSURES['1'])}","disclosure_version":"1","msisdn":"254712345678","payout_id":"${ID}"}`;
    expect(consentHash(c)).toBe(sha(canonical));
  });

  it('changes with any field', () => {
    const base = consentHash(c);
    for (const over of [{ amount: 1236 }, { msisdn: '254712345679' }, { disclosureText: 'other' }, { acceptedAt: new Date(c.acceptedAt.getTime() + 1) }]) {
      expect(consentHash({ ...c, ...over })).not.toBe(base);
    }
  });
});

describe('PAYOUT_* config', () => {
  it('defaults, overrides and refusals', () => {
    expect(payoutConfig({})).toEqual({
      minAmount: 10, maxAmount: 150_000, statusAfterMs: 600_000, statusMaxAttempts: 6, disclosureVersion: '1', reminderDays: [7, 30, 90], reminderHours: [8, 20],
    });
    expect(payoutConfig({ PAYOUT_REMINDER_DAYS: ' 3, 14 ,60', PAYOUT_REMINDER_HOURS: '0,24' })).toMatchObject({ reminderDays: [3, 14, 60], reminderHours: [0, 24] });
    expect(payoutConfig({ PAYOUT_MIN_AMOUNT: '50', PAYOUT_STATUS_MAX_ATTEMPTS: '3' })).toMatchObject({ minAmount: 50, statusMaxAttempts: 3 });
    for (const bad of [{ PAYOUT_MIN_AMOUNT: '0' }, { PAYOUT_MAX_AMOUNT: '1.5' }, { PAYOUT_MIN_AMOUNT: '200', PAYOUT_MAX_AMOUNT: '100' }, { PAYOUT_DISCLOSURE_VERSION: '9' },
      { PAYOUT_REMINDER_DAYS: '7,30' }, { PAYOUT_REMINDER_DAYS: '7,30,90,120' }, { PAYOUT_REMINDER_DAYS: '7,7,90' }, { PAYOUT_REMINDER_DAYS: '30,7,90' },
      { PAYOUT_REMINDER_DAYS: '0,30,90' }, { PAYOUT_REMINDER_DAYS: '7,30,x' }, { PAYOUT_REMINDER_DAYS: '7,-30,90' }, { PAYOUT_REMINDER_DAYS: '7.5,30,90' },
      { PAYOUT_REMINDER_HOURS: '20,8' }, { PAYOUT_REMINDER_HOURS: '8' }, { PAYOUT_REMINDER_HOURS: '8,25' }]) {
      expect(() => payoutConfig(bad)).toThrow(PayoutConfigError);
    }
  });

  it('preflight refuses a bad PAYOUT_* value only while PAYOUTS_ENABLED=true', async () => {
    const env = { PAYOUT_DISCLOSURE_VERSION: '9' };
    const db: any = { query: jest.fn(async () => ({ rows: [{}] })) };
    expect((await preflight(env, db)).fatal.join('\n')).not.toMatch(/PAYOUT_DISCLOSURE_VERSION/);
    expect((await preflight({ ...env, PAYOUTS_ENABLED: 'true' }, db)).fatal.join('\n')).toMatch(/PAYOUT_DISCLOSURE_VERSION 9 has no disclosure text/);
    const days = { PAYOUT_REMINDER_DAYS: '30,7,90' };
    expect((await preflight(days, db)).fatal.join('\n')).not.toMatch(/PAYOUT_REMINDER_DAYS/);
    expect((await preflight({ ...days, PAYOUTS_ENABLED: 'true' }, db)).fatal.join('\n')).toMatch(/PAYOUT_REMINDER_DAYS must be 3 strictly increasing/);
  });
});

describe('Daraja Transaction Status', () => {
  it('queries by OriginalConversationID with its own OriginatorConversationID; maps the answer like B2C', async () => {
    const fake = darajaFetch(() => ({ status: 500 }), undefined, undefined, () => b2cAccepted({ ConversationID: 'AG_TS_9' }));
    const client = new B2cClient(TEST_B2C_CONFIG, fake.fn as any);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await client.transactionStatus({ originatorConversationId: ID, queryId: 'q-1' })).toEqual({ kind: 'ACCEPTED', conversationId: 'AG_TS_9' });
    expect(fake.calls.b2c).toBe(0);
    expect(fake.calls.tsBodies[0]).toEqual({
      OriginatorConversationID: 'q-1',
      Initiator: 'testapi',
      SecurityCredential: TEST_B2C_CONFIG.securityCredential,
      CommandID: 'TransactionStatusQuery',
      OriginalConversationID: ID,
      PartyA: 600000,
      IdentifierType: 4,
      ResultURL: TEST_B2C_CONFIG.resultUrl,
      QueueTimeOutURL: TEST_B2C_CONFIG.timeoutUrl,
      Remarks: 'SalesMesh payout status',
      Occasion: '',
    });
    expect(fake.fn.mock.calls.at(-1)![0]).toBe('https://sandbox.safaricom.co.ke/mpesa/transactionstatus/v1/query');
    jest.restoreAllMocks();
  });

  it('parses the result: Completed → PAID (receipt, name); Failed / Declined → FAILED; anything else → PENDING', () => {
    expect(parseTransactionStatusResult(tsResultBody('q-1'))).toEqual({
      queryId: 'q-1',
      resultCode: '0',
      outcome: 'PAID',
      transactionStatus: 'Completed',
      receipt: 'NLJ41HAY6Q',
      receiverName: 'TEST AGENT',
    });
    expect(parseTransactionStatusResult(tsResultBody('q-1', { status: 'Declined' }))?.outcome).toBe('FAILED');
    // No ReceiptNo: never the TransactionID (a TS result's TransactionID is the query's own).
    const noReceipt: any = tsResultBody('q-1');
    noReceipt.Result.ResultParameters.ResultParameter = noReceipt.Result.ResultParameters.ResultParameter.filter((p: any) => p.Key !== 'ReceiptNo');
    expect(parseTransactionStatusResult(noReceipt)?.receipt).toBeNull();
    expect(parseTransactionStatusResult(tsResultBody('q-1', { status: 'Reversed' }))?.outcome).toBe('PENDING');
    expect(parseTransactionStatusResult(tsResultBody('q-1', { code: 1, status: 'Completed' }))?.outcome).toBe('PENDING');
    expect(parseTransactionStatusResult({ Result: { ResultCode: 0 } })).toBeNull();
    expect(parseTransactionStatusResult({ hello: 1 })).toBeNull();
  });

  it('the B2C result now carries the receipt', () => {
    expect(parseB2cResult(b2cResultBody(ID, { receipt: 'abc123xyz9' }))?.receipt).toBe('ABC123XYZ9');
    const body: any = b2cResultBody(ID);
    body.Result.ResultParameters.ResultParameter = body.Result.ResultParameters.ResultParameter.filter((p: any) => p.Key !== 'TransactionReceipt');
    expect(parseB2cResult(body)?.receipt).toBe('NLJ41HAY6Q'); // falls back to TransactionID
  });
});

describe('B2C result routing', () => {
  let hook: TestServer;
  beforeAll(async () => {
    const app = express();
    app.use('/', webhookRoutes);
    hook = await listen(app);
    process.env.MPESA_CALLBACK_TOKEN = 'cbtok';
  });
  afterAll(() => hook.close());

  it('a payout (or status query) result is handled by payouts; anything else falls through to destinations; a DB failure → 503', async () => {
    const handle = jest.spyOn(payoutService, 'handleResult').mockResolvedValueOnce({ kind: 'duplicate' }).mockResolvedValueOnce(null);
    const dest = jest.spyOn(payoutDestinationService, 'applyResult').mockResolvedValue({ kind: 'unknown' });
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { body: b2cResultBody(ID) })).body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      expect(dest).not.toHaveBeenCalled();
      await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { body: b2cResultBody(ID) });
      expect(dest).toHaveBeenCalledTimes(1);
      handle.mockRejectedValueOnce(new Error('connection terminated'));
      expect((await hook.request('POST', '/api/v1/mpesa/b2c/result/cbtok', { body: b2cResultBody(ID) })).status).toBe(503);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('a non-UUID OriginatorConversationID never reaches SQL', async () => {
    const service = new PayoutService({ db: fakeDb, b2c: {} as any, auth: {} as any, notifier: { send: async () => undefined } });
    expect(await service.handleResult(b2cResultBody('id-9'))).toBeNull();
    expect(fakeDb.connect).not.toHaveBeenCalled();
  });
});

describe('PAYOUTS_ENABLED gate', () => {
  it('routes answer 503 payouts_disabled; the sweep does nothing', async () => {
    const app = express();
    const service = new PayoutService({ db: fakeDb, b2c: {} as any, auth: {} as any, notifier: { send: async () => undefined } });
    app.use('/api/v1/payouts', createPayoutRouter(new PayoutController(service)));
    const srv = await listen(app);
    try {
      process.env.PAYOUTS_ENABLED = 'false';
      const token = (await signAccessToken({ userId: crypto.randomUUID(), role: 'SALES_AGENT', pinChangeRequired: false })).token;
      for (const [method, path] of [['GET', '/'], ['POST', '/claim']]) {
        const res = await srv.request(method, `/api/v1/payouts${path}`, { headers: { Authorization: `Bearer ${token}` }, body: {} });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'payouts_disabled' });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect(await service.sweep()).toEqual({ queried: 0, unresolved: 0 });
      expect(fakeDb.query).not.toHaveBeenCalled();
    } finally {
      delete process.env.PAYOUTS_ENABLED;
      await srv.close();
    }
  });

  it('the settlement worker housekeeping runs the payout status sweep and unclaimed reminders only while PAYOUTS_ENABLED=true', async () => {
    const sweep = jest.fn(async () => ({ queried: 0, unresolved: 0 }));
    const remindUnclaimed = jest.fn(async () => { throw new Error('db down'); });
    const w = new SettlementWorker({ pool: fakeDb, spool: null, payouts: { sweep: jest.fn(async () => ({ promoted: 0, expired: 0 })) }, payoutClaims: { sweep, remindUnclaimed } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.PAYOUTS_ENABLED = 'false';
    await w.housekeeping(true);
    expect(sweep).not.toHaveBeenCalled();
    expect(remindUnclaimed).not.toHaveBeenCalled();
    process.env.PAYOUTS_ENABLED = 'true';
    await w.housekeeping(true); // a reminder failure is logged, never thrown
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(remindUnclaimed).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/unclaimed reminder sweep failed/), 'db down');
    err.mockRestore();
    delete process.env.PAYOUTS_ENABLED;
  });
});

describe('payout:resolve arguments', () => {
  it('paid <receipt> | failed, nothing else', () => {
    expect(parsePayoutResolveArgs([ID, 'paid', 'qwe123rty9'])).toEqual({ id: ID, o: { paid: true, receipt: 'QWE123RTY9' } });
    expect(parsePayoutResolveArgs([ID, 'failed'])).toEqual({ id: ID, o: { paid: false } });
    for (const bad of [[], ['x', 'failed'], [ID], [ID, 'paid'], [ID, 'paid', 'no!'], [ID, 'failed', 'R1'], [ID, 'refund']]) {
      expect(() => parsePayoutResolveArgs(bad)).toThrow(/usage: payout:resolve/);
    }
  });
});
