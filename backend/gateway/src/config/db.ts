import { Pool, PoolConfig } from 'pg';

/**
 * Database Configuration for SalesMesh-Ledger Backend Gateway.
 *
 * Two pools (raw `pg`, no ORM):
 *  - `pool` (default export) — the settlement workers, health and admin scripts.
 *  - `hotPool` — the Daraja callback hot path only (intake insert / C2B validation). It is
 *    sized separately and fails fast (connect + statement timeout ~150 ms) so a slow or
 *    unreachable Postgres turns into a 503 Daraja retries, never into a missed SLA.
 *
 * Every session runs in UTC (`TimeZone=UTC`); all pipeline timestamps are TIMESTAMPTZ.
 */

const int = (value: string | undefined, fallback: number): number => {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const HOT_PATH_TIMEOUT_MS = int(process.env.HOT_PATH_DEADLINE_MS, 150);

/** Creates a pool with the gateway's session defaults (UTC). */
export function createPool(overrides: PoolConfig = {}): Pool {
  const p = new Pool({
    host: process.env.DB_HOST,
    port: int(process.env.DB_PORT, 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    idleTimeoutMillis: 30_000,
    options: '-c TimeZone=UTC',
    ...overrides,
  });
  // Errors on idle clients must not crash the process.
  p.on('error', (err) => console.error('Unexpected error on idle database client:', err.message));
  return p;
}

const STATEMENT_TIMEOUT_MS = int(process.env.DB_STATEMENT_TIMEOUT_MS, 10_000);

const pool = createPool({
  max: int(process.env.DB_POOL_MAX, 20),
  connectionTimeoutMillis: 5_000,
  // Well under the worker's 5-minute visibility timeout.
  statement_timeout: STATEMENT_TIMEOUT_MS,
  query_timeout: STATEMENT_TIMEOUT_MS + 1_000,
});

export const hotPool = createPool({
  max: int(process.env.DB_HOT_POOL_MAX, 10),
  connectionTimeoutMillis: HOT_PATH_TIMEOUT_MS,
  statement_timeout: HOT_PATH_TIMEOUT_MS,
  query_timeout: HOT_PATH_TIMEOUT_MS + 50,
});

export default pool;

/**
 * Health probe function to verify PostgreSQL connectivity (2-second budget).
 */
export async function isDbHealthy(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database query timeout')), 2000);
    });
    await Promise.race([pool.query('SELECT 1'), timeoutPromise]);
    return true;
  } catch (error) {
    console.error('Database health check failed:', (error as Error).message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gracefully shuts down both PostgreSQL connection pools.
 */
export async function shutdownDb(): Promise<void> {
  try {
    await Promise.all([pool.end(), hotPool.end()]);
    console.log('Database pools shut down gracefully.');
  } catch (error) {
    console.error('Error shutting down database pools:', error);
  }
}
