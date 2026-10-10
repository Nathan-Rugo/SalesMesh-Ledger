/**
 * @file ingress.test.ts
 * @description Comprehensive test suite for the SalesMesh-Ledger
 *              Upstream Ingestion Gateway.
 *
 * Test suites:
 *   1. Daraja Webhook Ingestion — NFR-01 Sub-200ms SLA, callback auth, DPA-safe logging
 *   2. Atomic Deduplication — FR-02 (Redis fast path, Postgres intake as source of truth)
 *   3. Circuit Breaker — NFR-08 Fail-Safe, ml-engine contract (raw mode)
 *
 * Settlement moved off the HTTP path into the settlement worker (spec gh-6): these tests
 * assert the durable intake insert instead of the old in-process settlement.
 *
 * All external dependencies (Redis, PostgreSQL, ML service) are mocked
 * so the suite runs entirely in-process with zero infrastructure.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// =====================================================================
// 1. MOCK SETUP — must run BEFORE any module imports
// =====================================================================

const CALLBACK_TOKEN = 'test-callback-token';
process.env.MPESA_CALLBACK_TOKEN = CALLBACK_TOKEN;

// --- Mock Redis (ioredis) with an in-memory Map ---
const mockRedisStore = new Map<string, string>();
const mockRedisLists = new Map<string, string[]>();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    // Mirrors IdempotencyService's claim-or-read and markStored (CAS, KEEPTTL) Lua scripts.
    eval: jest.fn(async (script: string, _numKeys: number, key: string, hash: string) => {
      if (script.includes('KEEPTTL')) {
        const v = mockRedisStore.get(key);
        if (v !== undefined && v.split('|')[0] !== hash) return 0;
        mockRedisStore.set(key, `${hash}|STORED`);
        return 1;
      }
      if (mockRedisStore.has(key)) return [0, mockRedisStore.get(key)];
      mockRedisStore.set(key, `${hash}|PENDING`);
      return [1];
    }),
    get: jest.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    del: jest.fn(async (key: string) => {
      mockRedisStore.delete(key);
      return 1;
    }),
    lpush: jest.fn(async (key: string, value: string) => {
      const list = mockRedisLists.get(key) ?? [];
      list.unshift(value);
      mockRedisLists.set(key, list);
      return list.length;
    }),
    llen: jest.fn(async (key: string) => (mockRedisLists.get(key) ?? []).length),
    ping: jest.fn(async () => 'PONG'),
    quit: jest.fn(async () => 'OK'),
    connect: jest.fn(async () => {}),
    on: jest.fn(),
  }));
});

// --- Mock PostgreSQL (pg): pool.query and pooled clients share one recorder ---
// mpesa_callbacks is modelled (receipt -> hash) so ON CONFLICT dedup behaves like Postgres.
const mockIntake = new Map<string, string>();
const mockPg = { down: false };
const mockPgQuery = jest.fn(async (text: string, values: any[] = []) => {
  if (mockPg.down) throw new Error('connect ECONNREFUSED');
  if (/INSERT INTO mpesa_callbacks/.test(text)) {
    if (mockIntake.has(values[0])) return { rows: [], rowCount: 0 };
    mockIntake.set(values[0], values[1]);
    return { rows: [{ callback_id: `cb-${values[0]}` }], rowCount: 1 };
  }
  if (/SELECT raw_payload_hash FROM mpesa_callbacks/.test(text)) {
    const h = mockIntake.get(values[0]);
    return { rows: h ? [{ raw_payload_hash: h }] : [], rowCount: h ? 1 : 0 };
  }
  return {
    rows: [{ transaction_id: 'test-tx-uuid', verification_id: 'test-ver-uuid', escrow_id: 'test-esc-uuid' }],
    rowCount: 1,
  };
});

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockPgQuery,
    connect: jest.fn(async () => ({ query: mockPgQuery, release: jest.fn() })),
    end: jest.fn(),
    on: jest.fn(),
  })),
}));

// --- Mock global fetch (ML service) ---
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// --- A successful ml-engine EvaluateResponse (service/schemas.py) ---
function mlSuccess(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      transaction_id: 'NLJ7RT61SV',
      isolation_score: 0.12,
      xgb_probability: 0.05,
      model_version: 'v1.0.0',
      model_sha256: 'a'.repeat(64),
      decision: 'CLEAR',
      triggered_layer: 1,
      layer2_adjudicated: false,
      reason: 'Layer 1 fast-clear',
      latency_ms: 4.2,
      evaluated_at: new Date().toISOString(),
      ...overrides,
    }),
  };
}

// =====================================================================
// 2. IMPORTS (after mocks are in place)
// =====================================================================

import app from '../src/index';
import { escrowService } from '../src/services/escrow.service';
import { settlementWorker } from '../src/workers/settlement.worker';
import { RETRYABLE_FAIL_SAFE_CAUSES } from '../src/services/risk_client.service';
import http from 'http';

// We need a lightweight HTTP helper — supertest adds a dependency.
// Instead, we use Node's built-in http module to make requests.

function postCallback(
  payload: object,
  token: string = CALLBACK_TOKEN
): Promise<{ status: number; body: any; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const start = Date.now();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: `/api/v1/mpesa/callback/${token}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const latencyMs = Date.now() - start;
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(body), latencyMs });
          } catch {
            resolve({ status: res.statusCode!, body, latencyMs });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Lets post-ACK work (markStored) finish. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** Intake rows actually created (conflicting inserts excluded). */
