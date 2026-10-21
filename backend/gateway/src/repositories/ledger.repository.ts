/**
 * @file ledger.repository.ts
 * @description SQL for the Fabric ledger sync (DLT-03, #10, docs/architecture/ledger-sync.md).
 *
 * Enqueue: each enqueue* runs inside the caller's transaction, next to the state change it reports,
 * and snapshots the full chaincode request JSON (the worker sends exactly that). Without the LEDGER_*
 * HMAC keys nothing is enqueued (logged once); `npm run ledger:init` backfills later.
 * Delivery: ordered per key (`e:<escrowId>`, `p:<payoutId>`): a row is leased only when no earlier
 * PENDING or DEAD row shares a key, so a DEAD row keeps blocking its keys until `ledger:requeue`.
 */

import crypto from 'crypto';
import { ledgerKeysOrNull, type LedgerKeys } from '../config/fabric';
import { commitRequest, hmacHex, quarantineRequest, releaseRequest, settleRequest, statePreimageV1 } from '../domain/ledger';
import { withTransaction, type Db, type TxDb } from './db.types';

export type OutboxOp = 'COMMIT' | 'QUARANTINE' | 'RELEASE' | 'SETTLE';

const eKey = (id: string) => `e:${id}`;
const pKey = (id: string) => `p:${id}`;

/** SQL: the escrow `e` has an undelivered outbox row (it is not on the ledger as Postgres has it yet). */
export const LEDGER_UNSYNCED = (e: string) =>
  `EXISTS (SELECT 1 FROM ledger_outbox lo WHERE lo.status IN ('PENDING', 'DEAD') AND lo.keys @> ARRAY['e:' || ${e}.escrow_id::text])`;

let warned = false;
function keys(): LedgerKeys | null {
  const k = ledgerKeysOrNull();
  if (!k && !warned) {
    warned = true;
    console.warn('[Ledger] LEDGER_STATE_HMAC_KEY / LEDGER_CONSENT_HMAC_KEY not configured: no ledger outbox rows are written (backfill with `npm run ledger:init`)');
  }
  return k;
}

async function insert(
  db: Db,
  r: { op: OutboxOp; keys: string[]; request: string; requestId?: string; escrowId?: string; payoutId?: string; absentTxIds?: string[]; delayMs?: number }
): Promise<void> {
  await db.query(
    `INSERT INTO ledger_outbox (op, keys, request, request_id, escrow_id, payout_id, absent_tx_ids, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8::double precision / 1000))`,
    [r.op, r.keys, r.request, r.requestId ?? null, r.escrowId ?? null, r.payoutId ?? null, r.absentTxIds ?? null, r.delayMs ?? 0]
  );
}

/**
 * COMMIT: the escrow as Postgres has it now (its latest verification event: the INITIAL one at settle
 * time), with stateHash = HMAC(state key, preimage v1) stored on the escrow with its key id.
 */
export async function enqueueCommit(db: Db, escrowId: string): Promise<boolean> {
  const k = keys();
  if (!k) return false;
  const { rows: [r] } = await db.query(
    `SELECT e.escrow_id, e.transaction_id, t.agent_id, t.mpesa_receipt_id, t.raw_payload_hash,
            (t.amount * 100)::bigint AS amount_cents, (e.gross_commission * 100)::bigint AS gross_cents,
            e.quarantine_reason, e.release_due_at, v.verification_id, v.model_version, v.model_sha256, v.decision, v.is_fail_safe
       FROM escrow_accounts e
       JOIN transactions t USING (transaction_id)
       JOIN LATERAL (SELECT * FROM verification_events v WHERE v.transaction_id = e.transaction_id
                      ORDER BY v.evaluated_at DESC, (v.kind = 'RESCORE') DESC, v.verification_id DESC LIMIT 1) v ON TRUE
      WHERE e.escrow_id = $1`,
    [escrowId]
  );
  if (!r) {
    console.error(`[Ledger] escrow ${escrowId} has no verification event: not committed to the ledger`);
    return false;
  }
  const state = {
    escrowId: r.escrow_id,
    transactionId: r.transaction_id,
    agentId: r.agent_id,
    mpesaReceiptId: r.mpesa_receipt_id,
    rawPayloadHash: r.raw_payload_hash,
    amountCents: Number(r.amount_cents),
    grossCents: Number(r.gross_cents),
    verificationId: r.verification_id,
    modelVersion: r.model_version,
    modelSha256: r.model_sha256,
    decision: r.decision,
    failSafe: r.is_fail_safe,
    quarantineReason: r.quarantine_reason,
    releaseDueAt: new Date(r.release_due_at),
  };
  const stateHash = hmacHex(k.state.key, statePreimageV1(state));
  await db.query(`UPDATE escrow_accounts SET ledger_state_hash = $2, ledger_state_key_id = $3 WHERE escrow_id = $1`, [escrowId, stateHash, k.state.id]);
  await insert(db, { op: 'COMMIT', keys: [eKey(escrowId)], request: commitRequest(state, stateHash), escrowId });
  return true;
}

