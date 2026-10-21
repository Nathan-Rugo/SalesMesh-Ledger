/**
 * @file fabric.ts
 * @description Fabric ledger sync settings (DLT-03, #10), see docs/architecture/ledger-sync.md.
 *
 *  - FABRIC_ENABLED=true turns the ledger on: the outbox worker delivers, claims are gated by
 *    AuthorisePayout and filtered to escrows already on the ledger. Default false: outbox rows are
 *    still written (when the HMAC keys are set) and nothing is sent.
 *  - The gateway identity, its TLS pair and the peer TLS root are loaded from the testnet's merchant
 *    org directory (FABRIC_ORG_DIR) on every start: the crypto is regenerated with the network, never copied.
 *  - LEDGER_STATE_HMAC_KEY / LEDGER_CONSENT_HMAC_KEY (>= 32 bytes, with *_KEY_ID) key the on-chain
 *    stateHash and consentDigest. They are separate from PII_HMAC_KEY so they can be shared with the auditor.
 */

import fs from 'fs';
import path from 'path';
import { decodeKey, KEY_ID_RE } from './pii';

export class FabricConfigError extends Error {}

export const fabricEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FABRIC_ENABLED?.trim() === 'true';

export interface LedgerKey {
  id: string;
  key: Buffer;
}
export interface LedgerKeys {
  state: LedgerKey;
  consent: LedgerKey;
}

function ledgerKey(env: NodeJS.ProcessEnv, name: string): LedgerKey {
  const raw = env[name];
  if (!raw) throw new FabricConfigError(`${name} is not set`);
  const id = env[`${name}_ID`]?.trim() || 'k1';
  if (!KEY_ID_RE.test(id)) throw new FabricConfigError(`${name}_ID must look like k1, k2, ...`);
  try {
    return { id, key: decodeKey(raw, name) };
  } catch (error) {
    throw new FabricConfigError((error as Error).message);
  }
}

/** Both HMAC keys; throws FabricConfigError when one is missing, short or badly encoded. */
export function ledgerKeys(env: NodeJS.ProcessEnv = process.env): LedgerKeys {
  const keys = { state: ledgerKey(env, 'LEDGER_STATE_HMAC_KEY'), consent: ledgerKey(env, 'LEDGER_CONSENT_HMAC_KEY') };
  if (keys.state.key.equals(keys.consent.key)) throw new FabricConfigError('LEDGER_STATE_HMAC_KEY and LEDGER_CONSENT_HMAC_KEY must differ');
  if (env.PII_HMAC_KEY && [keys.state, keys.consent].some((k) => k.key.equals(decodeKey(env.PII_HMAC_KEY!, 'PII_HMAC_KEY')))) {
    throw new FabricConfigError('the LEDGER_*_HMAC_KEYs must differ from PII_HMAC_KEY (they are shared with the auditor)');
  }
  return keys;
}

let cachedKeys: { from: string; keys: LedgerKeys | null } | null = null;

/** The keys from process.env, or null when they are not configured (re-read when the env changes). */
export function ledgerKeysOrNull(): LedgerKeys | null {
  const e = process.env;
  const from = `${e.LEDGER_STATE_HMAC_KEY}|${e.LEDGER_STATE_HMAC_KEY_ID}|${e.LEDGER_CONSENT_HMAC_KEY}|${e.LEDGER_CONSENT_HMAC_KEY_ID}|${e.PII_HMAC_KEY}`;
  if (cachedKeys?.from !== from) {
    let keys: LedgerKeys | null = null;
    try {
      keys = ledgerKeys(e);
    } catch {
      keys = null; // preflight reports it
    }
    cachedKeys = { from, keys };
  }
  return cachedKeys.keys;
}

