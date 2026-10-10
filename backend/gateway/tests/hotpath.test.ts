/**
 * @file hotpath.test.ts
 * @description Durable-intake hot path (spec gh-6 I/O matrix): Redis fast path vs Postgres truth,
 * outage handling (503 + spool), mutation alarms, redaction, C2B validation, IP allowlist.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const CALLBACK_TOKEN = 'hotpath-callback-token';
process.env.MPESA_CALLBACK_TOKEN = CALLBACK_TOKEN;

const mockRedisStore = new Map<string, string>();
const mockRedisLists = new Map<string, string[]>();
const mockRedis = { down: false };

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => {
    const guard = () => {
      if (mockRedis.down) throw new Error('Connection is closed.');
    };
    return {
      eval: jest.fn(async (script: string, _n: number, key: string, hash: string) => {
        guard();
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
      lpush: jest.fn(async (key: string, value: string) => {
        guard();
        const list = mockRedisLists.get(key) ?? [];
        list.unshift(value);
        mockRedisLists.set(key, list);
        return list.length;
      }),
      llen: jest.fn(async (key: string) => (mockRedisLists.get(key) ?? []).length),
      del: jest.fn(),
      ping: jest.fn(async () => 'PONG'),
      quit: jest.fn(),
      connect: jest.fn(async () => {}),
      on: jest.fn(),
    };
  })
);

const mockIntake = new Map<string, string>();
const mockAgents = new Map<string, string>([['AG042', 'agent-uuid-42']]);
const mockPg = { down: false, delayMs: 0 };
const mockPgQuery = jest.fn(async (text: string, values: any[] = []): Promise<any> => {
  if (mockPg.delayMs) await new Promise((r) => setTimeout(r, mockPg.delayMs));
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
  if (/FROM sales_agents WHERE agent_code/.test(text)) {
    const id = mockAgents.get(values[0]);
    return { rows: id ? [{ agent_id: id }] : [], rowCount: id ? 1 : 0 };
  }
  return { rows: [], rowCount: 1 };
});

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockPgQuery,
    connect: jest.fn(async () => {
      if (mockPg.down) throw new Error('connect ECONNREFUSED');
      return { query: mockPgQuery, release: jest.fn() };
    }),
    end: jest.fn(),
    on: jest.fn(),
  })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import http from 'http';
import app from '../src/index';
import { idempotencyService, parseRedisValue } from '../src/services/idempotency.service';
import { SPOOL_KEY } from '../src/services/spool.service';
import { msisdnHash } from '../src/domain/callback';
import { settlementWorker } from '../src/workers/settlement.worker';
import { parseTrustProxy, redactPath } from '../src/index';

let server: http.Server;
let port = 0;

function post(path: string, payload: unknown, raw?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = raw ?? JSON.stringify(payload);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed: any = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
const callback = (payload: unknown, raw?: string) => post(`/api/v1/mpesa/callback/${CALLBACK_TOKEN}`, payload, raw);
const validate = (payload: unknown) => post(`/api/v1/mpesa/c2b/validation/${CALLBACK_TOKEN}`, payload);
const tick = () => new Promise((r) => setImmediate(r));
const sql = (re: RegExp) => mockPgQuery.mock.calls.filter(([t]) => re.test(String(t)));

const C2B = {
  TransactionType: 'Pay Bill',
  TransID: 'OEI2AK4Q16',
  TransTime: '20191122063845',
  TransAmount: '500.00',
  BusinessShortCode: '600638',
  BillRefNumber: ' ag042 ',
  MSISDN: '254708374149',
  FirstName: 'John',
  LastName: 'Doe',
};
const C2B_RAW = JSON.stringify(C2B);

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const a = server.address();
      port = typeof a === 'object' && a ? a.port : 0;
      resolve();
    });
  });
});
afterAll((done) => {
  server.close(done);
});
beforeEach(() => {
  mockRedisStore.clear();
  mockRedisLists.clear();
  mockIntake.clear();
  mockRedis.down = false;
  mockPg.down = false;
  mockPg.delayMs = 0;
  mockPgQuery.mockClear();
  mockFetch.mockReset();
  delete process.env.MPESA_ALLOWED_IPS;
});

describe('I/O matrix — hot path', () => {
  it('new callback → intake row PENDING (redacted, hash of bytes as received), 200, worker woken', async () => {
    const wake = jest.spyOn(settlementWorker, 'wake');
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });

    const [[, values]] = sql(/INSERT INTO mpesa_callbacks/) as any;
    expect(values[0]).toBe('OEI2AK4Q16');
    expect(values[1]).toBe(idempotencyService.hashPayload(Buffer.from(C2B_RAW)));
    expect(values[2]).toBe('C2B');
    const stored = JSON.parse(values[3]);
    expect(stored.MSISDN).toBe(msisdnHash('254708374149'));
    expect(stored.FirstName).toBe('[redacted]');
    expect(values[3]).not.toMatch(/254708374149|John|Doe/);
    expect(wake).toHaveBeenCalledTimes(1);
    wake.mockRestore();

    await tick();
    expect(mockRedisStore.get('mpesa:receipt:OEI2AK4Q16')).toMatch(/\|STORED$/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('retry, already stored → 200 with NO DB call (Redis says STORED)', async () => {
    await callback(null, C2B_RAW);
    await tick();
    mockPgQuery.mockClear();
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(200);
    expect(mockPgQuery).not.toHaveBeenCalled();
  });

  it('retry after a failed store (Redis PENDING, no intake row) → stored now, 200', async () => {
    const hash = idempotencyService.hashPayload(Buffer.from(C2B_RAW));
    mockRedisStore.set('mpesa:receipt:OEI2AK4Q16', `${hash}|PENDING`);
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(200);
    expect(mockIntake.get('OEI2AK4Q16')).toBe(hash);
  });

  it('a legacy Redis value without "|" counts as PENDING (DB is checked)', async () => {
    const hash = idempotencyService.hashPayload(Buffer.from(C2B_RAW));
    expect(parseRedisValue(hash)).toEqual({ hash, stored: false });
    mockRedisStore.set('mpesa:receipt:OEI2AK4Q16', hash);
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(200);
    expect(sql(/INSERT INTO mpesa_callbacks/)).toHaveLength(1);
  });

  it('mutation detected in Postgres (Redis lost the key) → 200, alarm persisted, original kept', async () => {
    await callback(null, C2B_RAW);
    const original = mockIntake.get('OEI2AK4Q16');
    mockRedisStore.clear();
    mockPgQuery.mockClear();
    const err = jest.spyOn(console, 'error');
    const res = await callback({ ...C2B, TransAmount: '9999.00' });
    expect(res.status).toBe(200);
    expect(err.mock.calls.some(([m]) => String(m).includes('SECURITY ALARM'))).toBe(true);
    err.mockRestore();
    expect(mockIntake.get('OEI2AK4Q16')).toBe(original);
    expect(sql(/INSERT INTO security_events/)).toHaveLength(1);
    expect(sql(/UPDATE escrow_accounts e\s+SET escrow_status = 'QUARANTINED', security_hold = TRUE/)).toHaveLength(1);
  });

  it('Postgres down → 503, nothing ACKed, redacted payload spooled to Redis', async () => {
    mockPg.down = true;
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(503);
    expect(res.body.ResultCode).not.toBe(0);
    await tick();
    const spooled = mockRedisLists.get(SPOOL_KEY) ?? [];
    expect(spooled).toHaveLength(1);
    expect(spooled[0]).not.toMatch(/254708374149|John/);
    expect(JSON.parse(spooled[0])).toMatchObject({ receipt: 'OEI2AK4Q16', channel: 'C2B' });
    // Redis keeps PENDING, so Daraja's retry re-checks Postgres.
    expect(mockRedisStore.get('mpesa:receipt:OEI2AK4Q16')).toMatch(/\|PENDING$/);

    mockPg.down = false;
    const retry = await callback(null, C2B_RAW);
    expect(retry.status).toBe(200);
    expect(mockIntake.has('OEI2AK4Q16')).toBe(true);
  });

  it('Postgres slow (insert beyond the ~150 ms deadline) → 503', async () => {
    mockPg.delayMs = 400;
    const t0 = Date.now();
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(380);
    mockPg.delayMs = 0;
    await new Promise((r) => setTimeout(r, 450)); // let the late insert land
  });

  it('Redis down → falls through to the DB insert path, 200', async () => {
    mockRedis.down = true;
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(200);
    expect(mockIntake.has('OEI2AK4Q16')).toBe(true);
  });

  it('Redis down AND duplicate → Postgres dedups (one row, 200)', async () => {
    mockRedis.down = true;
    await callback(null, C2B_RAW);
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(200);
    expect(mockIntake.size).toBe(1);
    expect(sql(/INSERT INTO security_events/)).toHaveLength(0);
  });

  it('STK PhoneNumber is replaced by its HMAC in the stored JSONB', async () => {
    const stk = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'm',
          CheckoutRequestID: 'ws_CO_1',
          ResultCode: '0',
          ResultDesc: 'ok',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: '1500' },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'TransactionDate', Value: 20191219102115 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    };
    expect((await callback(stk)).status).toBe(200);
    const [[, values]] = sql(/INSERT INTO mpesa_callbacks/) as any;
    const items = JSON.parse(values[3]).Body.stkCallback.CallbackMetadata.Item;
    expect(items.find((i: any) => i.Name === 'PhoneNumber').Value).toBe(msisdnHash('254708374149'));
  });
});

describe('C2B validation route', () => {
  it('accepts a known agent code (trimmed, upper-cased) and never writes intake', async () => {
    const res = await validate(C2B);
    expect(res.body).toEqual({ ResultCode: '0', ResultDesc: 'Accepted' });
    expect(sql(/mpesa_callbacks/)).toHaveLength(0);
  });

  it('rejects an unknown agent code with C2B00012', async () => {
    const res = await validate({ ...C2B, BillRefNumber: 'NOPE' });
    expect(res.body.ResultCode).toBe('C2B00012');
    expect(sql(/mpesa_callbacks/)).toHaveLength(0);
  });

  it('rejects an invalid amount (C2B00013) and fails closed when the lookup fails (C2B00016)', async () => {
    expect((await validate({ ...C2B, TransAmount: 'abc' })).body.ResultCode).toBe('C2B00013');
    mockPg.down = true;
    expect((await validate(C2B)).body.ResultCode).toBe('C2B00016');
  });

  it('requires the secret path token', async () => {
    const res = await post('/api/v1/mpesa/c2b/validation/wrong', C2B);
    expect(res.status).toBe(404);
  });
});

describe('forgery defences', () => {
  it('MPESA_ALLOWED_IPS rejects callbacks from other source IPs', async () => {
    process.env.MPESA_ALLOWED_IPS = '196.201.214.200, 196.201.214.206';
    const res = await callback(null, C2B_RAW);
    expect(res.status).toBe(404);
    expect(mockIntake.size).toBe(0);
    process.env.MPESA_ALLOWED_IPS = '127.0.0.1';
    expect((await callback(null, C2B_RAW)).status).toBe(200);
  });

  it('a wrong token of any length is rejected', async () => {
    for (const t of ['x', CALLBACK_TOKEN + 'x', CALLBACK_TOKEN.slice(0, -1)]) {
      expect((await post(`/api/v1/mpesa/callback/${t}`, C2B)).status).toBe(404);
    }
  });
});

describe('/health observability', () => {
  let afterThis: () => void = () => undefined;
  afterEach(() => afterThis());

  it('reports queue depth, oldest PENDING age, DEAD/UNRESOLVED/fail-safe counts, breaker and ML metrics', async () => {
    const original = mockPgQuery.getMockImplementation()!;
    afterThis = () => mockPgQuery.mockImplementation(original);
    mockPgQuery.mockImplementation(async (text: string) => {
      if (/FROM mpesa_callbacks WHERE status <> 'SETTLED'/.test(text)) {
        return { rows: [{ pending: 3, processing: 1, oldest: 12.5, unresolved: 2, failed: 0, dead: 1 }], rowCount: 1 };
      }
      if (/AS awaiting/.test(text)) return { rows: [{ awaiting: 4, stalled: 2 }], rowCount: 1 };
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    });
    const res = await new Promise<any>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/health' }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b) }));
      }).on('error', reject);
    });
    expect(res.status).toBe(200);
    expect(res.body.queue).toMatchObject({ depth: 4, oldestPendingAgeSeconds: 12.5, dead: 1, unresolved: 2 });
    expect(res.body.awaitingSelfHeal).toBe(4);
    expect(res.body.stalledQuarantines).toBe(2);
    expect(res.body.workers).toEqual({ settlement: false, rescore: false });
    expect(res.body.circuitBreaker.state).toBe('CLOSED');
    expect(res.body.ml).toMatchObject({ timeoutMs: 500, timeoutRate: 0 });
    expect(res.body).toHaveProperty('spoolDepth');
  });
});

describe('review fixes — hot path', () => {
  it('Redis PENDING with different bytes and no intake row → stored, mutation recorded, 200 (payment not lost)', async () => {
    mockRedisStore.set('mpesa:receipt:OEI2AK4Q16', `k1:${'0'.repeat(64)}|PENDING`);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const wake = jest.spyOn(settlementWorker, 'wake');
    try {
      const res = await callback(null, C2B_RAW);
      expect(res.status).toBe(200);
      expect(mockIntake.get('OEI2AK4Q16')).toBe(idempotencyService.hashPayload(Buffer.from(C2B_RAW)));
      expect(sql(/INSERT INTO security_events/)).toHaveLength(1);
      expect(wake).toHaveBeenCalled();
    } finally {
      err.mockRestore();
      wake.mockRestore();
    }
  });

  it('Redis STORED with different bytes → mutation alarm + 200, no intake insert', async () => {
    mockRedisStore.set('mpesa:receipt:OEI2AK4Q16', `k1:${'0'.repeat(64)}|STORED`);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await callback(null, C2B_RAW)).status).toBe(200);
      expect(sql(/INSERT INTO mpesa_callbacks/)).toHaveLength(0);
      expect(sql(/INSERT INTO security_events/)).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it('an unprefixed legacy Redis hash falls through to Postgres instead of a false alarm', async () => {
    mockRedisStore.set('mpesa:receipt:OEI2AK4Q16', 'a'.repeat(64));
    expect((await callback(null, C2B_RAW)).status).toBe(200);
    expect(mockIntake.size).toBe(1);
  });

  it('key rotation: identical bytes first stored under k1 are a duplicate under k2 (no alarm)', async () => {
    const saved = { ...process.env };
    try {
      expect((await callback(null, C2B_RAW)).status).toBe(200); // stored under k1
      await tick();
      process.env.PII_HMAC_KEY_PREVIOUS = process.env.PII_HMAC_KEY;
      process.env.PII_HMAC_KEY_PREVIOUS_ID = 'k1';
      process.env.PII_HMAC_KEY = 'rotated-key-for-tests-0123456789abcdef!!';
      process.env.PII_HMAC_KEY_ID = 'k2';
      mockPgQuery.mockClear();
      expect((await callback(null, C2B_RAW)).status).toBe(200);
      mockRedisStore.clear(); // and via the Postgres comparison
      expect((await callback(null, C2B_RAW)).status).toBe(200);
      expect(sql(/INSERT INTO security_events/)).toHaveLength(0);
    } finally {
      process.env = saved;
    }
  });

  it('C2B validation rejects a phone-like BillRefNumber (C2B00012)', async () => {
    expect((await validate({ ...C2B, BillRefNumber: '0708374149' })).body.ResultCode).toBe('C2B00012');
    expect((await validate({ ...C2B, BillRefNumber: '+254 708 374 149' })).body.ResultCode).toBe('C2B00012');
  });

  it('malformed / oversized JSON: callback → ACK body 200, validation → rejection, no payload logged', async () => {
    const logs = (['info', 'warn', 'error'] as const).map((l) => jest.spyOn(console, l));
    try {
      const bad = await callback(null, '{"TransID":"OEI2AK4Q16","MSISDN":"254708374149",');
      expect(bad.status).toBe(200);
      expect(bad.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      const big = await callback(null, JSON.stringify({ pad: 'x'.repeat(1_100_000) }));
      expect(big.status).toBe(200);
      const v = await post(`/api/v1/mpesa/c2b/validation/${CALLBACK_TOKEN}`, null, '{not json');
      expect(v.body).toEqual({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' });
      const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).not.toMatch(/254708374149/);
      expect(mockIntake.size).toBe(0);
    } finally {
      logs.forEach((s) => s.mockRestore());
    }
  });

  it('IP and token checks run before the body is parsed', async () => {
    expect((await post('/api/v1/mpesa/callback/wrong-token', null, '{not json')).status).toBe(404);
  });

  it('MPESA_CALLBACK_TOKEN never appears in any log line', async () => {
    const logs = (['info', 'warn', 'error', 'log'] as const).map((l) => jest.spyOn(console, l));
    try {
      await callback(null, C2B_RAW);
      await post('/api/v1/mpesa/callback/not-the-token-xyz', C2B);
      await new Promise<void>((resolve) => {
        http.get({ hostname: '127.0.0.1', port, path: `/api/v1/mpesa/callback/${CALLBACK_TOKEN}` }, (r) => {
          r.resume();
          r.on('end', () => resolve());
        });
      });
      await tick();
      const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toMatch(/\/callback\/:token/);
      expect(logged).not.toContain(CALLBACK_TOKEN);
      expect(logged).not.toContain('not-the-token-xyz');
    } finally {
      logs.forEach((s) => s.mockRestore());
    }
  });

  it('redactPath and parseTrustProxy', () => {
    expect(redactPath('/api/v1/mpesa/callback/secret')).toBe('/api/v1/mpesa/callback/:token');
    expect(redactPath('/api/v1/mpesa/c2b/validation/secret/x')).toBe('/api/v1/mpesa/c2b/validation/:token/x');
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('')).toBeUndefined();
  });
});
