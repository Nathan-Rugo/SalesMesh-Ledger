/**
 * Ledger sync end to end (DLT-03, #10) on the real Fabric testnet and Postgres. Run by
 * blockchain/network/scripts/ledger_e2e.sh (`make fabric-ledger-e2e`), which brings the network up,
 * deploys the commission chaincode and sets LEDGER_E2E=1, FABRIC_ORG_DIR and TEST_DATABASE_URL;
 * skipped otherwise. Needs NODE_OPTIONS=--experimental-vm-modules (fabric-gateway loads ESM).
 *
 *  1. escrow → commit → quarantine → release (outbox worker), authorise (claim gate) → B2C (fake) →
 *     PAID → settle: tx id, block number and block hash in Postgres; the hash matches block N+1's
 *     previous_hash; the script then reads the records back from the auditor peer.
 *  2. rows queued while the auditor peer is stopped are retried, and drain in order once the peer
 *     is back and the gateway (client + worker) restarts.
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { applyPayoutResult } from '../../src/repositories/payout.repository';
import { enqueueCommit } from '../../src/repositories/ledger.repository';
import { overrideEscrow } from '../../src/repositories/frozen.repository';
import { securityHoldReceipt } from '../../src/repositories/security.repository';
import { setQuarantineReason } from '../../src/repositories/escrow.repository';
import { ledgerInit } from '../../src/scripts/ledger-init';
import { EscrowService } from '../../src/services/escrow.service';
import { FabricLedger } from '../../src/services/fabric.service';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { PayoutService } from '../../src/services/payout.service';
import { LedgerWorker } from '../../src/workers/ledger.worker';
import { createTestDb, INIT_SQL, seedAgent, type TestDb } from '../integration/helpers';

const RUN = process.env.LEDGER_E2E === '1';
jest.setTimeout(600_000);

(RUN ? describe : describe.skip)('ledger sync e2e (Fabric testnet + Postgres)', () => {
  let db: TestDb;
  let ledger: FabricLedger;
  const metrics = new GatewayMetrics();
  const worker = () => new LedgerWorker({ pool: db.pool, ledger, metrics, enabled: () => true, config: { backoffBaseMs: 1_000, backoffMaxMs: 5_000, auditorPollMs: 1e9 } });

  beforeAll(async () => {
    db = await createTestDb('sm_ledger_e2e');
    await db.pool.query(INIT_SQL);
    ledger = new FabricLedger();
    await ledgerInit(db.pool, ledger, { log: () => undefined });
  });
  afterAll(async () => {
    ledger?.close();
    await db?.drop();
  });

  const outbox = async (escrowId: string) =>
    (await db.pool.query(`SELECT * FROM ledger_outbox WHERE keys @> ARRAY['e:' || $1] ORDER BY outbox_id`, [escrowId])).rows;
  const onLedger = async (fn: 'GetEscrow' | 'GetPayout', id: string) => {
    const r = await ledger.evaluate(fn, id);
    if (!r.ok) throw new Error(`${fn} ${id}: ${r.message}`);
    return JSON.parse(r.result);
  };
  /** Runs `w` until no PENDING row is left (or the time is up). */
  async function drain(w: LedgerWorker, timeoutMs = 180_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await w.runOnce();
      const { rows: [r] } = await db.pool.query(`SELECT count(*)::int AS n FROM ledger_outbox WHERE status = 'PENDING'`);
      if (r.n === 0) return;
      if (Date.now() > end) throw new Error(`outbox not drained: ${r.n} PENDING`);
      await new Promise((res) => setTimeout(res, 1_000));
    }
  }

  async function agent() {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, null, phone);
    const { rows: [u] } = await db.pool.query(`SELECT user_id FROM sales_agents WHERE agent_id = $1`, [agentId]);
    await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [agentId, phone]);
    return { agentId, userId: u.user_id as string };
  }
  async function transaction(agentId: string) {
    const receipt = `E${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, receipt]
    );
    return { transactionId: t.transaction_id as string, receipt };
  }
  /** A matured HELD escrow (model CLEAR) with its COMMIT queued, as processSettlement would after the hold. */
  async function maturedEscrow(agentId: string) {
    const t = await transaction(agentId);
    await db.pool.query(`INSERT INTO verification_events (transaction_id, model_version, decision, model_sha256) VALUES ($1, 'v1.0.0', 'CLEAR', $2)`, [
      t.transactionId,
      'b'.repeat(64),
    ]);
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds)
       VALUES ($1, 150.50, 'HELD', NOW() - INTERVAL '10 minutes', 3600) RETURNING escrow_id`,
      [t.transactionId]
    );
    await enqueueCommit(db.pool, e.escrow_id);
    return { escrowId: e.escrow_id as string, receipt: t.receipt };
  }

  it('escrow → commit → quarantine → release → authorise → settle, with tx / block / hash in Postgres', async () => {
    const a = await agent();
    // E1: settled while ml-engine was down (fail-safe QUARANTINED), re-scored to a model decision, released by an admin.
    const t1 = await transaction(a.agentId);
    const risk: any = {
      transaction_id: t1.transactionId, isolation_score: null, xgb_probability: null, model_version: 'v1.0.0-failsafe', model_sha256: null,
      decision: 'QUARANTINE', triggered_layer: null, layer2_adjudicated: null, reason: 'ml down', latency_ms: 1, evaluated_at: new Date().toISOString(),
      is_fail_safe: true, fail_safe_cause: 'timeout', feature_vector: null,
    };
    await new EscrowService(db.pool).processSettlement(t1.transactionId, risk, '12.34');
    const { rows: [e1] } = await db.pool.query(`SELECT escrow_id FROM escrow_accounts WHERE transaction_id = $1`, [t1.transactionId]);
    const c = await db.pool.connect();
    await setQuarantineReason(c, e1.escrow_id, 'model_decision');
    c.release();
    const { rows: [admin] } = await db.pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Admin', $1, 'MERCHANT_ADMIN') RETURNING user_id`, [
      `2547${crypto.randomInt(10_000_000, 99_999_999)}`,
    ]);
    expect((await overrideEscrow(db.pool, { escrowId: e1.escrow_id, action: 'release', adminId: admin.user_id, note: 'e2e' })).kind).toBe('done');
    // E2: a matured CLEAR escrow, claimed below.
    const e2 = await maturedEscrow(a.agentId);

    const w = worker();
    await drain(w);
    expect((await outbox(e1.escrow_id)).map((r) => [r.op, r.status])).toEqual([['COMMIT', 'DELIVERED'], ['QUARANTINE', 'DELIVERED'], ['RELEASE', 'DELIVERED']]);
    expect(await onLedger('GetEscrow', e1.escrow_id)).toMatchObject({ status: 'HELD', releaseReason: 'admin_release', lockedBy: '' });
    expect(await onLedger('GetEscrow', e2.escrowId)).toMatchObject({ status: 'HELD', grossCents: 15050, agentRef: a.agentId });

    // The claim gate: AuthorisePayout commits before B2C.
    const order: string[] = [];
    const service = new PayoutService({
      db: db.pool,
      b2c: { b2cPayment: async () => (order.push('B2C'), { kind: 'ACCEPTED', conversationId: 'AG_E2E' }), transactionStatus: jest.fn() } as any,
      auth: { confirmPin: async () => ({ kind: 'ok', phoneNumber: '' }) },
      notifier: { send: async () => undefined },
      metrics,
      config: { minAmount: 10, maxAmount: 150_000, statusAfterMs: 3_600_000, statusMaxAttempts: 2, disclosureVersion: '1' },
      ledger,
      ledgerEnabled: () => true,
    });
    const r = (await service.claim(a.userId, '1234', '1', { ip: '127.0.0.1', userAgent: 'e2e', deviceCookie: undefined })) as any;
    expect(r.payout).toMatchObject({ status: 'SENT', amount: 150 });
    expect(order).toEqual(['B2C']);
    const payoutId = r.payout.payoutId;
    expect(await onLedger('GetPayout', payoutId)).toMatchObject({ status: 'AUTHORISED', escrowIds: [e2.escrowId], amount: 150, carryOutCents: 50 });

    await applyPayoutResult(db.pool, { originatorConversationId: payoutId, conversationId: 'AG_E2E', resultCode: '0', receiverName: null, receipt: 'E2E0000001' });
    await drain(w);
    await w.runOnce(); // block hash fill
    expect(await onLedger('GetPayout', payoutId)).toMatchObject({ status: 'PAID' });
    expect(await onLedger('GetEscrow', e2.escrowId)).toMatchObject({ status: 'RELEASED', payoutId });

    // Postgres has the committed tx, its block and the block hash; the hash is block N+1's previous_hash.
    const { rows: [p] } = await db.pool.query(`SELECT ledger_tx_id, ledger_block_number, ledger_block_hash, ledger_authorise_tx_ids FROM payouts WHERE payout_id = $1`, [payoutId]);
    const { rows: [e] } = await db.pool.query(`SELECT ledger_tx_id, ledger_block_number, ledger_block_hash FROM escrow_accounts WHERE escrow_id = $1`, [e2.escrowId]);
    for (const x of [p, e]) {
      expect(x.ledger_tx_id).toMatch(/^[0-9a-f]{64}$/);
      expect(x.ledger_block_hash).toMatch(/^[0-9a-f]{64}$/);
      const n = BigInt(x.ledger_block_number);
      expect((await ledger.blockHeader(n)).hash).toBe(x.ledger_block_hash);
      expect((await ledger.blockHeader(n + 1n)).previousHash).toBe(x.ledger_block_hash);
      expect(await ledger.txCommitted(x.ledger_tx_id)).toBe(true);
    }
    expect(p.ledger_authorise_tx_ids).toContain(p.ledger_tx_id);
    expect(await ledger.txCommitted('0'.repeat(64))).toBe(false);

    if (process.env.LEDGER_E2E_IDS) fs.writeFileSync(process.env.LEDGER_E2E_IDS, `${e1.escrow_id}\n${e2.escrowId}\n${payoutId}\n`);
  });

  it('rows queued while the auditor peer is down drain in order after the peer and the gateway restart', async () => {
    const a = await agent();
    const e3 = await maturedEscrow(a.agentId);
    await securityHoldReceipt(db.pool, e3.receipt); // QUARANTINE security_hold, behind the COMMIT
    execFileSync('docker', ['stop', 'peer0.auditor.salesmesh.test'], { stdio: 'ignore' });
    try {
      const w = worker();
      await w.runOnce(); // MAJORITY needs the auditor: not committed, retried later
      const [commit, quarantine] = await outbox(e3.escrowId);
      expect(commit).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(commit.last_error).toBeTruthy();
      expect(quarantine).toMatchObject({ status: 'PENDING', attempts: 0 });
    } finally {
      execFileSync('docker', ['start', 'peer0.auditor.salesmesh.test'], { stdio: 'ignore' });
    }
    // Gateway restart: a new Fabric connection and a new worker.
    ledger.close();
    ledger = new FabricLedger();
    await drain(worker(), 300_000);
    const [commit, quarantine] = await outbox(e3.escrowId);
    expect([commit.status, quarantine.status]).toEqual(['DELIVERED', 'DELIVERED']);
    expect(BigInt(commit.block_number)).toBeLessThan(BigInt(quarantine.block_number));
    expect(await onLedger('GetEscrow', e3.escrowId)).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'security_hold', securityHold: true });
  });
});