/** QUARANTINE with a fresh requestId (stored on the row, reused by every retry). */
export async function enqueueQuarantine(db: Db, escrowId: string, reason: string): Promise<boolean> {
  if (!keys()) return false;
  const requestId = crypto.randomUUID();
  await insert(db, { op: 'QUARANTINE', keys: [eKey(escrowId)], request: quarantineRequest(requestId, escrowId, reason), requestId, escrowId });
  return true;
}

export async function enqueueRelease(db: Db, escrowId: string, reason: string, releaseDueAt: Date): Promise<boolean> {
  if (!keys()) return false;
  const requestId = crypto.randomUUID();
  await insert(db, { op: 'RELEASE', keys: [eKey(escrowId)], request: releaseRequest(requestId, escrowId, reason, releaseDueAt), requestId, escrowId });
  return true;
}

/**
 * SETTLE, keyed by the payout and every escrow of it (so a re-claim of a returned escrow waits for it).
 * `absentTxIds` + `delayMs`: the rollback's Settle FAILED (in case the Authorise committed late).
 */
export async function enqueueSettle(
  db: Db,
  payoutId: string,
  escrowIds: string[],
  s: { outcome: 'PAID' } | { outcome: 'FAILED'; failureCode: string; quarantineEscrowIds: string[] },
  o: { absentTxIds?: string[]; delayMs?: number } = {}
): Promise<boolean> {
  if (!keys()) return false;
  await insert(db, { op: 'SETTLE', keys: [pKey(payoutId), ...escrowIds.map(eKey)], request: settleRequest(payoutId, s), payoutId, ...o });
  return true;
}

// ── Claim gate (AuthorisePayout, synchronous) ─────────────────────────

/** The consent digest sent on chain, with its key id. Null when the keys are not configured. */
export async function recordConsentDigest(db: Db, payoutId: string, consentHash: string): Promise<string | null> {
  const k = keys();
  if (!k) return null;
  const digest = hmacHex(k.consent.key, consentHash);
  await db.query(`UPDATE payouts SET ledger_consent_digest = $2, ledger_consent_key_id = $3 WHERE payout_id = $1`, [payoutId, digest, k.consent.id]);
  return digest;
}

/** Every Authorise tx id that may reach the orderer, recorded before it is sent. */
export async function recordAuthoriseAttempt(db: Db, payoutId: string, txId: string): Promise<void> {
  await db.query(`UPDATE payouts SET ledger_authorise_tx_ids = array_append(ledger_authorise_tx_ids, $2) WHERE payout_id = $1`, [payoutId, txId]);
}

export async function recordAuthorised(db: Db, payoutId: string, txId: string, blockNumber: bigint): Promise<void> {
  await db.query(`UPDATE payouts SET ledger_tx_id = $2, ledger_block_number = $3 WHERE payout_id = $1`, [payoutId, txId, blockNumber.toString()]);
}

/**
 * Mirrors escrows the ledger has QUARANTINED: Postgres QUARANTINED, `auditor_hold`, security_hold (no
 * admin override, no self-heal). Only HELD / QUARANTINED escrows not already security-held.
 */
