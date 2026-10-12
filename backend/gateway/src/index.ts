/**
 * @file index.ts
 * @description SalesMesh-Ledger Gateway — Express server entrypoint.
 *
 * Architectural role (BMAD / Thesis Ch. 3):
 *   The Upstream Ingestion Gateway receives Safaricom Daraja webhooks,
 *   applies security hardening, and routes traffic to the webhook controller.
 *   Agents authenticate with phone + PIN (RS256 access tokens, rotating refresh
 *   cookies — /api/v1/auth), trigger STK Pushes (/api/v1/payments/stk) and register a verified
 *   M-Pesa payout destination (/api/v1/payout-destinations, PAYOUTS_ENABLED=true).
 *   Health: /health/live and /health/ready are minimal unauthenticated probes;
 *   /health/details (MERCHANT_ADMIN) reports queue, ML, login, STK and Daraja metrics.
 *
 * Settlement happens in background workers draining the durable intake queue
 * (settlement worker) and self-healing fail-safe quarantines (re-score worker). With
 * RECONCILE_ENABLED=true the STK Query reconciliation sweep closes overdue ACCEPTED STK requests
 * (spec gh-6-recon); statements are imported with `npm run reconcile:import`.
 * Graceful shutdown: close the server, stop the workers (draining the current batch),
 * then close Redis and PostgreSQL.
 */

import 'dotenv/config'; // must run before any module reads process.env
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';

// ── Config layer ──────────────────────────────────────────────────────
import { redisClient, isRedisHealthy, shutdownRedis } from './config/redis';
import pool, { isDbHealthy, shutdownDb } from './config/db';
import { assertPiiKey } from './config/pii';
import { loadJwtKeyring } from './config/jwt';
import { b2cConfig, darajaConfig } from './daraja/client';
import { overdueAfterMs, reconcileEnabled } from './config/reconcile';
import { trustConfig } from './config/trust';
import { corsOrigins, publicOrigin, requireAuth } from './auth/middleware';
import type { Db } from './repositories/db.types';

// ── Routes ────────────────────────────────────────────────────────────
import webhookRoutes from './routes/webhook.routes';
import { createAuthRouter } from './routes/auth.routes';
import { createPaymentsRouter, stkEnabled } from './routes/payments.routes';
import { createPayoutDestinationRouter } from './routes/payout_destination.routes';
import { metrics } from './services/metrics.service';
import { payoutDestinationService, payoutsEnabled } from './services/payout_destination.service';

// ── Services (for health endpoint and shutdown) ───────────────────────
import { resilientRiskClient } from './services/risk_client.service';
import { spoolService } from './services/spool.service';
import { queueStats } from './repositories/intake.repository';
import { quarantineStats } from './repositories/escrow.repository';
import { reconcileStats } from './repositories/reconcile.repository';
import { ensureConfigSnapshot, trustStats } from './repositories/trust.repository';
import { settlementWorker } from './workers/settlement.worker';
import { rescoreWorker } from './workers/rescore.worker';
import { reconcileWorker } from './workers/reconcile.worker';

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
  return path.replace(/\/(callback|validation|b2c\/result|b2c\/timeout)\/[^/?#]*/g, '/$1/:token');
}

let isShuttingDown = false;
let server: ReturnType<typeof app.listen> | undefined;

// 1. Security headers (helmet)
app.use(helmet());

// 2. CORS — credentialed allowlist (CORS_ORIGINS, exact origins). Same-site deployment is required
//    for the SameSite=Strict refresh cookie; anything not listed gets no CORS headers.
app.use(
  cors({
    origin: (origin, cb) => cb(null, origin !== undefined && corsOrigins().includes(origin) ? origin : false),
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['Retry-After', 'X-Request-ID'],
  })
);

// 3. Request ID middleware — every request gets a UUID for tracing
app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = crypto.randomUUID();
  req.reqId = reqId;
  res.setHeader('X-Request-ID', reqId);
  next();
});

