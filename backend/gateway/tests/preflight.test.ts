/**
 * @file preflight.test.ts
 * @description The startup refusal gates (spec gh-5), via the side-effect-free preflight():
 * JWT keys, Daraja config when STK is enabled, the schema version, plus the proxy warning.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { preflight, REQUIRED_MIGRATION } from '../src/index';

const migrated: any = { query: jest.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })) };
const only001: any = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  PII_HMAC_KEY: process.env.PII_HMAC_KEY,
  JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY,
  JWT_KEY_ID: 'test-k1',
  MPESA_CALLBACK_TOKEN: 'cbtok123',
  LEDGER_STATE_HMAC_KEY: process.env.LEDGER_STATE_HMAC_KEY,
  LEDGER_CONSENT_HMAC_KEY: process.env.LEDGER_CONSENT_HMAC_KEY,
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

  it('RECONCILE_ENABLED without the Daraja credentials → fatal (the STK Query sweep needs them)', async () => {
    expect((await preflight({ ...base, RECONCILE_ENABLED: 'true' }, migrated)).fatal).toEqual([expect.stringMatching(/missing DARAJA_CONSUMER_KEY/)]);
    expect((await preflight({ ...base, ...daraja, STK_ENABLED: 'false', RECONCILE_ENABLED: 'true' }, migrated)).fatal).toEqual([]);
  });

  it('a database at migration 001 only (or unreachable) → fatal', async () => {
    expect((await preflight(base, only001)).fatal).toEqual([expect.stringMatching(/not migrated.*011_ledger_sync/)]);
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

  it('an invalid trust parameter (spec gh-23) → fatal', async () => {
    expect((await preflight({ ...base, TRUST_TX_WEIGHT: '0' }, migrated)).fatal).toEqual([expect.stringMatching(/TRUST_TX_WEIGHT/)]);
  });

  describe('Fabric ledger (DLT-03)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fabric-'));
    for (const rel of [
      'users/gateway@merchant.salesmesh.test/msp/signcerts/cert.pem',
      'users/gateway@merchant.salesmesh.test/msp/keystore/key.pem',
      'users/gateway@merchant.salesmesh.test/tls/client.crt',
      'users/gateway@merchant.salesmesh.test/tls/client.key',
      'peers/peer0.merchant.salesmesh.test/tls/ca.crt',
    ]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'pem');
    }
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const clock = (offsetMs: number): any => ({ query: jest.fn(async () => ({ rows: [{ now: new Date(Date.now() + offsetMs) }], rowCount: 1 })) });
    const on: NodeJS.ProcessEnv = { ...base, FABRIC_ENABLED: 'true', FABRIC_ORG_DIR: dir };

    it('disabled: bad Fabric config is not fatal; missing HMAC keys only warn (no outbox rows)', async () => {
      const r = await preflight({ ...base, LEDGER_STATE_HMAC_KEY: undefined, FABRIC_ORG_DIR: '/nope' }, migrated);
      expect(r.fatal).toEqual([]);
      expect(r.warnings).toEqual([expect.stringMatching(/LEDGER_STATE_HMAC_KEY is not set: no ledger outbox rows/)]);
    });

    it('enabled: a complete configuration and synced clocks pass', async () => {
      expect(await preflight(on, clock(5_000))).toEqual({ fatal: [], warnings: [] });
    });

    it('enabled: missing org dir, unreadable crypto, missing / shared / short keys are fatal', async () => {
      expect((await preflight({ ...on, FABRIC_ORG_DIR: '' }, clock(0))).fatal).toEqual([expect.stringMatching(/FABRIC_ORG_DIR is not set/)]);
      expect((await preflight({ ...on, FABRIC_ORG_DIR: path.join(dir, 'missing') }, clock(0))).fatal).toEqual([expect.stringMatching(/cannot read .*cert\.pem/)]);
      expect((await preflight({ ...on, LEDGER_CONSENT_HMAC_KEY: undefined }, clock(0))).fatal).toEqual([expect.stringMatching(/LEDGER_CONSENT_HMAC_KEY is not set/)]);
      expect((await preflight({ ...on, LEDGER_CONSENT_HMAC_KEY: on.LEDGER_STATE_HMAC_KEY }, clock(0))).fatal).toEqual([expect.stringMatching(/must differ/)]);
      expect((await preflight({ ...on, LEDGER_STATE_HMAC_KEY: on.PII_HMAC_KEY }, clock(0))).fatal).toEqual([expect.stringMatching(/differ from PII_HMAC_KEY/)]);
      expect((await preflight({ ...on, LEDGER_STATE_HMAC_KEY: 'short' }, clock(0))).fatal).toEqual([expect.stringMatching(/at least 32 bytes/)]);
      expect((await preflight({ ...on, FABRIC_AUTHORISE_TIMEOUT_MS: '0' }, clock(0))).fatal).toEqual([expect.stringMatching(/FABRIC_AUTHORISE_TIMEOUT_MS/)]);
    });

    it('enabled: Postgres and host clocks more than 60 s apart → fatal', async () => {
      expect((await preflight(on, clock(-61_000))).fatal).toEqual([expect.stringMatching(/clocks? .*differ by 61 s/)]);
      expect((await preflight(on, clock(90_000))).fatal).toEqual([expect.stringMatching(/differ by 90 s/)]);
    });
  });

  it('production with neither TRUST_PROXY nor PUBLIC_ORIGIN → a warning (not fatal)', async () => {
    const r = await preflight({ ...base, NODE_ENV: 'production' }, migrated);
    expect(r.fatal).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/TRUST_PROXY nor PUBLIC_ORIGIN/)]);
    expect((await preflight({ ...base, NODE_ENV: 'production', TRUST_PROXY: '1' }, migrated)).warnings).toEqual([]);
    expect((await preflight({ ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://pay.example' }, migrated)).warnings).toEqual([]);
  });
});
