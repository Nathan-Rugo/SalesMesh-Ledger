import Redis from 'ioredis';

/**
 * Redis Configuration for SalesMesh-Ledger Backend Gateway.
 * 
 * Implements the deduplication backbone required for NFR-01 (sub-200ms SLA)
 * and supports Cryptographic Provenance (Thesis section 2.2.3) by providing
 * a robust, high-performance in-memory datastore for atomic lock checks.
 */

// Environment variable configuration with defaults
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
// NFR-01: a dedup check that cannot answer this fast falls through to Postgres (the dedup truth).
const parsedCommandTimeout = parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS || '', 10);
const REDIS_COMMAND_TIMEOUT_MS =
  Number.isFinite(parsedCommandTimeout) && parsedCommandTimeout > 0 ? parsedCommandTimeout : 100;

/**
 * Singleton Redis client instance.
 * Configured with resilient connection settings including exponential backoff.
 */
export const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  lazyConnect: true, // Do not block server startup
  enableReadyCheck: true, // Enables ready check for health probes
  // NFR-01: a dedup check must never queue while Redis is down — fail fast instead.
  enableOfflineQueue: false,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy: (times) => {
    // Exponential backoff with a minimum of 50ms and a maximum of 2000ms
    const delay = Math.min(Math.max(Math.pow(2, times) * 10, 50), 2000);
    return delay;
  },
});

// Connection event logging for monitoring and operational awareness
redisClient.on('connect', () => console.log('Redis client: connect event'));
redisClient.on('ready', () => console.log('Redis client: ready event'));
redisClient.on('error', (err) => console.error('Redis client: error event', err));
redisClient.on('close', () => console.log('Redis client: close event'));
redisClient.on('reconnecting', () => console.log('Redis client: reconnecting event'));

/**
 * Health probe function to verify Redis connectivity.
 * Validates NFR-01 SLA capabilities by pinging with a tight 200ms timeout.
 * 
 * @returns {Promise<boolean>} True if healthy and responding, false otherwise.
 */
export async function isRedisHealthy(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const pingPromise = redisClient.ping();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis ping timeout')), 200);
    });
    await Promise.race([pingPromise, timeoutPromise]);
    return true;
  } catch (error) {
    console.error('Redis health check failed:', (error as Error).message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gracefully disconnects the Redis client.
 */
export async function shutdownRedis(): Promise<void> {
  try {
    await redisClient.quit();
    console.log('Redis client disconnected gracefully.');
  } catch (error) {
    console.error('Error shutting down Redis client:', error);
  }
}
