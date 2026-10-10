/**
 * @file worker.test.ts
 * @description Settlement and re-score workers with mocked repositories / ml-engine
 * (spec gh-6 I/O matrix: resolution, payment time, counterparty, history, ML outcomes,
 * transient retries, terminal states, self-heal).
 */

 

jest.mock('../src/repositories/agent.repository');
jest.mock('../src/repositories/intake.repository');
jest.mock('../src/repositories/security.repository');
jest.mock('../src/repositories/transaction.repository');
jest.mock('../src/repositories/escrow.repository');
jest.mock('../src/repositories/stk.repository');

import * as agents from '../src/repositories/agent.repository';
import * as intake from '../src/repositories/intake.repository';
import * as security from '../src/repositories/security.repository';
import * as txns from '../src/repositories/transaction.repository';
import * as escrowRepo from '../src/repositories/escrow.repository';
import * as stkRepo from '../src/repositories/stk.repository';
import { redactPayload, msisdnHash, receiptCounterpartyHash } from '../src/domain/callback';
import { SettlementWorker } from '../src/workers/settlement.worker';
import { RescoreWorker } from '../src/workers/rescore.worker';
import { ResilientRiskClient, type RiskEvaluationResponse } from '../src/services/risk_client.service';
import type { IntakeRow } from '../src/repositories/intake.repository';

const m = <T extends (...args: any[]) => any>(fn: T) => fn as unknown as jest.MockedFunction<T>;

const clientQuery = jest.fn(async () => ({ rows: [{ n: 1 }], rowCount: 1 }));
const fakePool: any = {
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
};

const fakeEscrow = {
  persistTransaction: jest.fn(async (_p: any, _db?: any) => 'tx-uuid-1'),
  processSettlement: jest.fn(async (_t: string, r: RiskEvaluationResponse, _g: any, o: any) => ({
    escrowStatus: r.decision === 'CLEAR' && !r.is_fail_safe && !o.securityHold ? 'HELD' : 'QUARANTINED',
    created: true,
  })),
  insertVerificationEvent: jest.fn(async () => 'ver-1'),
};

const clear = (over: Partial<RiskEvaluationResponse> = {}): RiskEvaluationResponse => ({
  transaction_id: 'X',
  isolation_score: 0.1234567,
  xgb_probability: 0.0123456,
  model_version: 'v1.0.0',
  model_sha256: 'a'.repeat(64),
  decision: 'CLEAR',
  triggered_layer: 1,
  layer2_adjudicated: false,
  reason: 'fast clear',
  latency_ms: 3,
  evaluated_at: new Date().toISOString(),
  is_fail_safe: false,
  fail_safe_cause: null,
  ...over,
});

const risk = { evaluate: jest.fn(async () => clear()), isAvailable: jest.fn(() => true) };

function worker(config: any = {}) {
  return new SettlementWorker({
    pool: fakePool,
    riskClient: risk,
    escrow: fakeEscrow as any,
    spool: null,
    config: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 60_000, historyLimit: 2000, ...config },
  });
}

const RECEIVED_AT = new Date('2026-10-09T09:00:00.000Z');

function c2bRow(over: Record<string, unknown> = {}, rowOver: Partial<IntakeRow> = {}): IntakeRow {
  const payload = redactPayload({
    TransID: 'OEI2AK4Q16',
    TransAmount: '500.00',
    TransTime: '20261009120000',
    BillRefNumber: ' ag042 ',
    MSISDN: '254708374149',
    ...over,
  });
  return {
    callback_id: 'cb-1',
    mpesa_receipt_id: 'OEI2AK4Q16',
    raw_payload_hash: 'k1:' + 'f'.repeat(64),
    source_channel: 'C2B',
    payload,
    status: 'PROCESSING',
    attempts: 1,
    resolve_attempts: 0,
    claim_token: 'token-1',
    received_at: RECEIVED_AT,
    ...rowOver,
  };
}