// 4. Request timing / logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // Log the route pattern, not the URL: the callback URL carries a secret token.
    const path = redactPath(req.route ? `${req.baseUrl}${req.route.path}` : req.path);
    console.info(
      `[HTTP] ${req.method} ${path} ${res.statusCode} — ${ms}ms — ReqID: ${req.reqId}`
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

// 7. Agent authentication and STK Push initiation (each router parses its own small JSON bodies)
app.use('/api/v1/auth', createAuthRouter());
app.use('/api/v1/payments', createPaymentsRouter());
app.use('/api/v1/payout-destinations', createPayoutDestinationRouter());

// ── Health Check Endpoints ────────────────────────────────────────────
/** GET /health/live — the process is up. No dependencies, no metrics. */
app.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

/** GET /health/ready — Redis and Postgres reachable (container HEALTHCHECK). No metrics. */
app.get('/health/ready', async (_req: Request, res: Response) => {
  const [redisOk, dbOk] = await Promise.all([isRedisHealthy(), isDbHealthy()]).catch(() => [false, false]);
  const ready = redisOk && dbOk && !isShuttingDown;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded' });
});

/**
 * GET /health/details (MERCHANT_ADMIN) — aggregated infrastructure health plus queue, ML, login,
 * STK-outcome and Daraja-latency metrics. 200 if Redis and Postgres are reachable, else 503.
 */
/** A monitoring scraper may present X-Metrics-Token = HEALTH_METRICS_TOKEN (constant-time compare). */
export function metricsTokenValid(given: string | undefined, expected: string | undefined = process.env.HEALTH_METRICS_TOKEN): boolean {
  if (!expected || !given) return false;
  const h = (v: string) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}
const adminOnly = requireAuth(['MERCHANT_ADMIN']);
const detailsAuth = (req: Request, res: Response, next: NextFunction) =>
  metricsTokenValid(req.get('X-Metrics-Token')) ? next() : adminOnly(req, res, next);

app.get('/health/details', detailsAuth, async (_req: Request, res: Response) => {
  try {
    const [redisOk, dbOk] = await Promise.all([isRedisHealthy(), isDbHealthy()]);
    const circuitBreaker = resilientRiskClient.getCircuitState();
    const isHealthy = redisOk && dbOk;

    // Queue observability; best effort (null when the DB cannot answer within ~1.5 s).
    const [queue, quarantine, spoolDepth, recon, trust] = await Promise.all([
      dbOk ? withTimeout(queueStats(pool)) : null,
      dbOk ? withTimeout(quarantineStats(pool, rescoreWorker.config.maxAttempts)) : null,
      spoolService.depth(),
      dbOk ? withTimeout(reconcileStats(pool, overdueAfterMs(reconcileWorker.config))) : null,
      dbOk ? withTimeout(trustStats(pool)) : null,
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
      trust, // spec gh-23: average S_t, computed-hold distribution (24 h), quarantines by reason
      workers: { settlement: settlementWorker.isRunning(), rescore: rescoreWorker.isRunning(), reconcile: reconcileWorker.isRunning() },
      reconciliation: {
        enabled: reconcileEnabled(),
        paidUnconfirmed: recon?.paidUnconfirmed ?? null,
        reconcileExhausted: recon?.exhausted ?? null,
        overdueAccepted: recon?.overdueAccepted ?? null,
        oldestOverdueAcceptedAgeSeconds: recon?.oldestOverdueAcceptedAgeSeconds ?? null,
        lastSweepAt: reconcileWorker.lastSweepAt?.toISOString() ?? null,
        lastImportAt: recon?.lastImportAt ?? null,
        latestImport: recon?.latestRun ?? null,
        openExceptions: recon?.openExceptions ?? null,
        sweepCounters: { ...reconcileWorker.counters },
      },
      ...metrics.snapshot(),
      countersScope: 'per-process', // login / STK / Daraja counters reset on restart and are not summed across replicas
      stkEnabled: stkEnabled(),
      payoutsEnabled: payoutsEnabled(),
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
    await Promise.all([settlementWorker.stop(10_000), rescoreWorker.stop(10_000), reconcileWorker.stop(10_000)]);
    await payoutDestinationService.settled(); // in-flight alerts still read the pool
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
export const REQUIRED_MIGRATION = '005_payout_destinations';

/**
 * Startup gates, without side effects: `fatal` problems refuse the start, `warnings` are logged.
 * Secrets, the JWT key ring, Daraja (when STK_ENABLED or RECONCILE_ENABLED), Daraja B2C (when
 * PAYOUTS_ENABLED), the callback token,
 * the schema version.
 */
export async function preflight(env: NodeJS.ProcessEnv, db: Db): Promise<{ fatal: string[]; warnings: string[] }> {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const gate = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      fatal.push((error as Error).message);
    }
  };
  gate(() => assertPiiKey(env)); // PII_HMAC_KEY >= 32 bytes: every stored hash depends on it
  gate(() => loadJwtKeyring(env)); // RS256 key ring, >= 2048-bit RSA: every access token depends on it
  gate(() => trustConfig(env)); // risk-adaptive hold parameters (spec gh-23): every escrow hold depends on them
  // STK initiation and the STK Query reconciliation sweep both need the Daraja credentials.
  if (stkEnabled(env) || reconcileEnabled(env)) gate(() => darajaConfig(env));
  // Payout-destination verification (spec gh-11) needs the B2C initiator; SMS alerts stay optional.
  if (payoutsEnabled(env)) gate(() => b2cConfig(env));
  const sms = ['AFRICASTALKING_USERNAME', 'AFRICASTALKING_API_KEY'].filter((k) => env[k]?.trim());
  if (sms.length === 1) warnings.push('AFRICASTALKING_* is only partly set: payout alerts are log-only until both are set');
  if (!env.MPESA_CALLBACK_TOKEN) fatal.push('MPESA_CALLBACK_TOKEN is not set (every Daraja callback would be rejected)');
  try {
    const { rows } = await db.query('SELECT 1 FROM schema_migrations WHERE version = $1', [REQUIRED_MIGRATION]);
    if (rows.length === 0) throw new Error(`migration ${REQUIRED_MIGRATION} is not recorded`);
  } catch (error) {
    fatal.push(
      `Database schema is not migrated (${(error as Error).message}). Apply the infra/scripts/migrations/*.sql ` +
        `in order, up to ${REQUIRED_MIGRATION} (or init_db.sql on a fresh database)`
    );
  }
  if (env.AUTH_COOKIE_INSECURE_DEV === 'true') {
    warnings.push(
      env.NODE_ENV === 'production'
        ? 'AUTH_COOKIE_INSECURE_DEV is ignored in production.'
        : 'AUTH_COOKIE_INSECURE_DEV=true: auth cookies are not Secure (plain-HTTP development only).'
    );
  }
  if (env.NODE_ENV === 'production' && !env.TRUST_PROXY?.trim() && !publicOrigin(env)) {
    warnings.push(
      'neither TRUST_PROXY nor PUBLIC_ORIGIN is set: behind a proxy every login shares the proxy IP for throttling, ' +
        'and same-origin refresh/logout may fail the Origin check'
    );
  }
  return { fatal, warnings };
}

async function startup(): Promise<void> {
  const { fatal, warnings } = await preflight(process.env, pool);
  for (const w of warnings) console.warn(`[Startup] ${w}`);
  if (fatal.length > 0) {
    for (const f of fatal) console.error(`[Startup] ${f}`);
    console.error('[Startup] refusing to start.');
    process.exit(1);
  }

  // The trust parameters in force get their snapshot row (a no-op when unchanged).
  await ensureConfigSnapshot(pool).catch((e) => console.error('[Startup] trust config snapshot failed:', (e as Error).message));

  // Connect Redis lazily on startup
  redisClient.connect().catch((err) => {
    console.error('[Startup] Redis initial connect failed (will retry):', err);
  });

  settlementWorker.start();
  rescoreWorker.start();
  if (reconcileEnabled()) reconcileWorker.start();

  server = app.listen(PORT, () => {
    console.info(`[Gateway] SalesMesh-Ledger ingestion gateway listening on :${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  void startup();
}

export default app;
