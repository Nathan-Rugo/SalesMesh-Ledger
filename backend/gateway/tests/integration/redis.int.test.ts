/**
 * The idempotency Lua scripts against a real Redis (TEST_REDIS_URL; skipped when unset).
 *
 *   docker run -d --name sm-redis -p 56379:6379 redis:7
 *   TEST_REDIS_URL=redis://localhost:56379 npx jest tests/integration/redis
 */

 
import crypto from 'crypto';

// Requiring the modules under ts-jest and connecting can exceed 5 s while other suites load the CPU.
jest.setTimeout(30_000);

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const describeRedis = TEST_REDIS_URL ? describe : describe.skip;

describeRedis('idempotency Lua scripts (real Redis)', () => {
  let redis: any;
  let svc: any;
  const receipt = () => `IT${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const key = (r: string) => `mpesa:receipt:${r}`;
  const hashA = 'k1:' + 'a'.repeat(64);
  const hashB = 'k1:' + 'b'.repeat(64);

  beforeAll(async () => {
    const u = new URL(TEST_REDIS_URL!);
    process.env.REDIS_HOST = u.hostname;
    process.env.REDIS_PORT = u.port || '6379';
    if (u.password) process.env.REDIS_PASSWORD = decodeURIComponent(u.password);
    process.env.REDIS_IDEMPOTENCY_TTL_MS = '600000';
    // These tests verify the Lua semantics, not the 100 ms hot-path budget, which parallel
    // jest workers can exceed (the claim then correctly degrades to `unverified`).
    process.env.REDIS_COMMAND_TIMEOUT_MS = '5000';
    jest.isolateModules(() => {
      redis = require('../../src/config/redis').redisClient;
      svc = require('../../src/services/idempotency.service').idempotencyService;
    });
    await redis.connect();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  it('claim → existing(stored:false) → markStored → stored:true with the TTL preserved', async () => {
    const r = receipt();
    expect(await svc.claim(r, hashA)).toEqual({ kind: 'claimed' });
    expect(await svc.claim(r, hashA)).toEqual({ kind: 'existing', storedHash: hashA, stored: false });
    expect(await redis.get(key(r))).toBe(`${hashA}|PENDING`);

    const ttlBefore = await redis.pttl(key(r));
    expect(await svc.markStored(r, hashA)).toBe(true);
    expect(await redis.get(key(r))).toBe(`${hashA}|STORED`);
    const ttlAfter = await redis.pttl(key(r));
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore); // KEEPTTL: not reset to a fresh TTL or persisted
    expect(await svc.claim(r, hashA)).toEqual({ kind: 'existing', storedHash: hashA, stored: true });
  });

  it('markStored with a different hash is refused (CAS) and leaves the value untouched', async () => {
    const r = receipt();
    await svc.claim(r, hashA);
    expect(await svc.markStored(r, hashB)).toBe(false);
    expect(await redis.get(key(r))).toBe(`${hashA}|PENDING`);
    expect(await svc.claim(r, hashB)).toEqual({ kind: 'existing', storedHash: hashA, stored: false });
  });

  it('a legacy value without "|" reads as stored:false; markStored upgrades it', async () => {
    const r = receipt();
    await redis.set(key(r), hashA, 'PX', 600000);
    expect(await svc.claim(r, hashA)).toEqual({ kind: 'existing', storedHash: hashA, stored: false });
    expect(await svc.markStored(r, hashA)).toBe(true);
    expect(await redis.get(key(r))).toBe(`${hashA}|STORED`);
  });

  it('markStored on an expired/missing key sets STORED with a TTL', async () => {
    const r = receipt();
    expect(await svc.markStored(r, hashA)).toBe(true);
    expect(await redis.pttl(key(r))).toBeGreaterThan(0);
  });
});