const intakeRows = () => mockIntake.size;

const sqlCalls = (re: RegExp) => mockPgQuery.mock.calls.filter(([sql]) => re.test(String(sql)));

// =====================================================================
// 3. SERVER LIFECYCLE
// =====================================================================

let server: http.Server;
let testPort: number;

beforeAll(async () => {
  // Start on a random port for test isolation
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      testPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });

  // JIT & socket warm-up to ensure first measurement accurately reflects gateway processing latency
  await postCallback({ ping: true });
  mockRedisStore.clear();
  mockIntake.clear();
});

afterAll((done) => {
  server.close(done);
});

beforeEach(async () => {
  await settle(); // no settlement from a previous test may leak into this one
  jest.clearAllMocks();
  mockRedisStore.clear();
  mockRedisLists.clear();
  mockIntake.clear();
  mockPg.down = false;
  mockFetch.mockReset();
  mockPgQuery.mockClear();
  // Default ML response for happy-path tests
  mockFetch.mockResolvedValue(mlSuccess());
});

// =====================================================================
// 4. FIXTURES
// =====================================================================

const VALID_STK_CALLBACK = {
  Body: {
    stkCallback: {
      MerchantRequestID: '29115-34620561-1',
      CheckoutRequestID: 'ws_CO_191220191020363925',
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: 1500.0 },
          { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
          { Name: 'TransactionDate', Value: 20191219102115 },
          { Name: 'PhoneNumber', Value: 254708374149 },
        ],
      },
    },
  },
};

// =====================================================================
// TEST SUITE 1: Daraja Webhook Ingestion — NFR-01 Sub-200ms SLA
// =====================================================================

