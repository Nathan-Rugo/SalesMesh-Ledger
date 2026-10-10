/**
 * @file preflight.test.ts
 * @description The startup refusal gates (spec gh-5), via the side-effect-free preflight():
 * JWT keys, Daraja config when STK is enabled, the schema version, plus the proxy warning.
 */

import { preflight, REQUIRED_MIGRATION } from '../src/index';

const migrated: any = { query: jest.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })) };
const only001: any = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  PII_HMAC_KEY: process.env.PII_HMAC_KEY,
  JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY,
  JWT_KEY_ID: 'test-k1',
  MPESA_CALLBACK_TOKEN: 'cbtok123',
};
const daraja = {
  STK_ENABLED: 'true',
  DARAJA_CONSUMER_KEY: 'k',
  DARAJA_CONSUMER_SECRET: 's',
  DARAJA_BUSINESS_SHORTCODE: '174379',
  DARAJA_PASSKEY: 'p',
  DARAJA_CALLBACK_URL: 'https://gw.example/api/v1/mpesa/callback/cbtok123',
};

describe('preflight (startup refusal gates)', () => {
  it('a complete configuration on a migrated DB passes', async () => {
    expect(await preflight({ ...base, ...daraja }, migrated)).toEqual({ fatal: [], warnings: [] });
    expect(migrated.query).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'), [REQUIRED_MIGRATION]);
  });

  it('STK enabled without the Daraja credentials → fatal (STK disabled → not required)', async () => {
    const r = await preflight({ ...base, STK_ENABLED: 'true' }, migrated);
    expect(r.fatal).toEqual([expect.stringMatching(/missing DARAJA_CONSUMER_KEY/)]);
    expect((await preflight({ ...base, STK_ENABLED: 'false' }, migrated)).fatal).toEqual([]);
    const badUrl = await preflight({ ...base, ...daraja, DARAJA_CALLBACK_URL: 'https://gw.example/api/v1/mpesa/callback/${MPESA_CALLBACK_TOKEN}' }, migrated);
    expect(badUrl.fatal).toEqual([expect.stringMatching(/unexpanded/)]);
  });

  it('a database at migration 001 only (or unreachable) → fatal', async () => {
    expect((await preflight(base, only001)).fatal).toEqual([expect.stringMatching(/not migrated.*002_auth_stk_initiation/)]);
    const down: any = { query: jest.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))) };
    expect((await preflight(base, down)).fatal).toEqual([expect.stringMatching(/ECONNREFUSED/)]);
  });

  it('missing JWT keys, missing PII key, missing callback token → fatal, all reported together', async () => {
    const r = await preflight({ NODE_ENV: 'development' }, migrated);
    expect(r.fatal).toEqual([
      expect.stringMatching(/PII_HMAC_KEY/),
      expect.stringMatching(/JWT_PRIVATE_KEY/),
      expect.stringMatching(/MPESA_CALLBACK_TOKEN/),
    ]);
  });

  it('production with neither TRUST_PROXY nor PUBLIC_ORIGIN → a warning (not fatal)', async () => {
    const r = await preflight({ ...base, NODE_ENV: 'production' }, migrated);
    expect(r.fatal).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/TRUST_PROXY nor PUBLIC_ORIGIN/)]);
    expect((await preflight({ ...base, NODE_ENV: 'production', TRUST_PROXY: '1' }, migrated)).warnings).toEqual([]);
    expect((await preflight({ ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://pay.example' }, migrated)).warnings).toEqual([]);
  });
});