export async function mirrorAuditorHold(db: Db, escrowIds: string[]): Promise<string[]> {
  if (escrowIds.length === 0) return [];
  const { rows } = await db.query(
    `UPDATE escrow_accounts SET escrow_status = 'QUARANTINED', quarantine_reason = 'auditor_hold', security_hold = TRUE,
            rescore_claimed_at = NULL, rescore_claim_token = NULL
      WHERE escrow_id = ANY($1::uuid[]) AND escrow_status IN ('HELD', 'QUARANTINED') AND NOT security_hold
      RETURNING escrow_id`,
    [escrowIds]
  );
  return rows.map((r) => r.escrow_id);
}

/** The auditor released it on the ledger: HELD again, the ledger's due date, security_hold cleared. */
export async function mirrorAuditorRelease(db: Db, escrowId: string, releaseDueAt: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE escrow_accounts SET escrow_status = 'HELD', quarantine_reason = NULL, security_hold = FALSE, release_due_at = $2
      WHERE escrow_id = $1 AND escrow_status = 'QUARANTINED' AND quarantine_reason = 'auditor_hold'`,
    [escrowId, releaseDueAt.toISOString()]
  );
  return rowCount === 1;
}

/** auditor_hold escrows after `afterId` (keyset paging, so every one is polled in turn). */
export async function auditorHolds(db: Db, afterId: string, limit: number): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT escrow_id FROM escrow_accounts WHERE quarantine_reason = 'auditor_hold' AND escrow_status = 'QUARANTINED' AND escrow_id > $1::uuid
      ORDER BY escrow_id LIMIT $2`,
    [afterId, limit]
  );
  return rows.map((r) => r.escrow_id);
}

// ── Outbox delivery (worker) ──────────────────────────────────────────

export interface OutboxLease {
  outboxId: string;
  op: OutboxOp;
  request: string;
  escrowId: string | null;
  payoutId: string | null;
  absentTxIds: string[] | null;
  attempts: number;
  token: string;
}

/** Leases due PENDING rows whose keys no earlier PENDING / DEAD row shares, oldest first. */
export async function leaseOutbox(db: Db, limit: number, leaseMs: number): Promise<OutboxLease[]> {
  const { rows } = await db.query(
    `UPDATE ledger_outbox c SET claimed_at = NOW(), claim_token = gen_random_uuid(), attempts = c.attempts + 1
      WHERE c.outbox_id IN (
            SELECT o.outbox_id FROM ledger_outbox o
             WHERE o.status = 'PENDING' AND o.next_attempt_at <= NOW()
               AND (o.claimed_at IS NULL OR o.claimed_at < NOW() - make_interval(secs => $2::double precision / 1000))
               AND NOT EXISTS (SELECT 1 FROM ledger_outbox b
                                WHERE b.status IN ('PENDING', 'DEAD') AND b.outbox_id < o.outbox_id AND b.keys && o.keys)
             ORDER BY o.outbox_id
             LIMIT $1
             FOR UPDATE OF o SKIP LOCKED)
      RETURNING c.outbox_id, c.op, c.request, c.escrow_id, c.payout_id, c.absent_tx_ids, c.attempts, c.claim_token`,
    [limit, leaseMs]
  );
  return rows
    .map((r) => ({
      outboxId: String(r.outbox_id),
      op: r.op,
      request: r.request,
      escrowId: r.escrow_id,
      payoutId: r.payout_id,
      absentTxIds: r.absent_tx_ids,
      attempts: Number(r.attempts),
      token: r.claim_token,
    }))
    .sort((a, b) => Number(a.outboxId) - Number(b.outboxId));
}

/** Delivered (tx committed, or a no-op settle): a COMMIT also stamps its escrow. False when the lease was lost. */
export async function markDelivered(db: Db, l: OutboxLease, c: { txId: string; blockNumber: bigint } | null, note: string | null = null): Promise<boolean> {
  const { rows: [r] } = await db.query(
    `WITH d AS (
       UPDATE ledger_outbox SET status = 'DELIVERED', delivered_at = NOW(), tx_id = $3, block_number = $4, last_error = $5, claimed_at = NULL, claim_token = NULL
        WHERE outbox_id = $1 AND claim_token = $2 RETURNING op, escrow_id, tx_id, block_number),
     e AS (
       UPDATE escrow_accounts x SET ledger_tx_id = d.tx_id, ledger_block_number = d.block_number
         FROM d WHERE d.op = 'COMMIT' AND d.tx_id IS NOT NULL AND x.escrow_id = d.escrow_id)
     SELECT count(*)::int AS n FROM d`,
    [l.outboxId, l.token, c?.txId ?? null, c?.blockNumber.toString() ?? null, note]
  );
  return r.n === 1;
}

