/**
 * @file spool.service.ts
 * @description Outage safety net for the intake insert.
 *
 * When Postgres cannot take the intake row, the gateway still answers 503 (Daraja retries),
 * but it also spools the already-redacted payload to a Redis list. The settlement worker's
 * drainer later moves spooled items into mpesa_callbacks (ON CONFLICT, so double delivery —
 * spool + Daraja retry, or two drainers — is harmless) and only then removes them.
 */

import type Redis from 'ioredis';
import { redisClient } from '../config/redis';
import type { SourceChannel } from '../domain/callback';

export const SPOOL_KEY = 'mpesa:intake:spool';

/** Bound on the spool list; the oldest entries beyond it are trimmed (and logged). */
export const SPOOL_MAX_ITEMS = (() => {
  const n = parseInt(process.env.SPOOL_MAX_ITEMS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();

export interface SpoolItem {
  receipt: string;
  hash: string;
  channel: SourceChannel;
  payload: unknown; // redacted
  receivedAt: string; // ISO-8601 UTC
}

export class SpoolService {
  constructor(
    private readonly redis: Pick<Redis, 'lpush' | 'lrange' | 'lrem' | 'llen' | 'ltrim'> = redisClient,
    private readonly maxItems = SPOOL_MAX_ITEMS
  ) {}

  /** Best effort: returns false when Redis is unavailable too. */
  public async spool(item: SpoolItem): Promise<boolean> {
    try {
      const length = await this.redis.lpush(SPOOL_KEY, JSON.stringify(item));
      if (length > this.maxItems) {
        // LPUSH adds at the head, so the tail holds the oldest entries.
        await this.redis.ltrim(SPOOL_KEY, 0, this.maxItems - 1);
        console.error(`[Spool] spool exceeded ${this.maxItems} entries; ${length - this.maxItems} oldest trimmed (lost)`);
      }
      return true;
    } catch (error) {
      console.error(`[Spool] could not spool receipt ${item.receipt}:`, (error as Error).message);
      return false;
    }
  }

  /** Oldest-first view of up to `limit` raw spool entries (not removed). */
  public async peek(limit: number): Promise<string[]> {
    const raw = await this.redis.lrange(SPOOL_KEY, -limit, -1);
    return raw.reverse();
  }

  /** Removes one exact entry after it has been made durable. */
  public async remove(raw: string): Promise<void> {
    await this.redis.lrem(SPOOL_KEY, 1, raw);
  }

  public async depth(): Promise<number | null> {
    try {
      return await this.redis.llen(SPOOL_KEY);
    } catch {
      return null;
    }
  }
}

export const spoolService = new SpoolService();
