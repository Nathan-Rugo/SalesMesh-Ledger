import { keyedHash } from '../config/pii';
import { redisClient } from '../config/redis';

/**
 * Redis value per receipt: "<hash>|PENDING" from claim until the intake insert commits, then
 * "<hash>|STORED" (set after the ACK). A legacy value without "|" counts as PENDING.
 *
 *  - claimed     first sighting: go insert.
 *  - existing    someone claimed it before. `stored` tells whether that attempt reached Postgres:
 *                a STORED duplicate is ACKed with no DB round trip; a PENDING one may have
 *                failed, so it goes to the intake insert (ON CONFLICT) which settles it.
 *  - unverified  Redis unavailable: fall through to Postgres, the source of truth for dedup.
 */
export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'existing'; storedHash: string; stored: boolean }
  | { kind: 'unverified' };

// Claim-or-read in one atomic step: no window between SET NX and GET.
const CLAIM_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1] .. '|PENDING', 'PX', ARGV[2], 'NX') then
  return {1}
end
return {0, redis.call('GET', KEYS[1])}
`;

// Compare-and-set to STORED, keeping the claim's TTL. Returns 1 on success, 0 on hash mismatch.
const MARK_STORED_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], ARGV[1] .. '|STORED', 'PX', ARGV[2])
  return 1
end
local h = v
local i = string.find(v, '|', 1, true)
if i then h = string.sub(v, 1, i - 1) end
if h ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1] .. '|STORED', 'KEEPTTL')
return 1
`;

export function parseRedisValue(value: string): { hash: string; stored: boolean } {
  const i = value.indexOf('|');
  if (i < 0) return { hash: value, stored: false }; // legacy value: PENDING
  return { hash: value.slice(0, i), stored: value.slice(i + 1) === 'STORED' };
}

const DEFAULT_TTL_MS = 86_400_000;

/** NaN / 0 / negative would make every SET ... PX fail (all claims "unverified"): use the default. */
export function idempotencyTtlMs(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Idempotency Service (FR-02 Atomic Deduplication, NFR-01 sub-200ms SLA).
 * Redis is the fast path; Postgres (mpesa_callbacks UNIQUE receipt) is the source of truth.
 */
class IdempotencyService {
  private static RECEIPT_KEY_PREFIX = 'mpesa:receipt:';
  private static LOCK_TTL_MS = idempotencyTtlMs(process.env.REDIS_IDEMPOTENCY_TTL_MS);

  private key(receipt: string): string {
    return `${IdempotencyService.RECEIPT_KEY_PREFIX}${receipt}`;
  }

  /**
   * Keyed HMAC-SHA256 of the raw request bytes as received ("k1:<hex>", Thesis sec 2.2.3).
   * Keyed so a payload carrying an MSISDN cannot be brute-forced back from its hash.
   */
  public hashPayload(rawBody: Buffer): string {
    return keyedHash('payload', rawBody);
  }

  /** Atomically claims a receipt, or reads what the first claimer stored. */
  public async claim(receiptNumber: string, payloadHash: string): Promise<ClaimResult> {
    try {
      const [claimed, value] = (await redisClient.eval(
        CLAIM_SCRIPT, 1, this.key(receiptNumber), payloadHash, String(IdempotencyService.LOCK_TTL_MS)
      )) as [number, string?];
      if (claimed === 1) return { kind: 'claimed' };
      if (typeof value !== 'string') return { kind: 'unverified' }; // expired between SET and GET
      const parsed = parseRedisValue(value);
      return { kind: 'existing', storedHash: parsed.hash, stored: parsed.stored };
    } catch (error) {
      console.error('[Idempotency] Redis unavailable, dedup unverified:', (error as Error).message);
      return { kind: 'unverified' };
    }
  }

  /** Records that the intake row for this receipt is durable (CAS on the hash, KEEPTTL). */
  public async markStored(receiptNumber: string, payloadHash: string): Promise<boolean> {
    try {
      const ok = await redisClient.eval(
        MARK_STORED_SCRIPT, 1, this.key(receiptNumber), payloadHash, String(IdempotencyService.LOCK_TTL_MS)
      );
      return ok === 1;
    } catch (error) {
      console.error('[Idempotency] markStored failed (retries will re-check Postgres):', (error as Error).message);
      return false;
    }
  }

  /**
   * Manually releases an idempotency lock (administrative cleanup or testing).
   */
  public async releaseLock(receiptNumber: string): Promise<void> {
    try {
      await redisClient.del(this.key(receiptNumber));
    } catch (error) {
      console.error(`Failed to release lock for receipt ${receiptNumber}:`, error);
    }
  }
}

export const idempotencyService = new IdempotencyService();
export default idempotencyService;