/** Retry later (infrastructure failure, or a late Authorise still in doubt). */
export async function markRetry(db: Db, l: OutboxLease, delayMs: number, error: string): Promise<void> {
  await db.query(
    `UPDATE ledger_outbox SET next_attempt_at = NOW() + make_interval(secs => $3::double precision / 1000), last_error = $4, claimed_at = NULL, claim_token = NULL
      WHERE outbox_id = $1 AND claim_token = $2`,
    [l.outboxId, l.token, delayMs, error.slice(0, 1000)]
  );
}

/** Terminal: parked, still blocking its keys; `npm run ledger:requeue <id>` re-arms it. */
export async function markDead(db: Db, l: OutboxLease, error: string): Promise<void> {
  await db.query(`UPDATE ledger_outbox SET status = 'DEAD', last_error = $3, claimed_at = NULL, claim_token = NULL WHERE outbox_id = $1 AND claim_token = $2`, [
    l.outboxId,
    l.token,
    error.slice(0, 1000),
  ]);
}

/** The auditor's lock overrides our Quarantine / Release: done, not dead (the escrow is mirrored as auditor_hold). */
export async function markSuperseded(db: Db, l: OutboxLease, note: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE ledger_outbox SET status = 'SUPERSEDED', delivered_at = NOW(), last_error = $3, claimed_at = NULL, claim_token = NULL WHERE outbox_id = $1 AND claim_token = $2`,
    [l.outboxId, l.token, note.slice(0, 1000)]
  );
  return rowCount === 1;
}

/** Gives back unused leases (a batch stopped early): the attempt is undone, guarded by the token. */
export async function releaseLeases(db: Db, leases: OutboxLease[]): Promise<void> {
  for (const l of leases) {
    await db.query(
      `UPDATE ledger_outbox SET claimed_at = NULL, claim_token = NULL, attempts = GREATEST(attempts - 1, 0) WHERE outbox_id = $1 AND claim_token = $2`,
      [l.outboxId, l.token]
    );
  }
}

/** The escrows' still-PENDING rows will never be sent (e.g. paid while the ledger was off). */
export async function supersedePending(db: Db, escrowIds: string[], note: string): Promise<void> {
  if (escrowIds.length === 0) return;
  await db.query(
    `UPDATE ledger_outbox SET status = 'SUPERSEDED', delivered_at = NOW(), last_error = $2, claimed_at = NULL, claim_token = NULL
      WHERE status = 'PENDING' AND keys && $1::text[]`,
    [escrowIds.map(eKey), note]
  );
}

/** Block numbers whose hash is still missing on an outbox row or a payout. */
export async function blocksMissingHash(db: Db, limit: number): Promise<bigint[]> {
  const { rows } = await db.query(
    `SELECT n FROM (SELECT block_number AS n FROM ledger_outbox WHERE block_number IS NOT NULL AND block_hash IS NULL
                    UNION SELECT ledger_block_number FROM payouts WHERE ledger_block_number IS NOT NULL AND ledger_block_hash IS NULL) x
      ORDER BY n LIMIT $1`,
    [limit]
  );
  return rows.map((r) => BigInt(r.n));
}

export async function fillBlockHash(db: Db, n: bigint, hash: string): Promise<void> {
  const b = n.toString();
  await db.query(
    `UPDATE escrow_accounts e SET ledger_block_hash = $2 FROM ledger_outbox o
      WHERE o.block_number = $1 AND o.block_hash IS NULL AND o.op = 'COMMIT' AND e.escrow_id = o.escrow_id AND e.ledger_block_number = $1`,
    [b, hash]
  );
  await db.query(`UPDATE ledger_outbox SET block_hash = $2 WHERE block_number = $1 AND block_hash IS NULL`, [b, hash]);
  await db.query(`UPDATE payouts SET ledger_block_hash = $2 WHERE ledger_block_number = $1 AND ledger_block_hash IS NULL`, [b, hash]);
}

/** Health: undelivered and parked rows, the oldest pending age, mirrored auditor holds. */
export async function ledgerStats(db: Db): Promise<{ pending: number; dead: number; oldestPendingAgeSeconds: number | null; auditorHolds: number }> {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending, count(*) FILTER (WHERE status = 'DEAD')::int AS dead,
            EXTRACT(EPOCH FROM NOW() - min(created_at) FILTER (WHERE status = 'PENDING'))::int AS oldest,
            (SELECT count(*) FROM escrow_accounts WHERE quarantine_reason = 'auditor_hold' AND escrow_status = 'QUARANTINED')::int AS holds
       FROM ledger_outbox WHERE status IN ('PENDING', 'DEAD')`
  );
  return { pending: r?.pending ?? 0, dead: r?.dead ?? 0, oldestPendingAgeSeconds: r?.oldest ?? null, auditorHolds: r?.holds ?? 0 };
}

