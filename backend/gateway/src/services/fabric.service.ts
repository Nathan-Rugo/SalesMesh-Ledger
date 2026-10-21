/**
 * @file fabric.service.ts
 * @description The gateway's Fabric client (DLT-03, #10): `@hyperledger/fabric-gateway` over gRPC
 * mTLS to the merchant peer, as `gateway@merchant` (X.509). The peer's Gateway service collects the
 * auditor endorsement through discovery. One attempt per call, never throws for a chaincode or
 * network failure: the caller retries (outbox worker, AuthorisePayout gate). Block hashes come from
 * qscc GetBlockByNumber; a late commit is detected with qscc GetTransactionByID.
 */

import crypto from 'crypto';
import * as grpc from '@grpc/grpc-js';
import type { Contract, Gateway } from '@hyperledger/fabric-gateway';
import { common, peer } from '@hyperledger/fabric-protos';
import { fabricConfig, type FabricConfig } from '../config/fabric';
import { blockHeaderHash, chaincodeCode, type LedgerCode } from '../domain/ledger';

export type SubmitOutcome =
  | { ok: true; txId: string; blockNumber: bigint; result: string }
  /** `code`: a #9 refusal (terminal); null: infrastructure, retry with the same request. */
  | { ok: false; code: LedgerCode | null; message: string };

export type EvaluateOutcome = { ok: true; result: string } | { ok: false; code: LedgerCode | null; message: string };

export interface BlockHeader {
  number: bigint;
  previousHash: string;
  dataHash: string;
  hash: string;
}

/** What the worker and the claim gate need; tests pass a fake. */
export interface LedgerClient {
  /** One attempt. `onTxId` runs after endorsement, before the tx goes to the orderer. */
  submit(fn: string, request: string, o?: { deadline?: number; onTxId?: (txId: string) => Promise<void> }): Promise<SubmitOutcome>;
  evaluate(fn: string, ...args: string[]): Promise<EvaluateOutcome>;
  /** Throws on failure. */
  blockHeader(n: bigint): Promise<BlockHeader>;
  /** True when the tx is in the ledger and VALID; false when the ledger has no such tx. Throws when it cannot tell. */
  txCommitted(txId: string): Promise<boolean>;
  close(): void;
}

const MS = { evaluate: 5_000, endorse: 15_000, submit: 5_000, commitStatus: 60_000 };
type FabricGateway = typeof import('@hyperledger/fabric-gateway');
/**
 * Loaded on first use: it pulls in ESM-only @noble/curves (Node >= 20.19 / 22.12 require(esm)), so a
 * gateway with the ledger off, and the unit tests (jest cannot require ESM without
 * --experimental-vm-modules), never load it.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fabricGateway = (): FabricGateway => require('@hyperledger/fabric-gateway');
const statusName = (code: number): string => Object.entries(fabricGateway().StatusCode).find(([, v]) => v === code)?.[0] ?? String(code);
const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');
const message = (e: unknown): string => {
  const err = e as { message?: string; details?: Array<{ message?: string }> };
  const details = Array.isArray(err?.details) ? err.details.map((d) => d?.message).filter(Boolean) : [];
  return [err?.message ?? String(e), ...details].join(' | ').slice(0, 1000);
};

export class FabricLedger implements LedgerClient {
  private gateway: Gateway | null = null;
  private client: grpc.Client | null = null;

  constructor(private readonly cfg: () => FabricConfig = () => fabricConfig()) {}

  private conn(): { contract: Contract; qscc: Contract; channel: string } {
    const cfg = this.cfg();
    if (!this.gateway) {
      const tls = grpc.credentials.createSsl(cfg.tlsRootPem, cfg.tlsKeyPem, cfg.tlsCertPem);
      this.client = new grpc.Client(cfg.peerEndpoint, tls, { 'grpc.ssl_target_name_override': cfg.peerHostAlias });
      const { connect, hash, signers } = fabricGateway();
      this.gateway = connect({
        client: this.client,
        identity: { mspId: cfg.mspId, credentials: cfg.certPem },
        signer: signers.newPrivateKeySigner(crypto.createPrivateKey(cfg.keyPem)),
        hash: hash.sha256,
        // mTLS: the peer binds the proposal to our TLS client certificate.
        tlsClientCertificateHash: crypto.createHash('sha256').update(new crypto.X509Certificate(cfg.tlsCertPem).raw).digest(),
        evaluateOptions: () => ({ deadline: Date.now() + MS.evaluate }),
        endorseOptions: () => ({ deadline: Date.now() + MS.endorse }),
        submitOptions: () => ({ deadline: Date.now() + MS.submit }),
        commitStatusOptions: () => ({ deadline: Date.now() + MS.commitStatus }),
      });
    }
    const network = this.gateway.getNetwork(cfg.channel);
    return { contract: network.getContract(cfg.chaincode), qscc: network.getContract('qscc'), channel: cfg.channel };
  }

  async submit(fn: string, request: string, o: { deadline?: number; onTxId?: (txId: string) => Promise<void> } = {}): Promise<SubmitOutcome> {
    const opts = (ms: number) => ({ deadline: Math.min(Date.now() + ms, o.deadline ?? Infinity) });
    try {
      const proposal = this.conn().contract.newProposal(fn, { arguments: [request] });
      const tx = await proposal.endorse(opts(MS.endorse));
      await o.onTxId?.(tx.getTransactionId());
      const commit = await tx.submit(opts(MS.submit));
      const status = await commit.getStatus(opts(MS.commitStatus));
      if (!status.successful) return { ok: false, code: null, message: `commit ${statusName(status.code)}` };
      return { ok: true, txId: status.transactionId, blockNumber: status.blockNumber, result: text(tx.getResult()) };
    } catch (error) {
      return { ok: false, code: chaincodeCode(error), message: message(error) };
    }
  }

  async evaluate(fn: string, ...args: string[]): Promise<EvaluateOutcome> {
    try {
      return { ok: true, result: text(await this.conn().contract.evaluateTransaction(fn, ...args)) };
    } catch (error) {
      return { ok: false, code: chaincodeCode(error), message: message(error) };
    }
  }

  async blockHeader(n: bigint): Promise<BlockHeader> {
    const { qscc, channel } = this.conn();
    const h = common.Block.deserializeBinary(await qscc.evaluateTransaction('GetBlockByNumber', channel, n.toString())).getHeader();
    if (!h) throw new Error(`block ${n} has no header`);
    const prev = h.getPreviousHash_asU8();
    const data = h.getDataHash_asU8();
    return {
      number: BigInt(h.getNumber()),
      previousHash: Buffer.from(prev).toString('hex'),
      dataHash: Buffer.from(data).toString('hex'),
      hash: blockHeaderHash(BigInt(h.getNumber()), prev, data),
    };
  }

  async txCommitted(txId: string): Promise<boolean> {
    const { qscc, channel } = this.conn();
    try {
      const pt = peer.ProcessedTransaction.deserializeBinary(await qscc.evaluateTransaction('GetTransactionByID', channel, txId));
      return pt.getValidationcode() === 0; // an invalidated tx (MVCC, policy) changed nothing
    } catch (error) {
      if (/no such transaction ID|not found/i.test(message(error))) return false;
      throw error;
    }
  }

  close(): void {
    this.gateway?.close();
    this.client?.close();
    this.gateway = null;
    this.client = null;
  }
}

let shared: FabricLedger | null = null;
/** The process-wide client (lazy: nothing connects until the first call with FABRIC_ENABLED=true). */
export const fabricLedger = (): FabricLedger => (shared ??= new FabricLedger());