describe('Suite 1: Daraja Webhook Ingestion — NFR-01 Sub-200ms SLA', () => {
  it('1a — returns HTTP 200 within 200 ms for valid STK Push callback', async () => {
    const { status, body, latencyMs } = await postCallback(VALID_STK_CALLBACK);

    expect(status).toBe(200);
    expect(body).toHaveProperty('ResultCode', 0);
    expect(latencyMs).toBeLessThan(200);
  });

  it('1b — returns HTTP 200 for malformed callback (no receipt number)', async () => {
    const malformed = {
      Body: {
        stkCallback: {
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: { Item: [] },
        },
      },
    };
    const { status } = await postCallback(malformed);
    expect(status).toBe(200);
  });

  it('1c — returns HTTP 200 for failed transaction (ResultCode !== 0)', async () => {
    const failed = {
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_191220191020363925',
          ResultCode: 1032,
          ResultDesc: 'Request cancelled by user',
        },
      },
    };
    const { status } = await postCallback(failed);
    expect(status).toBe(200);
  });

  it('1d — returns HTTP 200 for C2B format callback', async () => {
    const c2b = {
      TransID: 'OEI2AK4Q16',
      TransAmount: '500.00',
      BillRefNumber: 'invoice001',
      MSISDN: '254708374149',
    };
    const { status, body } = await postCallback(c2b);
    expect(status).toBe(200);
    expect(body.ResultCode).toBe(0);
  });

  it('1e — MSISDNs never reach the logs (Kenya DPA 2019)', async () => {
    const spies = (['info', 'warn', 'error'] as const).map((level) => jest.spyOn(console, level));
    try {
      await postCallback({ ...VALID_STK_CALLBACK, unexpected: true });
      await postCallback({ TransID: 'BAD', TransAmount: 'abc', MSISDN: '254708374149' });
      await postCallback({ MSISDN: '254708374149' });
      await settle();
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).not.toMatch(/2547\d{8}/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('1f — non-numeric, zero and negative amounts are dropped before settlement', async () => {
    for (const TransAmount of ['abc', '0', '-50', '']) {
      const { status } = await postCallback({ TransID: 'OEI2AK4Q16', TransAmount });
      expect(status).toBe(200);
    }
    await settle();
    expect(sqlCalls(/INSERT INTO mpesa_callbacks/)).toHaveLength(0);
  });

  it('1g — callbacks without the secret path token are rejected and never settled', async () => {
    const wrong = await postCallback(VALID_STK_CALLBACK, 'wrong-token-value-xx');
    expect(wrong.status).toBe(404);
    await settle();
    expect(sqlCalls(/INSERT INTO mpesa_callbacks/)).toHaveLength(0);
  });
});

// =====================================================================
// TEST SUITE 2: Atomic Deduplication — FR-02
// =====================================================================

describe('Suite 2: Atomic Deduplication — FR-02', () => {
  it('2a — first callback is settled, a retried identical callback is not', async () => {
    const res1 = await postCallback(VALID_STK_CALLBACK);
    const res2 = await postCallback(VALID_STK_CALLBACK);
    await settle();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(intakeRows()).toBe(1);
  });

  it('2b — concurrent duplicate callbacks (race condition) trigger exactly ONE settlement', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => postCallback(VALID_STK_CALLBACK)));
    await settle();

    // All MUST return 200 to prevent Daraja retry storms
    results.forEach((r) => expect(r.status).toBe(200));
    expect(intakeRows()).toBe(1);
  });

  it('2c — payload mutation: same receipt, different body raises the alarm and is not settled', async () => {
    const errSpy = jest.spyOn(console, 'error');
    try {
      await postCallback(VALID_STK_CALLBACK);

      // Tamper: same receipt number but different amount (1500 → 9999)
      const tampered = JSON.parse(JSON.stringify(VALID_STK_CALLBACK));
      tampered.Body.stkCallback.CallbackMetadata.Item[0].Value = 9999.0;

      const res = await postCallback(tampered);
      await settle();

      // Gateway still returns 200 (to avoid Daraja retry storm)
      expect(res.status).toBe(200);
      expect(errSpy.mock.calls.some(([m]) => String(m).includes('SECURITY ALARM'))).toBe(true);
      expect(intakeRows()).toBe(1);
      expect(sqlCalls(/INSERT INTO security_events/)).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('2d — a valid callback is durable (PENDING intake row, redacted) before the 200 and wakes the worker', async () => {
    const wake = jest.spyOn(settlementWorker, 'wake');
    try {
      const res = await postCallback(VALID_STK_CALLBACK);
      expect(res.status).toBe(200);

      const inserts = sqlCalls(/INSERT INTO mpesa_callbacks/);
      expect(inserts).toHaveLength(1);
      const stored = String(inserts[0][1]![3]);
      expect(stored).not.toMatch(/254708374149/);
      expect(wake).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled(); // no ML or settlement work on the hot path
      expect(sqlCalls(/INSERT INTO escrow_accounts/)).toHaveLength(0);
    } finally {
      wake.mockRestore();
    }
  });
});

// =====================================================================
// TEST SUITE 3: Circuit Breaker — NFR-08 Fail-Safe
// =====================================================================

describe('Suite 3: Circuit Breaker — NFR-08 Fail-Safe', () => {
  // For these tests we instantiate the ResilientRiskClient directly.
  // We do NOT go through the HTTP server because we need to control
  // timing and inspect internal state.

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ResilientRiskClient } = jest.requireActual('../src/services/risk_client.service') as any;
  // ^ We need the REAL class, not a mock.  However since fetch is already
  //   globally mocked, the class will use our mock fetch.

  let client: InstanceType<typeof ResilientRiskClient>;

  // ml-engine EvaluateRequest, raw mode (no extra keys allowed).
  const sampleRequest = {
    transaction_id: 'NLJ7RT61SV',
    transaction: {
      agent_id: 'agent-001',
      timestamp: '2026-10-01T07:00:00.000Z',
      amount: 1500,
      counterparty_id: 'k1:' + 'c'.repeat(64),
    },
    history: [
      {
        transaction_id: 'NLJ7RT61SA',
        agent_id: 'agent-001',
        timestamp: '2026-09-30T07:00:00.000Z',
        amount: 900,
        counterparty_id: 'k1:' + 'd'.repeat(64),
      },
    ],
  };

  const tripBreaker = async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await client.evaluate(sampleRequest);
    await client.evaluate(sampleRequest);
    await client.evaluate(sampleRequest);
    expect(client.getCircuitState().state).toBe('OPEN');
  };

  beforeEach(() => {
    client = new ResilientRiskClient();
    mockFetch.mockReset();
  });

  it('3a — circuit starts CLOSED, successful ML call keeps it CLOSED', async () => {
    mockFetch.mockResolvedValueOnce(mlSuccess());

    const result = await client.evaluate(sampleRequest);

    expect(client.getCircuitState().state).toBe('CLOSED');
    expect(result.decision).toBe('CLEAR');
    expect(result.isolation_score).toBe(0.12);
    expect(result.xgb_probability).toBe(0.05);
    expect(result.is_fail_safe).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('3b — 3 consecutive failures trip circuit to OPEN', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const r1 = await client.evaluate(sampleRequest);
    const r2 = await client.evaluate(sampleRequest);
    const r3 = await client.evaluate(sampleRequest);

    expect(client.getCircuitState().state).toBe('OPEN');
    // ALL three must return QUARANTINE (never CLEAR) — NFR-08
    expect(r1.decision).toBe('QUARANTINE');
    expect(r2.decision).toBe('QUARANTINE');
    expect(r3.decision).toBe('QUARANTINE');
    expect(r3.model_version).toBe('v1.0.0-failsafe');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('3c — OPEN circuit returns failsafe WITHOUT making HTTP call', async () => {
    await tripBreaker();
    mockFetch.mockClear();

    const result = await client.evaluate(sampleRequest);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.decision).toBe('QUARANTINE');
    expect(result.model_version).toContain('failsafe');
  });

  it('3d — circuit transitions OPEN → HALF_OPEN → CLOSED after cooling + success', async () => {
    await tripBreaker();

    // Fast-forward past the 30 s cooling period by directly mutating
    // the private openedAt.  This avoids needing real wall-clock waits.
    (client as any).openedAt = Date.now() - 31_000;

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(mlSuccess());

    const result = await client.evaluate(sampleRequest);

    expect(client.getCircuitState().state).toBe('CLOSED');
    expect(result.decision).toBe('CLEAR');
    expect(result.model_version).not.toContain('failsafe');
  });

  it('3e — HALF_OPEN failure sends circuit back to OPEN', async () => {
    await tripBreaker();
    (client as any).openedAt = Date.now() - 31_000;

    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error('still down'));

    const result = await client.evaluate(sampleRequest);

    expect(client.getCircuitState().state).toBe('OPEN');
    expect(result.decision).toBe('QUARANTINE');
  });

  it('3f — ML timeout aborts at the budget and fails safe', async () => {
    mockFetch.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        )
    );

    const t0 = Date.now();
    const result = await client.evaluate(sampleRequest);

    expect(Date.now() - t0).toBeLessThan(700);
    expect(result.decision).toBe('QUARANTINE');
    expect(result.reason).toContain('timeout');
    expect(result.model_version).toMatch(/-failsafe$/);
  });

  it('3g — REVIEW and malformed 200 responses are quarantined, never HELD', async () => {
    mockFetch.mockResolvedValueOnce(mlSuccess({ decision: 'REVIEW' }));
    const review = await client.evaluate(sampleRequest);
    expect(review.decision).toBe('REVIEW');

    mockPgQuery.mockClear();
    await escrowService.processSettlement('tx-1', review, 150);
    expect(sqlCalls(/INSERT INTO escrow_accounts/)[0][1]![3]).toBe('QUARANTINED');

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ decision: 'CLEAR' }) });
    const garbled = await client.evaluate(sampleRequest);
    expect(garbled.decision).toBe('QUARANTINE');
    expect(garbled.is_fail_safe).toBe(true);
  });

  it('3h — request body matches ml-engine EvaluateRequest exactly (raw mode)', async () => {
    mockFetch.mockResolvedValueOnce(mlSuccess());
    await client.evaluate(sampleRequest);

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Object.keys(sent).sort()).toEqual(['history', 'transaction', 'transaction_id']);
    expect(Object.keys(sent.transaction).sort()).toEqual(['agent_id', 'amount', 'counterparty_id', 'timestamp']);
    expect(Object.keys(sent.history[0]).sort()).toEqual([
      'agent_id',
      'amount',
      'counterparty_id',
      'timestamp',
      'transaction_id',
    ]);
  });

  it('3i — non-finite amounts are never sent (JSON would turn them into null)', async () => {
    const result = await client.evaluate({
      ...sampleRequest,
      transaction: { ...sampleRequest.transaction, amount: Number.NaN },
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.decision).toBe('QUARANTINE');
    expect(result.fail_safe_cause).toBe('invalid_request');
  });

  it('3j — 4xx contract rejections fail safe without tripping the breaker', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockFetch.mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: 'validation' }) });
      for (let i = 0; i < 5; i++) {
        expect((await client.evaluate(sampleRequest)).decision).toBe('QUARANTINE');
      }
      expect(client.getCircuitState().state).toBe('CLOSED');

      // Fail-safe cause mapping (ml-engine NFR-08 error bodies).
      mockFetch.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ fail_safe_cause: 'invalid_request' }) });
      expect((await client.evaluate(sampleRequest)).fail_safe_cause).toBe('invalid_request');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 413, json: async () => null });
      expect((await client.evaluate(sampleRequest)).fail_safe_cause).toBe('payload_too_large');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ fail_safe_cause: 'inference_error', retryable: true }) });
      expect((await client.evaluate(sampleRequest)).fail_safe_cause).toBe('inference_error');
      expect(RETRYABLE_FAIL_SAFE_CAUSES).not.toContain('invalid_request');
      expect(RETRYABLE_FAIL_SAFE_CAUSES).not.toContain('payload_too_large');
      expect(RETRYABLE_FAIL_SAFE_CAUSES).toContain('inference_error');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('3k — HALF_OPEN admits a single probe', async () => {
    await tripBreaker();
    (client as any).openedAt = Date.now() - 31_000;

    mockFetch.mockReset();
    let release!: (value: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    const probe = client.evaluate(sampleRequest);
    const second = await client.evaluate(sampleRequest);
    expect(second.decision).toBe('QUARANTINE');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    release(mlSuccess());
    expect((await probe).decision).toBe('CLEAR');
    expect(client.getCircuitState().state).toBe('CLOSED');
  });
});
