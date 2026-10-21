/**
 * Fabric ledger sync against real Postgres (DLT-03, #10), with a fake Fabric client: one test per
 * I/O-matrix row. Enqueue hooks write their row in the state change's transaction; the worker keeps
 * per-key order, retries infrastructure failures, parks terminal ones (DEAD, keys blocked), supersedes
 * on the auditor's lock and mirrors it; the AuthorisePayout gate commits before B2C or rolls the claim
 * back (fail closed), with the late-authorise Settle check.
 */

import crypto from 'crypto';
import { PayoutController } from '../../src/controllers/payout.controller';
import { hmacHex, statePreimageV1 } from '../../src/domain/ledger';
import { backfillCommits, ledgerStats, requeueDead } from '../../src/repositories/ledger.repository';
import { applyPayoutResult, claimableEscrows, dueReminders, pendingAccruals, ROLLBACK_SETTLE_DELAY_MS } from '../../src/repositories/payout.repository';
import * as canary from '../../src/services/canary.service';
import { overrideEscrow } from '../../src/repositories/frozen.repository';
import { securityHoldReceipt } from '../../src/repositories/security.repository';
import { promoteToHeld, setQuarantineReason } from '../../src/repositories/escrow.repository';
import { EscrowService } from '../../src/services/escrow.service';
import type { EvaluateOutcome, LedgerClient, SubmitOutcome } from '../../src/services/fabric.service';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { PayoutService } from '../../src/services/payout.service';
import { LedgerWorker } from '../../src/workers/ledger.worker';
import { createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

type Handler = (fn: string, request: any, txId: string) => SubmitOutcome;
const ok = (txId: string, block = 7n, result = '{}'): SubmitOutcome => ({ ok: true, txId, blockNumber: block, result });
const TOKEN = '11111111-1111-4111-8111-111111111111';
const infra = (): SubmitOutcome => ({ ok: false, code: null, message: '14 UNAVAILABLE: peer down' });

class FakeLedger implements LedgerClient {
  calls: Array<{ fn: string; request: any }> = [];
  handler: Handler = (_fn, _r, txId) => ok(txId);
  /** GetEscrow answers by escrow id. */
  escrows = new Map<string, Record<string, unknown>>();
  committed = new Set<string>();
  private n = 0;
  async submit(fn: string, request: string, o: { onTxId?: (txId: string) => Promise<void> } = {}): Promise<SubmitOutcome> {
    const txId = `tx${++this.n}`;
    this.calls.push({ fn, request: JSON.parse(request) });
    await o.onTxId?.(txId);
    return this.handler(fn, JSON.parse(request), txId);
  }
  async evaluate(_fn: string, id: string): Promise<EvaluateOutcome> {
    const e = this.escrows.get(id);
    return e ? { ok: true, result: JSON.stringify(e) } : { ok: false, code: 'NOT_FOUND', message: `NOT_FOUND: escrow ${id}` };
  }
  async blockHeader(n: bigint) {
    return { number: n, previousHash: '', dataHash: '', hash: n.toString(16).padStart(64, '0') };
  }
  async txCommitted(txId: string) {
    return this.committed.has(txId);
  }
  close() {}
}

describeDb('Fabric ledger sync (real Postgres, fake Fabric)', () => {
  let db: TestDb;
  let fake: FakeLedger;
  let worker: LedgerWorker;
  let metrics: GatewayMetrics;
  let b2c: { b2cPayment: jest.Mock; transactionStatus: jest.Mock };
  let sent: string[];
  let service: PayoutService;

  beforeAll(async () => {
    db = await createTestDb('sm_ledger');
    await db.pool.query(INIT_SQL);
  });
  afterAll(async () => {
    await db?.drop();
  });
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['info', 'warn', 'error'] as const).map((l) => jest.spyOn(console, l).mockImplementation(() => undefined));
    fake = new FakeLedger();
    metrics = new GatewayMetrics();
    worker = new LedgerWorker({ pool: db.pool, ledger: fake, metrics, enabled: () => true, config: { backoffBaseMs: 10, backoffMaxMs: 50, auditorPollMs: 0 } });
    b2c = { b2cPayment: jest.fn(async () => ({ kind: 'ACCEPTED', conversationId: 'AG_1' })), transactionStatus: jest.fn() };
    sent = [];
    service = new PayoutService({
      db: db.pool,
      b2c: b2c as any,
      auth: { confirmPin: async () => ({ kind: 'ok', phoneNumber: '' }) },
      notifier: { send: async (to: string) => void sent.push(to) },
      metrics,
      config: { minAmount: 10, maxAmount: 150_000, statusAfterMs: 3_600_000, statusMaxAttempts: 2, disclosureVersion: '1' },
      ledger: fake,
      ledgerEnabled: () => true,
      authoriseTimeoutMs: 400,
    });
  });
  afterEach(async () => {
    await service.settled();
    logs.forEach((s) => s.mockRestore());
  });

  const client = { ip: '127.0.0.1', userAgent: 'jest', deviceCookie: undefined };

  /** An agent with an ACTIVE destination. */
  async function agent() {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, null, phone);
    const { rows: [u] } = await db.pool.query(`SELECT user_id FROM sales_agents WHERE agent_id = $1`, [agentId]);
    await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [agentId, phone]);
    return { agentId, userId: u.user_id as string, phone };
  }

  /** A settled payment with an INITIAL verification event and its escrow, plus its queued ledger COMMIT. */
  async function escrow(agentId: string, o: { gross?: string; dueMinutes?: number; status?: string; reason?: string | null; decision?: string; failSafe?: boolean } = {}) {
    const receipt = `R${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, receipt]
    );
    await db.pool.query(
      `INSERT INTO verification_events (transaction_id, model_version, decision, is_fail_safe, model_sha256) VALUES ($1, 'v1.0.0', $2, $3, $4)`,
      [t.transaction_id, o.decision ?? 'CLEAR', o.failSafe ?? false, 'b'.repeat(64)]
    );
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds, quarantine_reason)
       VALUES ($1, $2::numeric, $3, NOW() + make_interval(mins => $4::int), 3600, $5) RETURNING escrow_id`,
      [t.transaction_id, o.gross ?? '50.00', o.status ?? 'HELD', o.dueMinutes ?? -10, o.reason ?? null]
    );
    const { enqueueCommit } = await import('../../src/repositories/ledger.repository');
    await enqueueCommit(db.pool, e.escrow_id);
    return { escrowId: e.escrow_id as string, receipt, transactionId: t.transaction_id as string };
  }

  const outbox = async (where = 'TRUE', params: unknown[] = []) =>
    (await db.pool.query(`SELECT * FROM ledger_outbox WHERE ${where} ORDER BY outbox_id`, params)).rows;
  const rowsFor = (escrowId: string) => outbox(`keys @> ARRAY['e:' || $1]`, [escrowId]);
  const escrowRow = async (id: string) => (await db.pool.query(`SELECT * FROM escrow_accounts WHERE escrow_id = $1`, [id])).rows[0];
  const payoutRow = async (id: string) => (await db.pool.query(`SELECT * FROM payouts WHERE payout_id = $1`, [id])).rows[0];
  /** Runs the worker until nothing is leased. */
  async function drain() {
    for (let i = 0; i < 20 && (await worker.runOnce()) > 0; i++);
  }

  it('settle → COMMIT row in the same transaction (keyed state hash stored); the worker commits it; block hash filled', async () => {
    const a = await agent();
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [a.agentId, `S${crypto.randomBytes(5).toString('hex').toUpperCase()}`]
    );
    const risk: any = {
      transaction_id: t.transaction_id, isolation_score: null, xgb_probability: null, model_version: 'v1.0.0-failsafe', model_sha256: null,
      decision: 'QUARANTINE', triggered_layer: null, layer2_adjudicated: null, reason: 'ml down', latency_ms: 1, evaluated_at: new Date().toISOString(),
      is_fail_safe: true, fail_safe_cause: 'timeout', feature_vector: null,
    };
    const r = await new EscrowService(db.pool).processSettlement(t.transaction_id, risk, '12.34');
    expect(r).toEqual({ escrowStatus: 'QUARANTINED', created: true });
    const { rows: [e] } = await db.pool.query(`SELECT * FROM escrow_accounts WHERE transaction_id = $1`, [t.transaction_id]);
    const [row] = await rowsFor(e.escrow_id);
    expect(row).toMatchObject({ op: 'COMMIT', status: 'PENDING', keys: [`e:${e.escrow_id}`] });
    const req = JSON.parse(row.request);
    expect(req).toMatchObject({ escrowId: e.escrow_id, agentRef: a.agentId, modelVersion: 'v1.0.0-failsafe', modelSha256: '', decision: 'QUARANTINE', failSafe: true, quarantineReason: 'fail_safe', grossCents: 1234 });
    expect(req.releaseDueAt).toBe(new Date(e.release_due_at).toISOString());
    // The stored state hash is the HMAC of preimage v1 under the state key; its key id is stored with it.
    const { rows: [v] } = await db.pool.query(`SELECT verification_id FROM verification_events WHERE transaction_id = $1`, [t.transaction_id]);
    const { rows: [tx] } = await db.pool.query(`SELECT mpesa_receipt_id, raw_payload_hash FROM transactions WHERE transaction_id = $1`, [t.transaction_id]);
    const pre = statePreimageV1({
      escrowId: e.escrow_id, transactionId: t.transaction_id, agentId: a.agentId, mpesaReceiptId: tx.mpesa_receipt_id, rawPayloadHash: tx.raw_payload_hash,
      amountCents: 100000, grossCents: 1234, verificationId: v.verification_id, modelVersion: 'v1.0.0-failsafe', modelSha256: null, decision: 'QUARANTINE',
      failSafe: true, quarantineReason: 'fail_safe', releaseDueAt: new Date(e.release_due_at),
    });
    expect(e.ledger_state_hash).toBe(hmacHex(Buffer.from(process.env.LEDGER_STATE_HMAC_KEY!), pre));
    expect(req.stateHash).toBe(e.ledger_state_hash);
    expect(e.ledger_state_key_id).toBe('k1');

    fake.handler = (_fn, _r, txId) => ok(txId, 42n);
    await drain();
    const [done] = await rowsFor(e.escrow_id);
    expect(done).toMatchObject({ status: 'DELIVERED', block_number: '42', block_hash: (42).toString(16).padStart(64, '0') });
    expect(fake.calls.filter((c) => c.fn === 'CommitTransaction').at(-1)!.request).toEqual(req); // exactly the snapshot
    expect(await escrowRow(e.escrow_id)).toMatchObject({ ledger_tx_id: done.tx_id, ledger_block_number: '42', ledger_block_hash: done.block_hash });
  });

  it('rescore new reason / admin release / security hold enqueue QUARANTINE / RELEASE / QUARANTINE security_hold; CLAIMED gets none', async () => {
    const a = await agent();
    const q = await escrow(a.agentId, { status: 'QUARANTINED', reason: 'fail_safe', failSafe: true, decision: 'QUARANTINE', dueMinutes: 4000 });
    const { pool } = db;
    const c = await pool.connect();
    await setQuarantineReason(c, q.escrowId, 'model_decision');
    await setQuarantineReason(c, q.escrowId, 'model_decision'); // unchanged: nothing new for the ledger
    c.release();
    const { rows: [admin] } = await pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Admin', $1, 'MERCHANT_ADMIN') RETURNING user_id`, [
      `2547${crypto.randomInt(10_000_000, 99_999_999)}`,
    ]);
    expect((await overrideEscrow(pool, { escrowId: q.escrowId, action: 'release', adminId: admin.user_id, note: 'ok' })).kind).toBe('done');
    const ops = (await rowsFor(q.escrowId)).map((r) => [r.op, JSON.parse(r.request).reason ?? null]);
    expect(ops).toEqual([['COMMIT', null], ['QUARANTINE', 'model_decision'], ['RELEASE', 'admin_release']]);
    const rel = (await rowsFor(q.escrowId))[2];
    expect(JSON.parse(rel.request).requestId).toBe(rel.request_id);
    expect(new Date(JSON.parse(rel.request).releaseDueAt).getTime()).toBe(Math.floor(new Date((await escrowRow(q.escrowId)).release_due_at).getTime()));

    const h = await escrow(a.agentId);
    await securityHoldReceipt(pool, h.receipt);
    expect((await rowsFor(h.escrowId)).map((r) => [r.op, JSON.parse(r.request).reason ?? null])).toEqual([['COMMIT', null], ['QUARANTINE', 'security_hold']]);

    const claimed = await escrow(a.agentId);
    const { rows: [p] } = await pool.query(
      `INSERT INTO payouts (payout_id, agent_id, destination_id, msisdn, amount, gross_cents, carry_in_cents, carry_out_cents, disclosure_version, consent_hash, accepted_at)
       SELECT gen_random_uuid(), $1, destination_id, msisdn, 50, 5000, 0, 0, '1', $2, NOW() FROM payout_destinations WHERE agent_id = $1 RETURNING payout_id`,
      [a.agentId, 'c'.repeat(64)]
    );
    await pool.query(`UPDATE escrow_accounts SET escrow_status = 'CLAIMED', payout_id = $2 WHERE escrow_id = $1`, [claimed.escrowId, p.payout_id]);
    await securityHoldReceipt(pool, claimed.receipt);
    expect((await rowsFor(claimed.escrowId)).map((r) => r.op)).toEqual(['COMMIT']);
  });

  it('rescore CLEAR promote → RELEASE rescore_clear with the new due date', async () => {
    const a = await agent();
    const q = await escrow(a.agentId, { status: 'QUARANTINED', reason: 'fail_safe', failSafe: true, decision: 'QUARANTINE', dueMinutes: 4000 });
    await db.pool.query(`UPDATE escrow_accounts SET rescore_claim_token = $2, rescore_claimed_at = NOW() WHERE escrow_id = $1`, [q.escrowId, TOKEN]);
    expect(await promoteToHeld(db.pool, q.escrowId, TOKEN, 3600)).toBe(true);
    const [, rel] = await rowsFor(q.escrowId);
    const req = JSON.parse(rel.request);
    expect(req).toMatchObject({ escrowId: q.escrowId, reason: 'rescore_clear', requestId: rel.request_id });
    expect(req.releaseDueAt).toBe(new Date((await escrowRow(q.escrowId)).release_due_at).toISOString());
    expect(await promoteToHeld(db.pool, q.escrowId, TOKEN, 3600)).toBe(false); // not QUARANTINED any more: nothing new queued
    expect(await rowsFor(q.escrowId)).toHaveLength(2);
  });

  it('per-key order: a later row waits for an earlier undelivered one; a peer outage is retried with backoff and stops the batch', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { status: 'QUARANTINED', reason: 'fail_safe', failSafe: true, decision: 'QUARANTINE', dueMinutes: 4000 });
    const e2 = await escrow(a.agentId);
    const c = await db.pool.connect();
    await setQuarantineReason(c, e1.escrowId, 'model_decision');
    c.release();
    let down = true;
    fake.handler = (fn, r, txId) => (down && r.escrowId === e1.escrowId ? infra() : ok(txId));
    await worker.runOnce();
    // e1's COMMIT failed (retried later); its QUARANTINE was not sent (same key). The outage stops the
    // batch: e2's COMMIT (another key, leased after it) is not submitted and its lease is given back.
    expect(fake.calls.filter((x) => x.request.escrowId === e1.escrowId || x.request.escrowId === e2.escrowId).map((x) => [x.fn, x.request.escrowId])).toEqual([
      ['CommitTransaction', e1.escrowId],
    ]);
    expect((await rowsFor(e2.escrowId))[0]).toMatchObject({ status: 'PENDING', attempts: 0, claimed_at: null, claim_token: null });
    const [commit, quarantine] = await rowsFor(e1.escrowId);
    expect(commit).toMatchObject({ status: 'PENDING', attempts: 1, last_error: expect.stringMatching(/UNAVAILABLE/) });
    expect(new Date(commit.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(quarantine).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(metrics.ledger.retried).toBe(1);
    down = false;
    await new Promise((r) => setTimeout(r, 30));
    await drain();
    const after = await rowsFor(e1.escrowId);
    expect(after.map((r) => r.status)).toEqual(['DELIVERED', 'DELIVERED']);
    expect((await rowsFor(e2.escrowId))[0].status).toBe('DELIVERED');
    const order = fake.calls.filter((x) => x.request.escrowId === e1.escrowId).map((x) => x.fn);
    expect(order).toEqual(['CommitTransaction', 'CommitTransaction', 'QuarantineEscrow']);
  });

  it('terminal error → DEAD, logged, keys stay blocked, counted in health; ledger:requeue re-arms it', async () => {
    const a = await agent();
    const e = await escrow(a.agentId);
    await securityHoldReceipt(db.pool, e.receipt);
    fake.handler = (fn, _r, txId) => (fn === 'CommitTransaction' ? { ok: false, code: 'INVALID_ARGUMENT', message: 'INVALID_ARGUMENT: grossCents' } : ok(txId));
    const before = (await ledgerStats(db.pool)).dead;
    await drain();
    const [commit, quarantine] = await rowsFor(e.escrowId);
    expect(commit).toMatchObject({ status: 'DEAD', last_error: 'INVALID_ARGUMENT: grossCents' });
    expect(quarantine.status).toBe('PENDING'); // blocked behind the dead COMMIT
    expect(fake.calls.some((x) => x.fn === 'QuarantineEscrow' && x.request.escrowId === e.escrowId)).toBe(false);
    expect((await ledgerStats(db.pool)).dead).toBe(before + 1);
    expect(metrics.ledger.dead).toBe(1);
    // ...and not claimable: the ledger does not have it.
    expect((await claimableEscrows(db.pool, a.agentId, false, true)).map((x) => x.escrowId)).not.toContain(e.escrowId);

    expect(await requeueDead(db.pool, 'abc')).toBeNull();
    expect(await requeueDead(db.pool, String(commit.outbox_id))).toEqual({ op: 'COMMIT', lastError: 'INVALID_ARGUMENT: grossCents' });
    expect(await requeueDead(db.pool, String(commit.outbox_id))).toBeNull(); // not DEAD any more
    fake.handler = (_fn, _r, txId) => ok(txId);
    await drain();
    expect((await rowsFor(e.escrowId)).map((r) => r.status)).toEqual(['DELIVERED', 'DELIVERED']);
  });

  it('Release refused LOCKED_BY_AUDITOR, or a Quarantine no-op under the auditor lock → SUPERSEDED, escrow mirrored auditor_hold', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, { status: 'QUARANTINED', reason: 'model_decision', decision: 'QUARANTINE', dueMinutes: 4000 });
    const { rows: [admin] } = await db.pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Admin', $1, 'MERCHANT_ADMIN') RETURNING user_id`, [
      `2547${crypto.randomInt(10_000_000, 99_999_999)}`,
    ]);
    await overrideEscrow(db.pool, { escrowId: e.escrowId, action: 'release', adminId: admin.user_id, note: 'ok' });
    fake.handler = (fn, _r, txId) =>
      fn === 'ReleaseEscrow' ? { ok: false, code: 'LOCKED_BY_AUDITOR', message: `LOCKED_BY_AUDITOR: escrow ${e.escrowId} can be released only by the auditor` } : ok(txId);
    await drain();
    expect((await rowsFor(e.escrowId)).map((r) => r.status)).toEqual(['DELIVERED', 'SUPERSEDED']);
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'auditor_hold', security_hold: true });
    expect(await overrideEscrow(db.pool, { escrowId: e.escrowId, action: 'release', adminId: admin.user_id, note: 'x' })).toEqual({ kind: 'security_hold' });

    const q = await escrow(a.agentId, { status: 'QUARANTINED', reason: 'fail_safe', failSafe: true, decision: 'QUARANTINE', dueMinutes: 4000 });
    const c = await db.pool.connect();
    await setQuarantineReason(c, q.escrowId, 'model_decision');
    c.release();
    fake.handler = (fn, r, txId) => (fn === 'QuarantineEscrow' ? ok(txId, 7n, JSON.stringify({ escrowId: r.escrowId, status: 'QUARANTINED', lockedBy: 'auditor' })) : ok(txId));
    await drain();
    expect((await rowsFor(q.escrowId)).map((r) => r.status)).toEqual(['DELIVERED', 'SUPERSEDED']);
    expect(await escrowRow(q.escrowId)).toMatchObject({ quarantine_reason: 'auditor_hold', security_hold: true });
    expect(metrics.ledger.superseded).toBe(2);

    // The auditor releases it on the ledger: the poll mirrors HELD, the ledger's due date, security_hold cleared.
    const due = '2026-01-01T00:00:00.000Z';
    fake.escrows.set(q.escrowId, { status: 'HELD', releaseDueAt: due });
    fake.escrows.set(e.escrowId, { status: 'QUARANTINED', lockedBy: 'auditor' });
    await worker.pollAuditorHolds();
    expect(await escrowRow(q.escrowId)).toMatchObject({ escrow_status: 'HELD', quarantine_reason: null, security_hold: false, release_due_at: new Date(due) });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'auditor_hold' });
  });

  it('claim, ledger up: AuthorisePayout commits before B2C (canary HEALTHY, keyed consent digest); PAID queues Settle on p: and every e:', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { gross: '30.00' });
    const e2 = await escrow(a.agentId, { gross: '20.50' });
    const notOnLedger = await escrow(a.agentId, { gross: '5.00' }); // its COMMIT stays undelivered
    await drain();
    await db.pool.query(`UPDATE ledger_outbox SET status = 'PENDING', next_attempt_at = NOW() + INTERVAL '1 hour' WHERE escrow_id = $1`, [notOnLedger.escrowId]);
    const skew = await escrow(a.agentId, { gross: '7.00', dueMinutes: -2 }); // due, but within the 5-min skew margin
    await drain();

    const order: string[] = [];
    fake.handler = (fn, _r, txId) => (order.push(fn), ok(txId, 99n));
    b2c.b2cPayment.mockImplementation(async () => (order.push('B2C'), { kind: 'ACCEPTED', conversationId: 'AG_1' }));
    const r = await service.claim(a.userId, '1234', '1', client);
    expect(r.kind).toBe('claimed');
    const p = (r as any).payout;
    expect(p).toMatchObject({ status: 'SENT', amount: 50 });
    expect(order).toEqual(['AuthorisePayout', 'B2C']);
    const auth = fake.calls.find((c) => c.fn === 'AuthorisePayout')!.request;
    expect(auth).toMatchObject({ payoutId: p.payoutId, agentRef: a.agentId, grossCents: 5050, carryInCents: 0, carryOutCents: 50, amount: 50, disclosureVersion: '1' });
    expect(auth.escrowIds.sort()).toEqual([e1.escrowId, e2.escrowId].sort());
    const row = await payoutRow(p.payoutId);
    expect(auth.canary).toEqual({ status: 'HEALTHY', destinationRef: row.destination_id, checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) });
    expect(auth.consentDigest).toBe(hmacHex(Buffer.from(process.env.LEDGER_CONSENT_HMAC_KEY!), row.consent_hash));
    expect(row).toMatchObject({ ledger_tx_id: 'tx' + fake.calls.length, ledger_block_number: '99', ledger_consent_digest: auth.consentDigest, ledger_consent_key_id: 'k1' });
    expect(row.ledger_authorise_tx_ids).toEqual([row.ledger_tx_id]);
    expect(await escrowRow(notOnLedger.escrowId)).toMatchObject({ escrow_status: 'HELD' });
    expect(await escrowRow(skew.escrowId)).toMatchObject({ escrow_status: 'HELD' });

    expect((await applyPayoutResult(db.pool, { originatorConversationId: p.payoutId, conversationId: 'AG_1', resultCode: '0', receiverName: null, receipt: 'RCPT000001' })).kind).toBe('applied');
    const [settle] = await outbox(`op = 'SETTLE' AND payout_id = $1`, [p.payoutId]);
    expect(JSON.parse(settle.request)).toEqual({ payoutId: p.payoutId, outcome: 'PAID' });
    expect(settle.keys.sort()).toEqual([`p:${p.payoutId}`, `e:${e1.escrowId}`, `e:${e2.escrowId}`].sort());
    await drain();
    expect((await outbox(`payout_id = $1`, [p.payoutId]))[0].status).toBe('DELIVERED');
    expect((await payoutRow(p.payoutId)).ledger_block_hash).toBe((99).toString(16).padStart(64, '0'));
  });

  it('claim refused (#9 code): rollback ledger_<code>, nothing sent, no SMS, escrows HELD; QUARANTINED-on-ledger escrows mirrored; 503', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { gross: '30.00' });
    const e2 = await escrow(a.agentId, { gross: '20.00' });
    await drain();
    fake.handler = (fn, _r, txId) => (fn === 'AuthorisePayout' ? { ok: false, code: 'INVALID_TRANSITION', message: `INVALID_TRANSITION: escrow ${e2.escrowId} is QUARANTINED` } : ok(txId));
    fake.escrows.set(e1.escrowId, { status: 'HELD' });
    fake.escrows.set(e2.escrowId, { status: 'QUARANTINED', lockedBy: 'auditor' });
    const r = (await service.claim(a.userId, '1234', '1', client)) as any;
    expect(r.payout).toMatchObject({ status: 'FAILED', failureReason: 'ledger_invalid_transition' });
    expect(b2c.b2cPayment).not.toHaveBeenCalled();
    await service.settled();
    expect(sent).toEqual([]);
    expect(await escrowRow(e1.escrowId)).toMatchObject({ escrow_status: 'HELD', payout_id: null });
    expect(await escrowRow(e2.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'auditor_hold', security_hold: true });
    expect(await outbox(`op = 'SETTLE' AND payout_id = $1`, [r.payout.payoutId])).toEqual([]); // refused: never settled
    expect(metrics.ledger).toMatchObject({ authoriseRefused: 1, mirrored: 1 });

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    await new PayoutController({ claim: async () => r, disclosure: () => ({}) } as any).claim({ auth: { userId: a.userId }, body: {}, headers: {}, get: () => undefined, ip: '' } as any, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'temporarily_unavailable' }));
  });

  it('claim with the ledger down: retried ≤ timeout, rollback ledger_unavailable, delayed Settle FAILED with the tx ids; security-held escrow quarantined after it', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { gross: '30.00' });
    const e2 = await escrow(a.agentId, { gross: '20.00' });
    await drain();
    let first = true;
    fake.handler = (fn, _r, txId) => {
      if (fn !== 'AuthorisePayout') return ok(txId);
      if (first) {
        first = false;
        void securityHoldReceipt(db.pool, e2.receipt); // a payload mutation lands mid-claim
      }
      return infra();
    };
    const t0 = Date.now();
    const r = (await service.claim(a.userId, '1234', '1', client)) as any;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.payout).toMatchObject({ status: 'FAILED', failureReason: 'ledger_unavailable' });
    expect(b2c.b2cPayment).not.toHaveBeenCalled();
    const attempts = fake.calls.filter((c) => c.fn === 'AuthorisePayout').length;
    expect(attempts).toBeGreaterThanOrEqual(2);
    const row = await payoutRow(r.payout.payoutId);
    expect(row.ledger_authorise_tx_ids).toHaveLength(attempts);
    expect(row.ledger_tx_id).toBeNull();
    expect(await escrowRow(e1.escrowId)).toMatchObject({ escrow_status: 'HELD' });
    expect(await escrowRow(e2.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'security_hold' });

    const [settle] = await outbox(`op = 'SETTLE' AND payout_id = $1`, [r.payout.payoutId]);
    expect(JSON.parse(settle.request)).toEqual({ payoutId: r.payout.payoutId, outcome: 'FAILED', failureCode: 'ledger_unavailable', quarantineEscrowIds: [e2.escrowId] });
    expect(settle.absent_tx_ids).toEqual(row.ledger_authorise_tx_ids);
    expect(new Date(settle.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + ROLLBACK_SETTLE_DELAY_MS - 30_000);
    const after = (await rowsFor(e2.escrowId)).filter((x) => x.outbox_id > settle.outbox_id);
    expect(after.map((x) => [x.op, JSON.parse(x.request).reason])).toEqual([['QUARANTINE', 'security_hold']]);
    // Not claimable while the Settle is undelivered (a late Authorise could still hold them on chain).
    expect(await claimableEscrows(db.pool, a.agentId, false, true)).toEqual([]);
    const pending = await pendingAccruals(db.pool, a.agentId, 50, true);
    expect(pending.accruals.map((x) => x.escrowId)).toEqual(expect.arrayContaining([e1.escrowId]));
    expect(pending).toMatchObject({ pendingCount: 1, pendingCents: 3000 }); // matured but not on the ledger as Postgres has it

    // The Settle is due: NOT_FOUND, but one Authorise tx committed late → retried, not done.
    await db.pool.query(`UPDATE ledger_outbox SET next_attempt_at = NOW() WHERE outbox_id = $1`, [settle.outbox_id]);
    fake.committed.add(row.ledger_authorise_tx_ids[0]);
    fake.handler = (fn, _r, txId) => (fn === 'SettlePayout' ? { ok: false, code: 'NOT_FOUND', message: `NOT_FOUND: payout ${r.payout.payoutId}` } : ok(txId));
    await worker.runOnce();
    expect((await outbox(`outbox_id = $1`, [settle.outbox_id]))[0]).toMatchObject({ status: 'PENDING', last_error: expect.stringMatching(/committed; retrying/) });
    // None committed → NOT_FOUND is done; the quarantine behind it goes next.
    fake.committed.clear();
    await new Promise((res) => setTimeout(res, 60));
    await drain();
    expect((await outbox(`outbox_id = $1`, [settle.outbox_id]))[0]).toMatchObject({ status: 'DELIVERED', tx_id: null });
    expect((await rowsFor(e2.escrowId)).every((x) => x.status === 'DELIVERED')).toBe(true);
    expect(await claimableEscrows(db.pool, a.agentId, false, true)).toEqual([{ escrowId: e1.escrowId, cents: 3000 }]);
  });

  it('an Authorise never endorsed (no tx id) needs no Settle', async () => {
    const a = await agent();
    await escrow(a.agentId, { gross: '30.00' });
    await drain();
    fake.submit = async (fn: string) => (fake.calls.push({ fn, request: {} }), infra()); // fails before endorsement
    const r = (await service.claim(a.userId, '1234', '1', client)) as any;
    expect(r.payout.failureReason).toBe('ledger_unavailable');
    expect(await outbox(`op = 'SETTLE' AND payout_id = $1`, [r.payout.payoutId])).toEqual([]);
  });

  it('a FAILED authorised payout lists its security-held escrows in the Settle; a Daraja-style failure code is sanitised', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { gross: '30.00' });
    const e2 = await escrow(a.agentId, { gross: '20.00' });
    await drain();
    const r = (await service.claim(a.userId, '1234', '1', client)) as any;
    await securityHoldReceipt(db.pool, e1.receipt); // CLAIMED: no Quarantine row, listed in the Settle instead
    await applyPayoutResult(db.pool, { originatorConversationId: r.payout.payoutId, conversationId: 'AG_1', resultCode: 'SFC.IC0001', receiverName: null, receipt: null });
    expect((await payoutRow(r.payout.payoutId)).failure_reason).toBe('b2c_SFC.IC0001');
    const [settle] = await outbox(`op = 'SETTLE' AND payout_id = $1`, [r.payout.payoutId]);
    expect(JSON.parse(settle.request)).toEqual({ payoutId: r.payout.payoutId, outcome: 'FAILED', failureCode: 'b2c_sfc_ic0001', quarantineEscrowIds: [e1.escrowId] });
    expect(settle.absent_tx_ids).toBeNull();
    expect((await rowsFor(e1.escrowId)).map((x) => x.op)).toEqual(['COMMIT', 'SETTLE']);
    expect(await escrowRow(e2.escrowId)).toMatchObject({ escrow_status: 'HELD' });
  });

  it('FABRIC_ENABLED=false: rows are written, nothing is sent; claims skip the gate and the ledger filter', async () => {
    const off = new LedgerWorker({ pool: db.pool, ledger: fake, enabled: () => false });
    const a = await agent();
    const e = await escrow(a.agentId, { gross: '30.00', dueMinutes: -1 });
    expect(await off.runOnce()).toBe(0);
    expect(fake.calls).toEqual([]);
    expect((await rowsFor(e.escrowId))[0].status).toBe('PENDING');
    const plain = new PayoutService({
      db: db.pool, b2c: b2c as any, auth: { confirmPin: async () => ({ kind: 'ok', phoneNumber: '' }) }, notifier: { send: async () => undefined }, metrics,
      config: { minAmount: 10, maxAmount: 150_000, statusAfterMs: 3_600_000, statusMaxAttempts: 2, disclosureVersion: '1' }, ledger: fake, ledgerEnabled: () => false,
    });
    const r = (await plain.claim(a.userId, '1234', '1', client)) as any;
    expect(r.payout.status).toBe('SENT');
    expect(fake.calls).toEqual([]);
    await applyPayoutResult(db.pool, { originatorConversationId: r.payout.payoutId, conversationId: 'AG_1', resultCode: '0', receiverName: null, receipt: 'RCPT000002' });
    expect(await outbox(`op = 'SETTLE' AND payout_id = $1`, [r.payout.payoutId])).toEqual([]); // never authorised: nothing to settle
    // Paid before the ledger was on: its pending COMMIT must never publish it as HELD.
    expect((await rowsFor(e.escrowId))[0]).toMatchObject({ status: 'SUPERSEDED', last_error: 'paid before the ledger was enabled' });
    await plain.settled();
  });

  it('FABRIC_ENABLED=false: a FAILED payout queues a Quarantine for each security-held escrow (no Settle)', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { gross: '30.00' });
    const e2 = await escrow(a.agentId, { gross: '20.00' });
    const plain = new PayoutService({
      db: db.pool, b2c: b2c as any, auth: { confirmPin: async () => ({ kind: 'ok', phoneNumber: '' }) }, notifier: { send: async () => undefined }, metrics,
      config: { minAmount: 10, maxAmount: 150_000, statusAfterMs: 3_600_000, statusMaxAttempts: 2, disclosureVersion: '1' }, ledger: fake, ledgerEnabled: () => false,
    });
    const r = (await plain.claim(a.userId, '1234', '1', client)) as any;
    await securityHoldReceipt(db.pool, e1.receipt); // CLAIMED: no row yet
    await applyPayoutResult(db.pool, { originatorConversationId: r.payout.payoutId, conversationId: 'AG_1', resultCode: '2001', receiverName: null, receipt: null });
    expect(await escrowRow(e1.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', quarantine_reason: 'security_hold' });
    expect((await rowsFor(e1.escrowId)).map((x) => [x.op, JSON.parse(x.request).reason ?? null])).toEqual([['COMMIT', null], ['QUARANTINE', 'security_hold']]);
    expect((await rowsFor(e2.escrowId)).map((x) => x.op)).toEqual(['COMMIT']);
    expect(await outbox(`op = 'SETTLE' AND payout_id = $1`, [r.payout.payoutId])).toEqual([]);
    await plain.settled();
  });

  it('the gate throwing after the claim committed (e.g. the canary read) rolls it back: FAILED ledger_unavailable, escrows HELD, no B2C', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, { gross: '30.00' });
    await drain();
    const spy = jest.spyOn(canary, 'payoutCanary').mockRejectedValueOnce(new Error('db hiccup'));
    try {
      const r = (await service.claim(a.userId, '1234', '1', client)) as any;
      expect(r.payout).toMatchObject({ status: 'FAILED', failureReason: 'ledger_unavailable' });
    } finally {
      spy.mockRestore();
    }
    expect(b2c.b2cPayment).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.fn === 'AuthorisePayout')).toBe(false);
    expect(await escrowRow(e1.escrowId)).toMatchObject({ escrow_status: 'HELD', payout_id: null });
  });

  it('unclaimed reminders follow the ledger READY rule: the only matured escrow unsynced → no reminder', async () => {
    const a = await agent();
    await escrow(a.agentId, { gross: '30.00', dueMinutes: -8 * 1440 }); // matured 8 days ago, its COMMIT still PENDING
    const mine = (rs: Array<{ agentId: string }>) => rs.filter((x) => x.agentId === a.agentId);
    expect(mine(await dueReminders(db.pool, { stages: [7, 30, 90], minAmount: 10, limit: 1000, ledger: true }))).toEqual([]);
    expect(mine(await dueReminders(db.pool, { stages: [7, 30, 90], minAmount: 10, limit: 1000, ledger: false }))).toHaveLength(1); // control
  });

  it('without the HMAC keys nothing is enqueued; ledger:init backfills HELD / QUARANTINED escrows (with a Release where the commit would quarantine)', async () => {
    const saved = process.env.LEDGER_STATE_HMAC_KEY;
    delete process.env.LEDGER_STATE_HMAC_KEY;
    let e: { escrowId: string };
    let reviewed: { escrowId: string };
    try {
      const a = await agent();
      e = await escrow(a.agentId);
      reviewed = await escrow(a.agentId, { decision: 'REVIEW' }); // an admin released it: HELD with a REVIEW decision
      expect(await rowsFor(e.escrowId)).toEqual([]);
      await expect(backfillCommits(db.pool)).rejects.toThrow(/not configured/);
    } finally {
      process.env.LEDGER_STATE_HMAC_KEY = saved;
    }
    expect(await backfillCommits(db.pool)).toBeGreaterThanOrEqual(2);
    expect((await rowsFor(e.escrowId)).map((r) => r.op)).toEqual(['COMMIT']);
    expect((await rowsFor(reviewed.escrowId)).map((r) => [r.op, JSON.parse(r.request).reason ?? null])).toEqual([['COMMIT', null], ['RELEASE', 'admin_release']]);
    expect(await backfillCommits(db.pool)).toBe(0); // re-run: nothing new
  });
});
