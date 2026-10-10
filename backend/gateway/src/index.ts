/**
 * @file index.ts
 * @description SalesMesh-Ledger Gateway — Express server entrypoint.
 *
 * Architectural role (BMAD / Thesis Ch. 3):
 *   The Upstream Ingestion Gateway receives Safaricom Daraja webhooks,
 *   applies security hardening, and routes traffic to the webhook controller.
 *   It also exposes a /health endpoint reporting Redis, Postgres, and
 *   Circuit Breaker status for operational observability.
 *
 * Settlement happens in background workers draining the durable intake queue
 * (settlement worker) and self-healing fail-safe quarantines (re-score worker).
 * Graceful shutdown: close the server, stop the workers (draining the current batch),
 * then close Redis and PostgreSQL.
 */

import 'dotenv/config'; // must run before any module reads process.env
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

// ── Config layer ──────────────────────────────────────────────────────
import { redisClient, isRedisHealthy, shutdownRedis } from './config/redis';
import pool, { isDbHealthy, shutdownDb } from './config/db';
import { assertPiiKey } from './config/pii';

// ── Routes ────────────────────────────────────────────────────────────
import webhookRoutes from './routes/webhook.routes';

// ── Services (for health endpoint and shutdown) ───────────────────────
import { resilientRiskClient } from './services/risk_client.service';
import { spoolService } from './services/spool.service';
import { queueStats } from './repositories/intake.repository';
import { quarantineStats } from './repositories/escrow.repository';
import { settlementWorker } from './workers/settlement.worker';
import { rescoreWorker } from './workers/rescore.worker';

// ── Express Application Setup ─────────────────────────────────────────
const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

/** TRUST_PROXY: "true"/"false", a hop count, or an express trust string ("loopback", CIDRs). */
export function parseTrustProxy(v: string | undefined): boolean | number | string | undefined {
  const t = v?.trim();
  if (!t) return undefined;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return t;
}

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
// Needed for MPESA_ALLOWED_IPS behind a proxy.
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

/** The callback/validation URLs carry MPESA_CALLBACK_TOKEN: never log it. */
export function redactPath(path: string): string {
  return path.replace(/\/(callback|validation)\/[^/?#]*/g, '/$1/:token');
}

let isShuttingDown = false;
let server: ReturnType<typeof app.listen> | undefined;

// 1. Security headers (helmet)
app.use(helmet());

// 2. CORS — configurable origin (defaults to permissive in dev)
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  })
);

// 3. Request ID middleware — every request gets a UUID for tracing
app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = uuidv4();
  (req as any).reqId = reqId;
  res.setHeader('X-Request-ID', reqId);
  next();
});

// 4. Request timing / logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // Log the route pattern, not the URL: the callback URL carries a secret token.
    const path = redactPath(req.route?.path ?? req.path);
    console.info(
      `[HTTP] ${req.method} ${path} ${res.statusCode} — ${ms}ms — ReqID: ${(req as any).reqId}`
    );
  });
  next();
});

// 5. Reject new requests during shutdown (must run before the routes)
app.use((_req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).send('Server is shutting down');
  }
  next();
});

// 6. Mount webhook routes (these apply their own JSON body parser with rawBody capture)
app.use('/', webhookRoutes);

// ── Health Check Endpoint ─────────────────────────────────────────────
/**
 * GET /health
 * Reports aggregated infrastructure health for container orchestrators.
 * Returns 200 if all dependencies are reachable, 503 if degraded.
 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const [redisOk, dbOk] = await Promise.all([isRedisHealthy(), isDbHealthy()]);
    const circuitBreaker = resilientRiskClient.getCircuitState();
    const isHealthy = redisOk && dbOk;

    // Queue observability; best effort (null when the DB cannot answer within ~1.5 s).
    const [queue, quarantine, spoolDepth] = await Promise.all([
      dbOk ? withTimeout(queueStats(pool)) : null,
      dbOk ? withTimeout(quarantineStats(pool, rescoreWorker.config.maxAttempts)) : null,
      spoolService.depth(),
    ]);

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'degraded',
      redis: redisOk,
      database: dbOk,
      circuitBreaker,
      ml: resilientRiskClient.getMetrics(),
      queue,
      awaitingSelfHeal: quarantine?.awaitingSelfHeal ?? null,
      stalledQuarantines: quarantine?.stalledQuarantines ?? null,
      spoolDepth,
      workers: { settlement: settlementWorker.isRunning(), rescore: rescoreWorker.isRunning() },
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: String(err) });
  }
});

const HEALTH_STATS_TIMEOUT_MS = 1_500;

/** Resolves null when `p` fails or takes longer than the health budget. */
function withTimeout<T>(p: Promise<T>, ms = HEALTH_STATS_TIMEOUT_MS): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ── Graceful Shutdown ─────────────────────────────────────────────────
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '', 10) > 0
  ? parseInt(process.env.SHUTDOWN_TIMEOUT_MS!, 10)
  : 15_000;

const gracefulShutdown = async (signal: string, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.info(`[Shutdown] Received ${signal}, draining connections…`);
  // Never hang forever on a stuck dependency.
  setTimeout(() => {
    console.error(`[Shutdown] Timed out after ${SHUTDOWN_TIMEOUT_MS} ms — forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await Promise.all([settlementWorker.stop(10_000), rescoreWorker.stop(10_000)]);
    await shutdownRedis();
    await shutdownDb();
    console.info('[Shutdown] All connections closed cleanly.');
    process.exit(exitCode);
  } catch (error) {
    console.error('[Shutdown] Error during teardown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  void gracefulShutdown('uncaughtException', 1);
});

// ── Start Listener ────────────────────────────────────────────────────
const REQUIRED_MIGRATION = '001_settlement_pipeline';

async function startup(): Promise<void> {
  try {
    assertPiiKey(); // PII_HMAC_KEY >= 32 bytes: every stored hash depends on it
  } catch (error) {
    console.error(`[Startup] ${(error as Error).message} — refusing to start.`);
    process.exit(1);
  }
  if (!process.env.MPESA_CALLBACK_TOKEN) {
    console.error('[Startup] MPESA_CALLBACK_TOKEN is not set (every Daraja callback would be rejected) — refusing to start.');
    process.exit(1);
  }
  try {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [REQUIRED_MIGRATION]);
    if (rows.length === 0) throw new Error(`migration ${REQUIRED_MIGRATION} is not recorded`);
  } catch (error) {
    console.error(
      `[Startup] Database schema is not migrated (${(error as Error).message}). Apply ` +
        `infra/scripts/migrations/${REQUIRED_MIGRATION}.sql (or init_db.sql on a fresh database) — refusing to start.`
    );
    process.exit(1);
  }

  // Connect Redis lazily on startup
  redisClient.connect().catch((err) => {
    console.error('[Startup] Redis initial connect failed (will retry):', err);
  });

  settlementWorker.start();
  rescoreWorker.start();

  server = app.listen(PORT, () => {
    console.info(`[Gateway] SalesMesh-Ledger ingestion gateway listening on :${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  void startup();
}

export default app;