function stkRow(amount: unknown = 1500): IntakeRow {
  return {
    ...c2bRow(),
    mpesa_receipt_id: 'NLJ7RT61SV',
    source_channel: 'DARAJA_STK',
    payload: redactPayload({
      Body: {
        stkCallback: {
          CheckoutRequestID: 'ws_CO_1',
          ResultCode: 0,
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: amount },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'TransactionDate', Value: 20261009120000 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  risk.evaluate.mockImplementation(async () => clear());
  risk.isAvailable.mockReturnValue(true);
  m(agents.findAgentByCode).mockResolvedValue('agent-42');
  m(agents.findStkRequest).mockResolvedValue({ stkRequestId: 'stk-1', agentId: 'agent-stk', amountCents: 150000, status: 'ACCEPTED', consumedReceipt: null });
  m(stkRepo.findFallbackCandidates).mockResolvedValue([]);
  m(stkRepo.bindFallback).mockResolvedValue(true);
  m(stkRepo.expireStalePending).mockResolvedValue(null);
  m(agents.consumeStkRequest).mockResolvedValue(true);
  m(intake.lockClaimed).mockResolvedValue(true);
  m(intake.markSettled).mockResolvedValue(true);
  m(intake.markRetry).mockResolvedValue(true);
  m(intake.markFailed).mockResolvedValue(true);
  m(intake.markUnresolved).mockResolvedValue({ updated: true, terminal: false });
  m(security.hasSecurityHold).mockResolvedValue(false);
  m(txns.fetchHistory).mockResolvedValue({ rows: [], truncated: false });
});

describe('agent resolution', () => {
  it('C2B BillRefNumber " ag042 " resolves agent code AG042 and settles', async () => {
    expect(await worker().process(c2bRow())).toBe('settled');
    expect(agents.findAgentByCode).toHaveBeenCalledWith(fakePool, 'AG042');
    expect(fakeEscrow.persistTransaction.mock.calls[0][0]).toMatchObject({ agent_id: 'agent-42', amount: '500.00', source_channel: 'C2B' });
    expect(intake.markSettled).toHaveBeenCalledWith(expect.anything(), 'cb-1', 'token-1', 'tx-uuid-1');
  });

  it('unknown C2B code → UNRESOLVED (retrying), never a transaction', async () => {
    m(agents.findAgentByCode).mockResolvedValue(null);
    expect(await worker().process(c2bRow())).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: false });
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
    expect(risk.evaluate).not.toHaveBeenCalled();
  });

  it('STK: known CheckoutRequestID with equal amount resolves the agent and consumes the record', async () => {
    expect(await worker().process(stkRow('1500.00'))).toBe('settled');
    expect(agents.consumeStkRequest).toHaveBeenCalledWith(expect.anything(), 'stk-1', 'NLJ7RT61SV');
    expect(fakeEscrow.persistTransaction.mock.calls[0][0]).toMatchObject({ agent_id: 'agent-stk', source_channel: 'DARAJA_STK' });
  });

  it('STK: unknown CheckoutRequestID → UNRESOLVED (retrying); amount mismatch → UNRESOLVED (terminal)', async () => {
    m(agents.findStkRequest).mockResolvedValueOnce(null);
    expect(await worker().process(stkRow())).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: false });

    expect(await worker().process(stkRow(1499))).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[1][3]).toContain('stk_amount_mismatch');
    expect(m(intake.markUnresolved).mock.calls[1][4]).toMatchObject({ terminal: true });
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
  });

  it('STK: a second receipt for a consumed request → UNRESOLVED with a persisted alarm', async () => {
    m(agents.findStkRequest).mockResolvedValue({ stkRequestId: 'stk-1', agentId: 'agent-stk', amountCents: 150000, status: 'ACCEPTED', consumedReceipt: 'OTHER00001' });
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await worker().process(stkRow())).toBe('unresolved');
    err.mockRestore();
    expect(m(security.insertSecurityEvent).mock.calls[0][1]).toMatchObject({ type: 'STK_RECEIPT_REPLAY', receipt: 'NLJ7RT61SV' });
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: true });
  });

  it('STK: losing the consume race inside the settlement transaction → UNRESOLVED replay', async () => {
    m(agents.consumeStkRequest).mockResolvedValue(false);
    jest.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    expect(await worker().process(stkRow())).toBe('unresolved');
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('raw-mode request: time, counterparty, history', () => {
  it('payment time EAT → UTC; counterparty is the stored MSISDN HMAC; history anchored at t', async () => {
    await worker().process(c2bRow());
    const req = (risk.evaluate.mock.calls[0] as any)[0];
    expect(req.transaction.timestamp).toBe('2026-10-09T09:00:00.000Z'); // 12:00 EAT
    expect(req.transaction.counterparty_id).toBe(msisdnHash('254708374149'));
    expect(req.transaction).toMatchObject({ agent_id: 'agent-42', amount: 500 });
    expect(txns.fetchHistory).toHaveBeenCalledWith(fakePool, {
      agentId: 'agent-42',
      at: new Date('2026-10-09T09:00:00.000Z'),
      excludeReceipt: 'OEI2AK4Q16',
      limit: 2000,
    });
    expect(req.history).toEqual([]);
  });

  it('unparseable time → received_at; absent MSISDN → HMAC(receipt)', async () => {
    await worker().process(c2bRow({ TransTime: 'bogus', MSISDN: undefined }));
    const req = (risk.evaluate.mock.calls[0] as any)[0];
    expect(req.transaction.timestamp).toBe(RECEIVED_AT.toISOString());
    expect(req.transaction.counterparty_id).toBe(receiptCounterpartyHash('OEI2AK4Q16'));
  });

  it('history_truncated is passed to the verification record', async () => {
    m(txns.fetchHistory).mockResolvedValue({ rows: [], truncated: true });
    await worker().process(c2bRow());
    expect(fakeEscrow.processSettlement.mock.calls[0][3]).toMatchObject({ historyTruncated: true });
  });
});

describe('ML outcome → escrow (fail closed)', () => {
  it('model CLEAR → HELD; REVIEW/QUARANTINE → QUARANTINED', async () => {
    await worker().process(c2bRow());
    expect(await fakeEscrow.processSettlement.mock.results[0].value).toMatchObject({ escrowStatus: 'HELD' });
    risk.evaluate.mockImplementationOnce(async () => clear({ decision: 'REVIEW', layer2_adjudicated: true }));
    await worker().process(c2bRow());
    expect(await fakeEscrow.processSettlement.mock.results[1].value).toMatchObject({ escrowStatus: 'QUARANTINED' });
  });

  it('ml-engine down → settled QUARANTINED with is_fail_safe and the cause recorded', async () => {
    const real = new ResilientRiskClient();
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    (global as any).fetch = fetchMock;
    const w = new SettlementWorker({ pool: fakePool, riskClient: real, escrow: fakeEscrow as any, spool: null });
    expect(await w.process(c2bRow())).toBe('settled');
    const recorded = fakeEscrow.processSettlement.mock.calls[0][1] as RiskEvaluationResponse;
    expect(recorded).toMatchObject({ decision: 'QUARANTINE', is_fail_safe: true, fail_safe_cause: 'service_unavailable' });
    expect(recorded.isolation_score).toBeNull();
    expect(await fakeEscrow.processSettlement.mock.results[0].value).toMatchObject({ escrowStatus: 'QUARANTINED' });
  });

  it('a recorded payload mutation forces QUARANTINED even on a model CLEAR', async () => {
    m(security.hasSecurityHold).mockResolvedValue(true);
    await worker().process(c2bRow());
    expect(fakeEscrow.processSettlement.mock.calls[0][3]).toMatchObject({ securityHold: true });
    expect(await fakeEscrow.processSettlement.mock.results[0].value).toMatchObject({ escrowStatus: 'QUARANTINED' });
  });

  it('commission is computed in integer cents (10 %)', async () => {
    await worker().process(c2bRow({ TransAmount: '333.33' }));
    expect(fakeEscrow.processSettlement.mock.calls[0][2]).toBe('33.33');
  });
});

describe('retries and terminal states', () => {
  it('transient DB error → PENDING with exponential backoff', async () => {
    m(txns.fetchHistory).mockRejectedValue(new Error('connection terminated'));
    jest.spyOn(console, 'warn').mockImplementationOnce(() => undefined);
    expect(await worker().process(c2bRow({}, { attempts: 3 }))).toBe('retry');
    expect(m(intake.markRetry).mock.calls[0][3]).toBe(4000); // 1000 · 2^(3-1)
  });

  it('after the 5th attempt → FAILED with last_error', async () => {
    m(txns.fetchHistory).mockRejectedValue(new Error('connection terminated'));
    jest.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    expect(await worker().process(c2bRow({}, { attempts: 5 }))).toBe('failed');
    expect(m(intake.markFailed).mock.calls[0][3]).toContain('connection terminated');
  });

  it('parse/validation errors go terminal immediately (no retry)', async () => {
    jest.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    expect(await worker().process(c2bRow({}, { payload: { garbage: true } as any }))).toBe('failed');
    expect(intake.markRetry).not.toHaveBeenCalled();
    expect(risk.evaluate).not.toHaveBeenCalled();
  });

  it('lease lost before commit → nothing written, rolled back', async () => {
    m(intake.lockClaimed).mockResolvedValue(false);
    jest.spyOn(console, 'warn').mockImplementationOnce(() => undefined);
    expect(await worker().process(c2bRow())).toBe('lease_lost');
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
    expect(intake.markSettled).not.toHaveBeenCalled();
  });

  it('refuses to start without a valid PII_HMAC_KEY', () => {
    const saved = process.env.PII_HMAC_KEY;
    process.env.PII_HMAC_KEY = 'too-short';
    try {
      expect(() => worker().start()).toThrow(/PII_HMAC_KEY/);
    } finally {
      process.env.PII_HMAC_KEY = saved;
    }
  });

  it('start/wake/stop: a woken worker claims immediately and stop drains', async () => {
    m(intake.claimBatch).mockResolvedValue([]);
    m(intake.sweepDead).mockResolvedValue(0);
    const w = worker({ pollIntervalMs: 60_000 });
    w.start();
    await new Promise((r) => setTimeout(r, 20));
    const before = m(intake.claimBatch).mock.calls.length;
    w.wake();
    await new Promise((r) => setTimeout(r, 20));
    expect(m(intake.claimBatch).mock.calls.length).toBeGreaterThan(before);
    await w.stop(1000);
    expect(w.isRunning()).toBe(false);
  });
});

describe('re-score worker (self-healing quarantine)', () => {
  const claim = { escrow_id: 'esc-1', transaction_id: 'tx-1', rescore_claim_token: 'rs-token', rescore_attempts: 1 };
  const rescorer = () => new RescoreWorker({ pool: fakePool, riskClient: risk, escrow: fakeEscrow as any, config: { maxAttempts: 5 } });

  beforeEach(() => {
    m(escrowRepo.claimRescoreBatch).mockResolvedValue([claim]);
    m(escrowRepo.loadRescoreContext).mockResolvedValue({
      receipt: 'OEI2AK4Q16', agentId: 'agent-42', timestamp: new Date('2026-10-09T09:00:00Z'), amount: 500,
      counterpartyHash: 'k1:' + 'c'.repeat(64), historyReceipts: null,
    });
    m(escrowRepo.lockRescoreLease).mockResolvedValue(true);
    m(escrowRepo.promoteToHeld).mockResolvedValue(true);
    m(escrowRepo.releaseRescoreLease).mockResolvedValue(true);
  });

  it('breaker OPEN → nothing claimed', async () => {
    risk.isAvailable.mockReturnValue(false);
    expect(await rescorer().runOnce()).toBe(0);
    expect(escrowRepo.claimRescoreBatch).not.toHaveBeenCalled();
  });

  it('model CLEAR → RESCORE event + guarded promote to HELD (24 h), in one transaction', async () => {
    jest.spyOn(console, 'info').mockImplementationOnce(() => undefined);
    expect(await rescorer().rescore(claim)).toBe('promoted');
    expect(fakeEscrow.insertVerificationEvent).toHaveBeenCalledWith(expect.anything(), 'tx-1', expect.objectContaining({ decision: 'CLEAR' }), 'RESCORE', false);
    expect(escrowRepo.promoteToHeld).toHaveBeenCalledWith(expect.anything(), 'esc-1', 'rs-token', 24);
    expect(txns.fetchHistory).toHaveBeenCalledWith(fakePool, expect.objectContaining({ asOfInitialOf: 'tx-1', excludeReceipt: 'OEI2AK4Q16' }));
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('model REVIEW → RESCORE event, stays QUARANTINED, lease released with backoff', async () => {
    risk.evaluate.mockImplementationOnce(async () => clear({ decision: 'REVIEW' }));
    expect(await rescorer().rescore(claim)).toBe('still_quarantined');
    expect(escrowRepo.promoteToHeld).not.toHaveBeenCalled();
    expect(fakeEscrow.insertVerificationEvent).toHaveBeenCalledTimes(1);
    expect(m(escrowRepo.releaseRescoreLease).mock.calls[0][3]).toBeGreaterThan(0);
  });

  it('breaker refuses mid-batch (circuit_open) → deferred, no audit event, attempt refunded', async () => {
    risk.evaluate.mockImplementationOnce(async () =>
      clear({ decision: 'QUARANTINE', is_fail_safe: true, fail_safe_cause: 'circuit_open', isolation_score: null, xgb_probability: null })
    );
    expect(await rescorer().rescore(claim)).toBe('deferred');
    expect(fakeEscrow.insertVerificationEvent).not.toHaveBeenCalled();
    expect(m(escrowRepo.releaseRescoreLease).mock.calls[0][4]).toBe(true);
  });

  it('lease lost / no longer eligible at finalise → nothing written', async () => {
    m(escrowRepo.lockRescoreLease).mockResolvedValue(false);
    jest.spyOn(console, 'warn').mockImplementationOnce(() => undefined);
    expect(await rescorer().rescore(claim)).toBe('lease_lost');
    expect(fakeEscrow.insertVerificationEvent).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('review fixes — worker, spool, config', () => {
  it('a Daraja time more than 5 minutes after received_at is distrusted (received_at is used)', async () => {
    const { effectivePaymentTime } = jest.requireActual('../src/domain/callback');
    const rx = new Date('2026-10-09T09:00:00Z');
    expect(effectivePaymentTime(new Date('2026-10-09T09:04:59Z'), rx).toISOString()).toBe('2026-10-09T09:04:59.000Z');
    expect(effectivePaymentTime(new Date('2026-10-09T09:05:01Z'), rx)).toBe(rx);
    expect(effectivePaymentTime(null, rx)).toBe(rx);

    // 2026-10-10 12:00 EAT is a day after RECEIVED_AT: scored at received_at.
    await worker().process(c2bRow({ TransTime: '20261010120000' }));
    expect((risk.evaluate.mock.calls[0] as any)[0].transaction.timestamp).toBe(RECEIVED_AT.toISOString());
  });

  it('markFailed throwing in the parse-error branch does not abort the batch', async () => {
    m(intake.markFailed).mockRejectedValue(new Error('db down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await worker().process(c2bRow({}, { payload: { garbage: true } as any }))).toBe('retry');
    err.mockRestore();
  });

  describe('drainSpool', () => {
    const good = (receipt: string) =>
      JSON.stringify({ receipt, hash: 'k1:' + 'a'.repeat(64), channel: 'C2B', payload: { TransID: receipt }, receivedAt: '2026-10-09T09:00:00.000Z' });

    function spoolOf(items: string[]) {
      const list = [...items];
      return {
        list,
        spool: {
          peek: async () => [...list],
          remove: async (r: string) => {
            list.splice(list.indexOf(r), 1);
          },
        },
      };
    }

    let err: jest.SpyInstance;
    beforeEach(() => {
      err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => err.mockRestore());

    it('parks malformed entries (bad receivedAt, unknown channel, missing payload, not JSON) and drains the rest', async () => {
      m(intake.insertIntake).mockResolvedValue({ outcome: 'inserted', callbackId: 'cb' });
      const bad = [
        JSON.stringify({ ...JSON.parse(good('BADT000001')), receivedAt: 'yesterday' }),
        JSON.stringify({ ...JSON.parse(good('BADC000001')), channel: 'POS' }),
        JSON.stringify({ ...JSON.parse(good('BADP000001')), payload: null }),
        '{not json',
      ];
      const { list, spool } = spoolOf([...bad, good('GOOD000001')]);
      const w = new SettlementWorker({ pool: fakePool, riskClient: risk, escrow: fakeEscrow as any, spool });
      expect(await w.drainSpool()).toBe(1);
      expect(list).toEqual([]);
      expect(intake.insertIntake).toHaveBeenCalledTimes(1);
      expect(err.mock.calls.filter(([msg]) => String(msg).includes('parking'))).toHaveLength(4);
    });

    it('parks entries Postgres rejects (SQLSTATE 22/23) and stops on other errors', async () => {
      m(intake.insertIntake)
        .mockRejectedValueOnce(Object.assign(new Error('value too long'), { code: '22001' }))
        .mockResolvedValueOnce({ outcome: 'inserted', callbackId: 'cb' })
        .mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
      const { list, spool } = spoolOf([good('RJCT000001'), good('OKAY000001'), good('DOWN000001'), good('LATE000001')]);
      const w = new SettlementWorker({ pool: fakePool, riskClient: risk, escrow: fakeEscrow as any, spool });
      await expect(w.drainSpool()).rejects.toThrow('connection refused');
      expect(list.map((r) => JSON.parse(r).receipt)).toEqual(['DOWN000001', 'LATE000001']);
    });
  });

  it('the spool is capped with LTRIM and trimming is logged', async () => {
    const { SpoolService } = jest.requireActual('../src/services/spool.service');
    const redis = { lpush: jest.fn(async () => 4), ltrim: jest.fn(async () => 'OK'), lrange: jest.fn(), lrem: jest.fn(), llen: jest.fn() };
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = new SpoolService(redis, 3);
    expect(await s.spool({ receipt: 'R', hash: 'h', channel: 'C2B', payload: {}, receivedAt: new Date().toISOString() })).toBe(true);
    expect(redis.ltrim).toHaveBeenCalledWith('mpesa:intake:spool', 0, 2);
    expect(err.mock.calls.some(([msg]) => String(msg).includes('trimmed'))).toBe(true);
    redis.lpush.mockResolvedValueOnce(2);
    redis.ltrim.mockClear();
    await s.spool({ receipt: 'R', hash: 'h', channel: 'C2B', payload: {}, receivedAt: new Date().toISOString() });
    expect(redis.ltrim).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('re-score exhaustion is reported once, when the last attempt is used', async () => {
    m(escrowRepo.loadRescoreContext).mockResolvedValue({
      receipt: 'OEI2AK4Q16', agentId: 'agent-42', timestamp: new Date('2026-10-09T09:00:00Z'), amount: 500,
      counterpartyHash: 'k1:' + 'c'.repeat(64), historyReceipts: null,
    });
    m(escrowRepo.lockRescoreLease).mockResolvedValue(true);
    m(escrowRepo.releaseRescoreLease).mockResolvedValue(true);
    risk.evaluate.mockImplementation(async () => clear({ decision: 'REVIEW' }));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = new RescoreWorker({ pool: fakePool, riskClient: risk, escrow: fakeEscrow as any, config: { maxAttempts: 3 } });
    await r.rescore({ escrow_id: 'e', transaction_id: 't', rescore_claim_token: 'k', rescore_attempts: 2 });
    expect(err).not.toHaveBeenCalled();
    await r.rescore({ escrow_id: 'e', transaction_id: 't', rescore_claim_token: 'k', rescore_attempts: 3 });
    expect(err.mock.calls.filter(([msg]) => String(msg).includes('exhausted'))).toHaveLength(1);
    err.mockRestore();
  });

  it('a stored INITIAL receipt list makes the re-score replay exactly those receipts', async () => {
    m(escrowRepo.loadRescoreContext).mockResolvedValue({
      receipt: 'OEI2AK4Q16', agentId: 'agent-42', timestamp: new Date('2026-10-09T09:00:00Z'), amount: 500,
      counterpartyHash: 'k1:' + 'c'.repeat(64), historyReceipts: ['A0000001', 'B0000001'],
    });
    m(escrowRepo.lockRescoreLease).mockResolvedValue(true);
    m(escrowRepo.promoteToHeld).mockResolvedValue(true);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    await new RescoreWorker({ pool: fakePool, riskClient: risk, escrow: fakeEscrow as any })
      .rescore({ escrow_id: 'e', transaction_id: 't', rescore_claim_token: 'k', rescore_attempts: 1 });
    info.mockRestore();
    const q = m(txns.fetchHistory).mock.calls[0][1];
    expect(q.receipts).toEqual(['A0000001', 'B0000001']);
    expect(q.asOfInitialOf).toBeUndefined();
  });

  it('settlement stores the receipts actually sent on the INITIAL event', async () => {
    m(txns.fetchHistory).mockResolvedValue({
      rows: [{ transaction_id: 'PRIOR00001', agent_id: 'agent-42', timestamp: '2026-10-08T09:00:00.000Z', amount: 10, counterparty_id: 'k1:' + 'd'.repeat(64) }],
      truncated: false,
    });
    await worker().process(c2bRow());
    expect(fakeEscrow.processSettlement.mock.calls[0][3]).toMatchObject({ historyReceipts: ['PRIOR00001'] });
  });

  it('unsafe configuration falls back or is clamped', () => {
    const { settlementWorkerConfig, rescoreWorkerConfig } = jest.requireActual('../src/config/worker');
    const { idempotencyTtlMs } = jest.requireActual('../src/services/idempotency.service');
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        WORKER_POLL_INTERVAL_MS: '0', WORKER_VISIBILITY_TIMEOUT_MS: '0', ML_MAX_BODY_BYTES: '9999999',
        COMMISSION_RATE_BPS: '50000', RESCORE_INTERVAL_MS: '0', RESCORE_LEASE_MS: '10',
      });
      expect(settlementWorkerConfig()).toMatchObject({ pollIntervalMs: 100, visibilityTimeoutMs: 30_000, mlMaxBodyBytes: 524_288, commissionRateBps: 10_000 });
      expect(rescoreWorkerConfig()).toMatchObject({ intervalMs: 100, leaseMs: 30_000, mlMaxBodyBytes: 524_288 });
      expect(idempotencyTtlMs('abc')).toBe(86_400_000);
      expect(idempotencyTtlMs('0')).toBe(86_400_000);
      expect(idempotencyTtlMs('60000')).toBe(60_000);
    } finally {
      process.env = saved;
    }
  });
});

describe('STK fallback match (spec gh-5: CheckoutRequestID not on file)', () => {
  const stkWithPhone = (phone: unknown, extra: Record<string, unknown> = {}): IntakeRow => ({
    ...stkRow(1500),
    payload: redactPayload({
      Body: {
        stkCallback: {
          CheckoutRequestID: 'ws_CO_LOST',
          ResultCode: 0,
          ...extra,
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 1500 },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'TransactionDate', Value: 20261009120000 },
              ...(phone === undefined ? [] : [{ Name: 'PhoneNumber', Value: phone }]),
            ],
          },
        },
      },
    }),
  });
  const unknown = (id: string, agentId = 'agent-u') => ({ stkRequestId: id, agentId, status: 'UNKNOWN' as const });

  beforeEach(() => {
    m(agents.findStkRequest).mockResolvedValue(null);
  });

  it('exactly one UNKNOWN candidate → bound and consumed by stk_request_id inside the settlement transaction', async () => {
    m(stkRepo.findFallbackCandidates).mockResolvedValue([unknown('stk-u')]);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await worker().process(stkWithPhone(254708374149))).toBe('settled');
    info.mockRestore();
    const query = { phoneHashes: [msisdnHash('254708374149')], amount: '1500.00', at: new Date('2026-10-09T09:00:00.000Z') };
    expect(stkRepo.findFallbackCandidates).toHaveBeenCalledWith(fakePool, query);
    // Re-selected FOR UPDATE and re-counted inside the transaction (on the transaction's client).
    const bindCall = m(stkRepo.bindFallback).mock.calls[0];
    expect(bindCall[0]).not.toBe(fakePool);
    expect(bindCall[1]).toEqual({ ...query, stkRequestId: 'stk-u', checkoutRequestId: 'ws_CO_LOST' });
    expect(agents.consumeStkRequest).toHaveBeenCalledWith(expect.anything(), 'stk-u', 'NLJ7RT61SV');
    expect(fakeEscrow.persistTransaction.mock.calls[0][0]).toMatchObject({ agent_id: 'agent-u', source_channel: 'DARAJA_STK' });
  });

  it('no payment time in the callback → the window is anchored at received_at', async () => {
    m(stkRepo.findFallbackCandidates).mockResolvedValue([]);
    const row = stkWithPhone(254708374149);
    const items = (row.payload as any).Body.stkCallback.CallbackMetadata.Item;
    items.splice(items.findIndex((i: any) => i.Name === 'TransactionDate'), 1);
    await worker().process(row);
    expect(m(stkRepo.findFallbackCandidates).mock.calls[0][1]).toMatchObject({ at: RECEIVED_AT });
  });

  it('0 candidates → UNRESOLVED, retrying (the existing path)', async () => {
    m(stkRepo.findFallbackCandidates).mockResolvedValue([]);
    expect(await worker().process(stkWithPhone(254708374149))).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_unknown_checkout_request_id');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: false });
  });

  it('more than one UNKNOWN candidate → UNRESOLVED for review (fail closed), nothing bound', async () => {
    m(stkRepo.findFallbackCandidates).mockResolvedValue([unknown('stk-1', 'agent-a'), unknown('stk-2', 'agent-b')]);
    expect(await worker().process(stkWithPhone(254708374149))).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_fallback_ambiguous');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: true });
    expect(stkRepo.bindFallback).not.toHaveBeenCalled();
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
  });

  it('a PENDING candidate (Daraja call may still answer) → retry, never bind', async () => {
    m(stkRepo.findFallbackCandidates).mockResolvedValue([unknown('stk-u'), { stkRequestId: 'stk-p', agentId: 'agent-p', status: 'PENDING' }]);
    expect(await worker().process(stkWithPhone(254708374149))).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_fallback_pending');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: false });
    expect(stkRepo.bindFallback).not.toHaveBeenCalled();
  });

  it('a stale PENDING candidate (older than the Daraja timeout + 10 s) is moved to UNKNOWN, then matched', async () => {
    m(stkRepo.findFallbackCandidates)
      .mockResolvedValueOnce([{ stkRequestId: 'stk-p', agentId: 'agent-p', status: 'PENDING' }])
      .mockResolvedValueOnce([unknown('stk-p', 'agent-p')]);
    m(stkRepo.expireStalePending).mockResolvedValueOnce({ stkRequestId: 'stk-p' } as any);
    jest.spyOn(console, 'info').mockImplementationOnce(() => undefined);
    expect(await worker().process(stkWithPhone(254708374149))).toBe('settled');
    expect(m(stkRepo.expireStalePending).mock.calls[0][1]).toBe('stk-p');
    expect(m(stkRepo.expireStalePending).mock.calls[0][2]).toBe(35_000); // 25 s overall Daraja deadline + 10 s
  });

  it.each([
    ['masked', '2547****149'],
    ['missing', undefined],
  ])('%s PhoneNumber → no fallback; UNRESOLVED', async (_n, phone) => {
    expect(await worker().process(stkWithPhone(phone))).toBe('unresolved');
    expect(stkRepo.findFallbackCandidates).not.toHaveBeenCalled();
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_unknown_checkout_request_id');
  });

  it('the candidate set changed under the lock → rolled back, UNRESOLVED and retried (fail closed)', async () => {
    m(stkRepo.findFallbackCandidates).mockResolvedValue([unknown('stk-u')]);
    m(stkRepo.bindFallback).mockResolvedValue(false);
    jest.spyOn(console, 'info').mockImplementationOnce(() => undefined);
    expect(await worker().process(stkWithPhone(254708374149))).toBe('unresolved');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_fallback_contended');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: false });
  });

  it('PII key rotation: the callback also carries the previous-key HMAC, so a request hashed before the rotation still matches', async () => {
    const saved = { ...process.env };
    try {
      const before = msisdnHash('254708374149'); // the request's phone_hash, made under k1
      process.env.PII_HMAC_KEY_PREVIOUS = process.env.PII_HMAC_KEY;
      process.env.PII_HMAC_KEY_PREVIOUS_ID = 'k1';
      process.env.PII_HMAC_KEY = 'rotated-key-for-tests-0123456789abcdef!!';
      process.env.PII_HMAC_KEY_ID = 'k2';
      m(stkRepo.findFallbackCandidates).mockResolvedValue([]);
      await worker().process(stkWithPhone(254708374149)); // intake (redaction) after the rotation
      const hashes = m(stkRepo.findFallbackCandidates).mock.calls[0][1].phoneHashes;
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).toMatch(/^k2:/);
      expect(hashes).toContain(before);
    } finally {
      process.env = saved;
    }
  });

  it('a paid callback for a request recorded REJECTED / FAILED → UNRESOLVED for review (status conflict)', async () => {
    m(agents.findStkRequest).mockResolvedValue({ stkRequestId: 'stk-1', agentId: 'agent-stk', amountCents: 150000, status: 'FAILED', consumedReceipt: null });
    expect(await worker().process(stkRow(1500))).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_status_conflict_failed');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: true });
  });
});

describe('RECONCILED rows (spec gh-6-recon: statement-recovered payments)', () => {
  const STK_ID = '0b8a4c56-6f0e-4b8e-9d4c-2a1f3e5d7c90';
  const actual = jest.requireActual('../src/repositories/stk.repository');
  beforeAll(() => {
    // Automocked arrays are empty: restore the real bindable-status list.
    const list = stkRepo.RECONCILE_BINDABLE as unknown as string[];
    if (list.length === 0) list.push(...actual.RECONCILE_BINDABLE);
  });
  beforeEach(() => {
    m(agents.findStkRequestById).mockResolvedValue({ stkRequestId: STK_ID, agentId: 'agent-rec', amountCents: 150000, status: 'PAID_UNCONFIRMED', consumedReceipt: null });
    m(stkRepo.lockReconciledStk).mockResolvedValue('ok');
  });

  function reconciledStk(over: Record<string, unknown> = {}): IntakeRow {
    return {
      ...c2bRow(),
      mpesa_receipt_id: 'SJA1000001',
      source_channel: 'DARAJA_STK',
      origin: 'RECONCILED',
      payload: {
        Body: { stkCallback: { ResultCode: 0, CallbackMetadata: { Item: [
          { Name: 'Amount', Value: '1500.00' },
          { Name: 'MpesaReceiptNumber', Value: 'SJA1000001' },
          { Name: 'TransactionDate', Value: '20261009101530' },
        ] } } },
        Reconciliation: { stkRequestId: STK_ID, corroborated: true, ...over },
      },
    };
  }

  it('resolves by the bound stkRequestId (no CheckoutRequestID needed), re-checks FOR UPDATE, consumes, settles', async () => {
    expect(await worker().process(reconciledStk())).toBe('settled');
    expect(agents.findStkRequestById).toHaveBeenCalledWith(fakePool, STK_ID);
    expect(agents.findStkRequest).not.toHaveBeenCalled();
    expect(stkRepo.lockReconciledStk).toHaveBeenCalledWith(expect.anything(), STK_ID, 'SJA1000001');
    expect(agents.consumeStkRequest).toHaveBeenCalledWith(expect.anything(), STK_ID, 'SJA1000001');
    expect(fakeEscrow.persistTransaction.mock.calls[0][0]).toMatchObject({ agent_id: 'agent-rec', source_channel: 'DARAJA_STK' });
    // Payment time = the statement's Completion Time (EAT → UTC), not the import time.
    expect(fakeEscrow.persistTransaction.mock.calls[0][0].timestamp.toISOString()).toBe('2026-10-09T07:15:30.000Z');
    expect(risk.evaluate).toHaveBeenCalledTimes(1); // never bypasses ML scoring
  });

  it('a FAILED request → stk_status_conflict_failed (terminal UNRESOLVED) + STK_STATUS_CONFLICT, never settled', async () => {
    m(agents.findStkRequestById).mockResolvedValue({ stkRequestId: STK_ID, agentId: 'a', amountCents: 150000, status: 'FAILED', consumedReceipt: null });
    expect(await worker().process(reconciledStk())).toBe('unresolved');
    expect(security.insertSecurityEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'STK_STATUS_CONFLICT', stkRequestId: STK_ID }));
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_status_conflict_failed');
    expect(m(intake.markUnresolved).mock.calls[0][4]).toMatchObject({ terminal: true });
    expect(fakeEscrow.persistTransaction).not.toHaveBeenCalled();
  });

  it('status changed under the row lock (e.g. a late failure callback) → rolled back, UNRESOLVED for review', async () => {
    m(stkRepo.lockReconciledStk).mockResolvedValue('status_changed');
    expect(await worker().process(reconciledStk())).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[0][3]).toContain('stk_status_conflict_reconciled');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('request consumed by another receipt → replay alarm; missing request → terminal', async () => {
    m(agents.findStkRequestById).mockResolvedValue({ stkRequestId: STK_ID, agentId: 'a', amountCents: 150000, status: 'ACCEPTED', consumedReceipt: 'OTHER00001' });
    expect(await worker().process(reconciledStk())).toBe('unresolved');
    expect(security.insertSecurityEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'STK_RECEIPT_REPLAY' }));
    m(agents.findStkRequestById).mockResolvedValue(null);
    expect(await worker().process(reconciledStk())).toBe('unresolved');
    expect(m(intake.markUnresolved).mock.calls[1][3]).toContain('reconciled_stk_request_missing');
  });

  it('an unbound (C2B-shaped) RECONCILED row resolves by agent code like any C2B payment', async () => {
    expect(await worker().process({ ...c2bRow(), origin: 'RECONCILED' })).toBe('settled');
    expect(agents.findAgentByCode).toHaveBeenCalledWith(fakePool, 'AG042');
    expect(agents.findStkRequestById).not.toHaveBeenCalled();
  });
});

describe('STK status conflict alarm (review fix)', () => {
  it('a genuine paid callback for a request the sweep marked FAILED → UNRESOLVED + STK_STATUS_CONFLICT (one per request)', async () => {
    m(agents.findStkRequest).mockResolvedValue({ stkRequestId: 'stk-9', agentId: 'a', amountCents: 150000, status: 'FAILED', consumedReceipt: null });
    expect(await worker().process(stkRow(1500))).toBe('unresolved');
    expect(security.insertSecurityEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'STK_STATUS_CONFLICT', stkRequestId: 'stk-9', receipt: 'NLJ7RT61SV' })
    );
  });
});
