/**
 * Shared harness for the resilience suites (spec gh-15): a throwaway database, the real webhook
 * router on its own express app, and the gateway's own Postgres and Redis clients pointed at
 * in-process fault proxies. Skipped unless TEST_DATABASE_URL and TEST_REDIS_URL are both set.
 */

import crypto from 'crypto';
import express from 'express';
import { listen, type TestServer } from '../../support/http';
import { startFaultProxy, type FaultProxy } from '../../support/fault-proxy';
import { createTestDb, INIT_SQL, TEST_DATABASE_URL, type TestDb } from '../helpers';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const describeStack = TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;

export const CALLBACK_TOKEN = 'resilience-callback-token';
export const CALLBACK_PATH = `/api/v1/mpesa/callback/${CALLBACK_TOKEN}`;

export interface Stack {
  db: TestDb;
  pg: FaultProxy;
  redis: FaultProxy;
  srv: TestServer;
  /** src/ modules loaded against the proxies (one isolated registry, so singletons are shared). */
  mods: {
    redisClient: any;
    hotPool: any;
    shutdownDb: () => Promise<void>;
    SettlementWorker: any;
    RescoreWorker: any;
    ResilientRiskClient: any;
    spoolService: any;
    SPOOL_KEY: string;
  };
  post(body: unknown): Promise<number>;
  close(): Promise<void>;
}

/** Starts the stack. `env` is applied before any src/ module is loaded (e.g. HOT_PATH_DEADLINE_MS). */
export async function startStack(prefix: string, env: Record<string, string> = {}): Promise<Stack> {
  const db = await createTestDb(prefix);
  await db.pool.query(INIT_SQL);
  const pgUrl = new URL(TEST_DATABASE_URL!);
  const redisUrl = new URL(TEST_REDIS_URL!);
  const pg = await startFaultProxy(pgUrl.hostname, Number(pgUrl.port || 5432));
  const redis = await startFaultProxy(redisUrl.hostname, Number(redisUrl.port || 6379));

  Object.assign(process.env, {
    MPESA_CALLBACK_TOKEN: CALLBACK_TOKEN,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(pg.port),
    DB_USER: decodeURIComponent(pgUrl.username),
    DB_PASSWORD: decodeURIComponent(pgUrl.password),
    DB_NAME: db.name,
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(redis.port),
    ...env,
  });
  if (redisUrl.password) process.env.REDIS_PASSWORD = decodeURIComponent(redisUrl.password);

  let mods!: Stack['mods'];
  let router!: express.Router;
  jest.isolateModules(() => {
    const dbMod = require('../../../src/config/db');
    const spool = require('../../../src/services/spool.service');
    mods = {
      redisClient: require('../../../src/config/redis').redisClient,
      hotPool: dbMod.hotPool,
      shutdownDb: dbMod.shutdownDb,
      SettlementWorker: require('../../../src/workers/settlement.worker').SettlementWorker,
      RescoreWorker: require('../../../src/workers/rescore.worker').RescoreWorker,
      ResilientRiskClient: require('../../../src/services/risk_client.service').ResilientRiskClient,
      spoolService: spool.spoolService,
      SPOOL_KEY: spool.SPOOL_KEY,
    };
    router = require('../../../src/routes/webhook.routes').default;
  });
  await mods.redisClient.connect();
  const app = express();
  app.use(router);
  const srv = await listen(app);

  return {
    db,
    pg,
    redis,
    srv,
    mods,
    post: async (body) => (await srv.request('POST', CALLBACK_PATH, { body })).status,
    async close() {
      await srv.close();
      await mods.redisClient.quit().catch(() => mods.redisClient.disconnect());
      await mods.shutdownDb();
      await pg.close();
      await redis.close();
      await db.drop();
    },
  };
}

/** Per-run receipt prefix: Redis (db 0, 24 h TTL) is shared across runs and parallel test files. */
export const runPrefix = () => `X${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

export function c2b(receipt: string, agentCode: string, amount = '500.00', msisdn = '254708374149') {
  return {
    TransactionType: 'Pay Bill',
    TransID: receipt,
    TransTime: '20261001120000', // in the past: future Daraja times are distrusted
    TransAmount: amount,
    BusinessShortCode: '600638',
    BillRefNumber: agentCode,
    MSISDN: msisdn,
    FirstName: 'Jane',
  };
}

export function stkCallback(receipt: string, checkoutRequestId: string, amount: number) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'TransactionDate', Value: 20261001120000 },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
      },
    },
  };
}

/** Daraja-style redelivery: retries a non-200 with a short backoff; returns every status seen. */
export async function deliverUntilAck(post: () => Promise<number>, attempts = 20, backoffMs = 150): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const status = await post().catch(() => 0);
    seen.push(status);
    if (status === 200) return seen;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  return seen;
}

export const quiet = () => {
  for (const level of ['log', 'info', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
};