export interface FabricConfig {
  /** host:port of the merchant peer's Gateway service. */
  peerEndpoint: string;
  /** TLS server name: the peer cert's SAN. */
  peerHostAlias: string;
  mspId: string;
  channel: string;
  chaincode: string;
  certPem: Buffer;
  keyPem: Buffer;
  tlsCertPem: Buffer;
  tlsKeyPem: Buffer;
  tlsRootPem: Buffer;
  /** The synchronous AuthorisePayout gate gives up (fail closed) after this long. */
  authoriseTimeoutMs: number;
  keys: LedgerKeys;
}

function posInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const v = env[name]?.trim();
  if (!v) return fallback;
  if (!/^\d{1,9}$/.test(v) || Number(v) <= 0 || Number(v) > max) throw new FabricConfigError(`${name} must be a whole number from 1 to ${max}`);
  return Number(v);
}

function readFile(dir: string, rel: string): Buffer {
  const p = path.join(dir, rel);
  try {
    return fs.readFileSync(p);
  } catch {
    throw new FabricConfigError(`cannot read ${p} (is the Fabric testnet up and FABRIC_ORG_DIR right?)`);
  }
}

/** Everything the client needs; throws FabricConfigError. Called by preflight only when FABRIC_ENABLED=true. */
export function fabricConfig(env: NodeJS.ProcessEnv = process.env): FabricConfig {
  const domain = env.FABRIC_ORG_DOMAIN?.trim() || 'merchant.salesmesh.test';
  const dir = env.FABRIC_ORG_DIR?.trim();
  if (!dir) throw new FabricConfigError('FABRIC_ORG_DIR is not set (blockchain/network/organizations/peerOrganizations/merchant.salesmesh.test)');
  const user = `users/${env.FABRIC_USER?.trim() || 'gateway'}@${domain}`;
  const peer = `peers/peer0.${domain}`;
  return {
    peerEndpoint: env.FABRIC_PEER_ENDPOINT?.trim() || '127.0.0.1:7051',
    peerHostAlias: env.FABRIC_PEER_HOST_ALIAS?.trim() || `peer0.${domain}`,
    mspId: env.FABRIC_MSP_ID?.trim() || 'MerchantMSP',
    channel: env.FABRIC_CHANNEL?.trim() || 'commissionchannel',
    chaincode: env.FABRIC_CHAINCODE?.trim() || 'commission',
    certPem: readFile(dir, `${user}/msp/signcerts/cert.pem`),
    keyPem: readFile(dir, `${user}/msp/keystore/key.pem`),
    tlsCertPem: readFile(dir, `${user}/tls/client.crt`),
    tlsKeyPem: readFile(dir, `${user}/tls/client.key`),
    tlsRootPem: readFile(dir, `${peer}/tls/ca.crt`),
    authoriseTimeoutMs: authoriseTimeoutMs(env),
    keys: ledgerKeys(env),
  };
}

/** FABRIC_AUTHORISE_TIMEOUT_MS (default 10 s): how long the claim gate retries AuthorisePayout. */
export const authoriseTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => posInt(env, 'FABRIC_AUTHORISE_TIMEOUT_MS', 10_000, 60_000);

export interface LedgerWorkerConfig {
  intervalMs: number;
  batchSize: number;
  leaseMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How often escrows mirrored as auditor_hold are re-read from the ledger. */
  auditorPollMs: number;
}

export function ledgerWorkerConfig(env: NodeJS.ProcessEnv = process.env): LedgerWorkerConfig {
  const n = (name: string, fallback: number, min: number) => {
    const v = parseInt(env[name] ?? '', 10);
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  const backoffBaseMs = n('LEDGER_BACKOFF_BASE_MS', 2_000, 10);
  return {
    intervalMs: n('LEDGER_WORKER_INTERVAL_MS', 2_000, 100),
    batchSize: n('LEDGER_WORKER_BATCH', 20, 1),
    leaseMs: n('LEDGER_WORKER_LEASE_MS', 120_000, 30_000),
    backoffBaseMs,
    backoffMaxMs: Math.max(n('LEDGER_BACKOFF_MAX_MS', 300_000, 10), backoffBaseMs),
    auditorPollMs: n('LEDGER_AUDITOR_POLL_MS', 60_000, 100),
  };
}