/**
 * `npm run ledger:init`: queues a COMMIT for HELD / QUARANTINED escrows that have none (settled before
 * the keys were set, or back from a payout claimed before). The chaincode derives the status from the
 * commit; where that differs from Postgres (an admin release, a legacy quarantine), a Release or
 * Quarantine follows. Returns the number of escrows queued.
 */
export async function backfillCommits(db: TxDb, batch = 100): Promise<number> {
  if (!keys()) throw new Error('LEDGER_STATE_HMAC_KEY / LEDGER_CONSENT_HMAC_KEY are not configured');
  let total = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const n = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT e.escrow_id, e.escrow_status, e.quarantine_reason, e.release_due_at, v.decision, v.is_fail_safe
           FROM escrow_accounts e
           JOIN LATERAL (SELECT v.decision, v.is_fail_safe FROM verification_events v WHERE v.transaction_id = e.transaction_id
                          ORDER BY v.evaluated_at DESC, (v.kind = 'RESCORE') DESC, v.verification_id DESC LIMIT 1) v ON TRUE
          WHERE e.escrow_status IN ('HELD', 'QUARANTINED') AND e.escrow_id > $2::uuid
            AND NOT EXISTS (SELECT 1 FROM ledger_outbox o WHERE o.escrow_id = e.escrow_id AND o.op = 'COMMIT')
          ORDER BY e.escrow_id LIMIT $1 FOR UPDATE OF e`,
        [batch, after]
      );
      if (rows.length) after = rows[rows.length - 1].escrow_id;
      let queued = 0;
      for (const r of rows) {
        if (!(await enqueueCommit(tx, r.escrow_id))) continue;
        queued += 1;
        const onChain = r.quarantine_reason || r.is_fail_safe || r.decision !== 'CLEAR' ? 'QUARANTINED' : 'HELD';
        if (onChain === 'QUARANTINED' && r.escrow_status === 'HELD') await enqueueRelease(tx, r.escrow_id, 'admin_release', new Date(r.release_due_at));
        if (onChain === 'HELD' && r.escrow_status === 'QUARANTINED') await enqueueQuarantine(tx, r.escrow_id, 'legacy_quarantine');
      }
      total += queued;
      return rows.length;
    });
    if (n < batch) return total;
  }
}

/** `npm run ledger:requeue <id>`: a DEAD row back to PENDING, attempts reset. */
export async function requeueDead(db: Db, outboxId: string): Promise<{ op: string; lastError: string | null } | null> {
  if (!/^\d{1,18}$/.test(outboxId)) return null;
  const { rows: [r] } = await db.query(
    `UPDATE ledger_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(), claimed_at = NULL, claim_token = NULL
      WHERE outbox_id = $1 AND status = 'DEAD' RETURNING op, last_error`,
    [outboxId]
  );
  return r ? { op: r.op, lastError: r.last_error } : null;
}
