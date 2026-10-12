/**
 * @file payout.repository.ts
 * @description SQL for agent-claimed payouts (spec gh-11, part 2). A claim and its escrows'
 * HELD → CLAIMED move commit together, before the B2C call; every payout state change and its
 * PAYOUT_STATUS_CHANGED security event commit together. At most one open (SENT / UNKNOWN /
 * UNRESOLVED) payout per agent: claims are serialised on the agent row, backed by a partial unique
 * index. Lock order everywhere: escrow rows, then the agent row (as securityHoldReceipt does).
 */

import type { PoolClient, QueryResultRow } from 'pg';
import type { B2cOutcome, B2cResult, TransactionStatusResult } from '../daraja/client';
import { consentHash, splitClaim, type PayoutStatus } from '../domain/payout';
import { maskMsisdn, namesMatch } from '../domain/payout_destination';
import { withTransaction, type Db, type TxDb } from './db.types';
import { insertSubjectSecurityEvent } from './security.repository';

export interface PayoutRow {
  payoutId: string;
  agentId: string;
  destinationId: string;
  msisdn: string;
  amount: number;
  grossCents: number;
  carryInCents: number;
  carryOutCents: number;
  status: PayoutStatus;
  failureReason: string | null;
  disclosureVersion: string;
  consentHash: string;
  acceptedAt: Date;
  conversationId: string | null;
  receipt: string | null;
  resultCode: string | null;
  statusAttempts: number;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** A changed payout and the agent's login user (the event subject). */
export interface PayoutChange {
  payout: PayoutRow;
  userId: string;
  /** PAID with a registered name that does not match users.full_name (PAYOUT_NAME_MISMATCH written). */
  nameMismatch?: boolean;
}

export type ClaimOutcome =
  | { kind: 'disabled' }
  | { kind: 'payout_in_progress' }
  | { kind: 'no_active_destination' }
  | { kind: 'destination_changing' }
  | { kind: 'below_minimum'; amount: number }
  | { kind: 'above_maximum' }
  | ({ kind: 'created'; escrows: number } & PayoutChange);

export type ResultOutcome =
  | { kind: 'unknown' }
  /** `conflict`: a definitive result contradicting the final status (recorded as a CONFLICT event). */
  | { kind: 'duplicate'; conflict?: string }
  | { kind: 'pending' }
  | ({ kind: 'applied' } & PayoutChange);

export interface StatusLease {
  payoutId: string;
  queryId: string;
  token: string;
  attempts: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = `p.payout_id, p.agent_id, p.destination_id, p.msisdn, p.amount, p.gross_cents, p.carry_in_cents, p.carry_out_cents,
              p.status, p.failure_reason, p.disclosure_version, p.consent_hash, p.accepted_at, p.conversation_id, p.receipt,
              p.result_code, p.status_attempts, p.created_at, p.resolved_at`;
const RETURNING = COLS.replace(/p\./g, '');
const OPEN = `('SENT', 'UNKNOWN', 'UNRESOLVED')`;

const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);
function toRow(r: QueryResultRow): PayoutRow {
  return {
    payoutId: r.payout_id,
    agentId: r.agent_id,
    destinationId: r.destination_id,
    msisdn: r.msisdn,
    amount: Number(r.amount),
    grossCents: Number(r.gross_cents),
    carryInCents: Number(r.carry_in_cents),
    carryOutCents: Number(r.carry_out_cents),
    status: r.status,
    failureReason: r.failure_reason,
    disclosureVersion: r.disclosure_version,
    consentHash: r.consent_hash,
    acceptedAt: new Date(r.accepted_at),
    conversationId: r.conversation_id,
    receipt: r.receipt,
    resultCode: r.result_code,
    statusAttempts: Number(r.status_attempts),
    createdAt: new Date(r.created_at),
    resolvedAt: date(r.resolved_at),
  };
}

/** The PAYOUT_* event detail: payout id, amount, masked phone, what happened (never a name). */
export const payoutDetail = (p: Pick<PayoutRow, 'payoutId' | 'amount' | 'msisdn'>, what: string): string =>
  `payout ${p.payoutId} (KES ${p.amount} to ${maskMsisdn(p.msisdn)}): ${what}`;

async function event(db: Db, userId: string, p: PayoutRow, what: string): Promise<void> {
  await insertSubjectSecurityEvent(db, { type: 'PAYOUT_STATUS_CHANGED', userId, detail: payoutDetail(p, what) });
}

/** Claimable (part 2): HELD, not security-held, not frozen in a reported UFAA return (part 3b). Claims, reminders and UFAA dormancy all use it. */
export const CLAIMABLE = (e: string) =>
  `${e}.escrow_status = 'HELD' AND NOT ${e}.security_hold AND ${e}.gross_commission > 0 AND ${e}.ufaa_return_id IS NULL`;

/** Matured HELD escrows of the agent, not security-held, oldest first, in cents. */
export async function claimableEscrows(db: Db, agentId: string, lock = false): Promise<Array<{ escrowId: string; cents: number }>> {
  const { rows } = await db.query(
    `SELECT e.escrow_id, (e.gross_commission * 100)::bigint AS cents
       FROM escrow_accounts e JOIN transactions t USING (transaction_id)
      WHERE t.agent_id = $1 AND ${CLAIMABLE('e')} AND e.release_due_at <= NOW()
      ORDER BY e.release_due_at, e.escrow_id${lock ? ' FOR UPDATE OF e' : ''}`,
    [agentId]
  );
  return rows.map((r) => ({ escrowId: r.escrow_id, cents: Number(r.cents) }));
}

/** What GET /payouts shows besides history: carry, the ACTIVE destination, a change in flight. */
export async function payoutContext(db: Db, agentId: string): Promise<{ carryCents: number; active: { destinationId: string; msisdn: string } | null; changing: boolean }> {
  const [{ rows: [a] }, { rows: dests }] = await Promise.all([
    db.query(`SELECT payout_carry_cents FROM sales_agents WHERE agent_id = $1`, [agentId]),
    db.query(`SELECT destination_id, msisdn, status FROM payout_destinations WHERE agent_id = $1 AND status IN ('ACTIVE', 'PENDING_VERIFICATION', 'COOLING_OFF')`, [agentId]),
  ]);
  const active = dests.find((d) => d.status === 'ACTIVE');
  return {
    carryCents: Number(a?.payout_carry_cents ?? 0),
    active: active ? { destinationId: active.destination_id, msisdn: active.msisdn } : null,
    changing: dests.some((d) => d.status !== 'ACTIVE'),
  };
}

/**
 * The claim, in one transaction, BEFORE the B2C call: re-checks the agent (disabled, open payout),
 * the destination (ACTIVE, no replacement in flight) and the balance; inserts the SENT payout with
 * its consent hash; moves the selected escrows HELD → CLAIMED; writes the event.
 */
export async function createPayout(
  db: TxDb,
  c: { agentId: string; payoutId: string; acceptedAt: Date; disclosureVersion: string; disclosureText: string; minAmount: number; maxAmount: number }
): Promise<ClaimOutcome> {
  return withTransaction(db, async (tx) => {
    const escrows = await claimableEscrows(tx, c.agentId, true);
    const { rows: [agent] } = await tx.query(
      `SELECT a.user_id, a.payout_carry_cents, u.disabled_at IS NOT NULL AS disabled
         FROM sales_agents a JOIN users u ON u.user_id = a.user_id WHERE a.agent_id = $1 FOR UPDATE OF a`,
      [c.agentId]
    );
    if (!agent || agent.disabled) return { kind: 'disabled' } as const;
    const open = await tx.query(`SELECT 1 FROM payouts WHERE agent_id = $1 AND status IN ${OPEN}`, [c.agentId]);
    if (open.rows.length) return { kind: 'payout_in_progress' } as const;
    const { rows: dests } = await tx.query(
      `SELECT destination_id, msisdn, status FROM payout_destinations
        WHERE agent_id = $1 AND status IN ('ACTIVE', 'PENDING_VERIFICATION', 'COOLING_OFF')`,
      [c.agentId]
    );
    const active = dests.find((d) => d.status === 'ACTIVE');
    if (!active) return { kind: 'no_active_destination' } as const;
    // A replacement in flight may be a SIM-swap hijack: paying either phone could lose the money.
    if (dests.some((d) => d.status !== 'ACTIVE')) return { kind: 'destination_changing' } as const;

    const carryIn = Number(agent.payout_carry_cents);
    const split = splitClaim(escrows, carryIn, c.maxAmount);
    if (escrows.length > 0 && split.escrowIds.length === 0) return { kind: 'above_maximum' } as const;
    if (split.amount < c.minAmount || split.grossCents === 0) return { kind: 'below_minimum', amount: split.amount } as const;

    const hash = consentHash({
      agentId: c.agentId,
      payoutId: c.payoutId,
      msisdn: active.msisdn,
      amount: split.amount,
      disclosureVersion: c.disclosureVersion,
      disclosureText: c.disclosureText,
      acceptedAt: c.acceptedAt,
    });
    const { rows: [ins] } = await tx.query(
      `INSERT INTO payouts (payout_id, agent_id, destination_id, msisdn, amount, gross_cents, carry_in_cents, carry_out_cents,
                            disclosure_version, consent_hash, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${RETURNING}`,
      [c.payoutId, c.agentId, active.destination_id, active.msisdn, split.amount, split.grossCents, carryIn, split.carryOutCents,
       c.disclosureVersion, hash, c.acceptedAt.toISOString()]
    );
    await tx.query(`UPDATE escrow_accounts SET escrow_status = 'CLAIMED', payout_id = $1 WHERE escrow_id = ANY($2::uuid[])`, [c.payoutId, split.escrowIds]);
    const payout = toRow(ins);
    await event(tx, agent.user_id, payout, `claimed (${split.escrowIds.length} escrow(s), disclosure v${c.disclosureVersion}); payment requested`);
    return { kind: 'created', escrows: split.escrowIds.length, payout, userId: agent.user_id } as const;
  });
}

type Final = { status: 'PAID'; receipt: string | null; resultCode: string | null } | { status: 'FAILED'; reason: string; resultCode: string | null };

/**
 * PAID: escrows RELEASED, the agent's carry becomes carry_out. FAILED: escrows HELD again (or
 * QUARANTINED when security-held mid-flight), and a CLAWBACK_DUE / RELEASED_NOT_ON_STATEMENT
 * recorded for them is resolved (nothing was paid). The caller holds the payout row lock.
 */
async function finish(tx: PoolClient, cur: PayoutRow, userId: string, f: Final, what: string): Promise<PayoutRow> {
  const { rows: [upd] } = await tx.query(
    `UPDATE payouts SET status = $2, receipt = COALESCE($3, receipt), result_code = COALESCE($4, result_code), failure_reason = $5,
            resolved_at = NOW(), updated_at = NOW(), status_claimed_at = NULL, status_claim_token = NULL, next_status_at = NULL
      WHERE payout_id = $1 RETURNING ${RETURNING}`,
    [cur.payoutId, f.status, f.status === 'PAID' ? f.receipt : null, f.resultCode, f.status === 'FAILED' ? f.reason.slice(0, 40) : null]
  );
  if (f.status === 'PAID') {
    await tx.query(`UPDATE escrow_accounts SET escrow_status = 'RELEASED' WHERE payout_id = $1 AND escrow_status = 'CLAIMED'`, [cur.payoutId]);
    await tx.query(`UPDATE sales_agents SET payout_carry_cents = $2 WHERE agent_id = $1`, [cur.agentId, cur.carryOutCents]);
  } else {
    const { rows: back } = await tx.query(
      `UPDATE escrow_accounts
          SET escrow_status = CASE WHEN security_hold THEN 'QUARANTINED' ELSE 'HELD' END,
              quarantine_reason = CASE WHEN security_hold THEN 'security_hold' ELSE quarantine_reason END,
              payout_id = NULL
        WHERE payout_id = $1 AND escrow_status = 'CLAIMED' RETURNING escrow_id`,
      [cur.payoutId]
    );
    await tx.query(
      `UPDATE reconciliation_exceptions SET resolved_at = NOW(), detail = left(COALESCE(detail, '') || $2, 2000)
        WHERE escrow_id = ANY($1::uuid[]) AND resolved_at IS NULL`,
      [back.map((r) => r.escrow_id), ` [resolved: payout ${cur.payoutId} FAILED, nothing was paid]`]
    );
  }
  const payout = toRow(upd);
  await event(tx, userId, payout, what);
  return payout;
}

/** Locks one payout (by id, or by any Transaction Status query id it was issued) with its agent's user and name. */
async function lockPayout(tx: PoolClient, by: 'payout_id' | 'status_query_id', id: string) {
  const where = by === 'payout_id' ? 'p.payout_id = $1' : 'p.status_query_ids @> ARRAY[$1::uuid]';
  const { rows: [r] } = await tx.query(
    `SELECT ${COLS}, a.user_id, u.full_name FROM payouts p JOIN sales_agents a ON a.agent_id = p.agent_id JOIN users u ON u.user_id = a.user_id
      WHERE ${where} FOR UPDATE OF p`,
    [id]
  );
  return r ? { payout: toRow(r), userId: r.user_id as string, fullName: r.full_name as string } : null;
}

const isOpen = (s: PayoutStatus) => s === 'SENT' || s === 'UNKNOWN' || s === 'UNRESOLVED';

/**
 * A definitive result for a payout already PAID or FAILED: a contradicting one (PAID after FAILED is
 * a possible double payment) is recorded as a CONFLICT event; the status never changes.
 */
async function closed(tx: PoolClient, cur: { payout: PayoutRow; userId: string }, result: 'PAID' | 'FAILED' | null, via: string): Promise<ResultOutcome> {
  if (!result || result === cur.payout.status) return { kind: 'duplicate' };
  const conflict = `CONFLICT: ${result} ${via} for a ${cur.payout.status} payout${result === 'PAID' ? ' (possible double payment)' : ''}`;
  await event(tx, cur.userId, cur.payout, conflict);
  return { kind: 'duplicate', conflict };
}

async function paid(tx: PoolClient, cur: { payout: PayoutRow; userId: string; fullName: string }, receipt: string | null, resultCode: string, name: string | null, via: string) {
  const payout = await finish(tx, cur.payout, cur.userId, { status: 'PAID', receipt, resultCode }, `paid (${via}), receipt ${receipt ?? 'unknown'}`);
  // No name parameter is no evidence of drift.
  const nameMismatch = name !== null && !namesMatch(name, cur.fullName);
  if (nameMismatch) {
    await insertSubjectSecurityEvent(tx, {
      type: 'PAYOUT_NAME_MISMATCH',
      userId: cur.userId,
      detail: payoutDetail(payout, 'the M-Pesa registered name on the paid line no longer matches the agent name'),
    });
  }
  return { kind: 'applied', payout, userId: cur.userId, nameMismatch } as const;
}

/**
 * The synchronous B2C answer: ACCEPTED records the ConversationID; UNKNOWN moves SENT → UNKNOWN;
 * REJECTED (definitively not paid) → FAILED (`reason`) with the escrows released at once.
 * Null when the payout already moved on (a result raced ahead).
 */
export async function recordPayoutSend(db: TxDb, payoutId: string, outcome: B2cOutcome, failReason: string): Promise<PayoutChange | null> {
  return withTransaction(db, async (tx) => {
    const cur = await lockPayout(tx, 'payout_id', payoutId);
    if (!cur || cur.payout.status !== 'SENT') return null;
    if (outcome.kind === 'ACCEPTED') {
      const { rows: [r] } = await tx.query(
        `UPDATE payouts SET conversation_id = COALESCE(conversation_id, $2), updated_at = NOW() WHERE payout_id = $1 RETURNING ${RETURNING}`,
        [payoutId, outcome.conversationId]
      );
      return { payout: toRow(r), userId: cur.userId };
    }
    if (outcome.kind === 'UNKNOWN') {
      const { rows: [r] } = await tx.query(
        `UPDATE payouts SET status = 'UNKNOWN', last_status_result = $2, updated_at = NOW() WHERE payout_id = $1 RETURNING ${RETURNING}`,
        [payoutId, `send UNKNOWN (${outcome.code})`.slice(0, 500)]
      );
      const payout = toRow(r);
      await event(tx, cur.userId, payout, `send outcome unknown (${outcome.code}); never resent, Transaction Status will decide`);
      return { payout, userId: cur.userId };
    }
    const payout = await finish(tx, cur.payout, cur.userId, { status: 'FAILED', reason: failReason, resultCode: outcome.code.slice(0, 20) }, `failed (${failReason}); escrows claimable again`);
    return { payout, userId: cur.userId };
  });
}

/** A B2C result for a payout (by payout_id): applied at most once; PAID or FAILED are final. */
export async function applyPayoutResult(db: TxDb, result: B2cResult): Promise<ResultOutcome> {
  if (!UUID_RE.test(result.originatorConversationId)) return { kind: 'unknown' };
  return withTransaction(db, async (tx) => {
    const cur = await lockPayout(tx, 'payout_id', result.originatorConversationId);
    if (!cur) return { kind: 'unknown' } as const;
    // A result whose ConversationID contradicts the one Daraja gave us is not ours.
    if (cur.payout.conversationId && result.conversationId && cur.payout.conversationId !== result.conversationId) return { kind: 'unknown' } as const;
    if (!isOpen(cur.payout.status)) return closed(tx, cur, result.resultCode === '0' ? 'PAID' : 'FAILED', 'B2C result');
    if (result.resultCode === '0') return paid(tx, cur, result.receipt, '0', result.receiverName, 'B2C result');
    const reason = `b2c_${result.resultCode}`;
    const payout = await finish(tx, cur.payout, cur.userId, { status: 'FAILED', reason, resultCode: result.resultCode }, `failed (${reason}); escrows claimable again`);
    return { kind: 'applied', payout, userId: cur.userId } as const;
  });
}

/** A Transaction Status result (by status_query_id): PAID / FAILED are applied once; anything else is evidence only. */
export async function applyStatusResult(db: TxDb, r: TransactionStatusResult): Promise<ResultOutcome> {
  if (!UUID_RE.test(r.queryId)) return { kind: 'unknown' };
  return withTransaction(db, async (tx) => {
    const cur = await lockPayout(tx, 'status_query_id', r.queryId);
    if (!cur) return { kind: 'unknown' } as const;
    if (!isOpen(cur.payout.status)) return closed(tx, cur, r.outcome === 'PENDING' ? null : r.outcome, 'Transaction Status result');
    if (r.outcome === 'PAID') return paid(tx, cur, r.receipt, '0', r.receiverName, 'Transaction Status');
    if (r.outcome === 'FAILED') {
      const reason = `ts_${r.transactionStatus.toLowerCase()}`;
      const payout = await finish(tx, cur.payout, cur.userId, { status: 'FAILED', reason, resultCode: r.resultCode }, `failed (${reason}); escrows claimable again`);
      return { kind: 'applied', payout, userId: cur.userId } as const;
    }
    await tx.query(`UPDATE payouts SET last_status_result = $2, updated_at = NOW() WHERE payout_id = $1`, [
      cur.payout.payoutId,
      `TS ResultCode ${r.resultCode} ${r.transactionStatus}`.trim().slice(0, 500),
    ]);
    return { kind: 'pending' } as const;
  });
}

/**
 * Leases SENT / UNKNOWN payouts older than `afterMs` that are due a Transaction Status query
 * (fresh claim token and query id; attempts counted on the lease). Pattern of claimReconcileBatch.
 */
export async function leaseStatusChecks(db: Db, q: { limit: number; afterMs: number; maxAttempts: number; leaseMs: number }): Promise<StatusLease[]> {
  const { rows } = await db.query(
    `UPDATE payouts c
        SET status_claimed_at = NOW(), status_claim_token = gen_random_uuid(), status_query_ids = c.status_query_ids || gen_random_uuid(),
            status_attempts = c.status_attempts + 1, updated_at = NOW()
      WHERE c.payout_id IN (
            SELECT p.payout_id FROM payouts p
             WHERE p.status IN ('SENT', 'UNKNOWN')
               AND p.created_at < NOW() - make_interval(secs => $2::double precision / 1000)
               AND COALESCE(p.next_status_at, '-infinity'::timestamptz) <= NOW()
               AND p.status_attempts < $3
               AND (p.status_claimed_at IS NULL OR p.status_claimed_at < NOW() - make_interval(secs => $4::double precision / 1000))
             ORDER BY p.created_at
             LIMIT $1
             FOR UPDATE OF p SKIP LOCKED)
      RETURNING c.payout_id, c.status_query_ids[array_length(c.status_query_ids, 1)] AS query_id, c.status_claim_token, c.status_attempts`,
    [q.limit, q.afterMs, q.maxAttempts, q.leaseMs]
  );
  return rows.map((r) => ({ payoutId: r.payout_id, queryId: r.query_id, token: r.status_claim_token, attempts: Number(r.status_attempts) }));
}

/**
 * Ends our lease: the next query no earlier than `delayMs` from now (the answer may still arrive).
 * `refund` gives the attempt back (the query was never sent), as releaseReconcileLease does.
 */
export async function releaseStatusLease(db: Db, lease: StatusLease, delayMs: number, evidence: string, refund = false): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE payouts SET status_claimed_at = NULL, status_claim_token = NULL,
            next_status_at = NOW() + make_interval(secs => $3::double precision / 1000),
            status_attempts = GREATEST(status_attempts - CASE WHEN $5::boolean THEN 1 ELSE 0 END, 0),
            last_status_result = $4, updated_at = NOW()
      WHERE payout_id = $1 AND status_claim_token = $2`,
    [lease.payoutId, lease.token, Math.max(0, delayMs), evidence.slice(0, 500), refund]
  );
  return rowCount === 1;
}

/**
 * SENT / UNKNOWN payouts whose last Transaction Status attempt has had its window with no definitive
 * answer → UNRESOLVED (still open: no new claim until an answer or `payout:resolve`).
 */
export async function exhaustStatusChecks(db: TxDb, q: { maxAttempts: number; leaseMs: number }): Promise<PayoutChange[]> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE payouts c SET status = 'UNRESOLVED', status_claimed_at = NULL, status_claim_token = NULL, updated_at = NOW(), unresolved_at = NOW()
         FROM sales_agents a
        WHERE a.agent_id = c.agent_id AND c.payout_id IN (
              SELECT p.payout_id FROM payouts p
               WHERE p.status IN ('SENT', 'UNKNOWN') AND p.status_attempts >= $1
                 AND COALESCE(p.next_status_at, '-infinity'::timestamptz) <= NOW()
                 AND (p.status_claimed_at IS NULL OR p.status_claimed_at < NOW() - make_interval(secs => $2::double precision / 1000))
               FOR UPDATE OF p SKIP LOCKED)
        RETURNING ${COLS.replace(/p\./g, 'c.')}, a.user_id`,
      [q.maxAttempts, q.leaseMs]
    );
    const changes: PayoutChange[] = [];
    for (const r of rows) {
      const payout = toRow(r);
      await event(tx, r.user_id, payout, `unresolved after ${payout.statusAttempts} Transaction Status attempt(s); admin must resolve (payout:resolve)`);
      changes.push({ payout, userId: r.user_id });
    }
    return changes;
  });
}

/** `npm run payout:resolve`: an admin settles an UNRESOLVED payout from M-Pesa evidence. */
export async function resolvePayout(
  db: TxDb,
  id: string,
  o: { paid: true; receipt: string } | { paid: false },
  operator = 'unknown'
): Promise<{ kind: 'not_found' } | { kind: 'not_unresolved'; status: PayoutStatus } | ({ kind: 'resolved' } & PayoutChange)> {
  if (!UUID_RE.test(id)) return { kind: 'not_found' };
  return withTransaction(db, async (tx) => {
    const cur = await lockPayout(tx, 'payout_id', id);
    if (!cur) return { kind: 'not_found' } as const;
    if (cur.payout.status !== 'UNRESOLVED') return { kind: 'not_unresolved', status: cur.payout.status } as const;
    const payout = o.paid
      ? await finish(tx, cur.payout, cur.userId, { status: 'PAID', receipt: o.receipt, resultCode: null }, `paid (resolved by admin ${operator}), receipt ${o.receipt}`)
      : await finish(tx, cur.payout, cur.userId, { status: 'FAILED', reason: 'admin_failed', resultCode: null }, `failed (resolved by admin ${operator}); escrows claimable again`);
    return { kind: 'resolved', payout, userId: cur.userId } as const;
  });
}

export interface DueReminder {
  agentId: string;
  /** The login phone (users.phone_number). */
  phone: string;
  /** Claimable gross plus the carry, in cents. */
  cents: number;
  /** 1..3: the stage just recorded (the highest reached; lower missed ones are never sent). */
  stage: number;
  hasActiveDestination: boolean;
}


/**
 * Unclaimed reminders (spec gh-11, part 3a), claimed in ONE statement: per agent, the oldest
 * claimable escrow (claimableEscrows order) keys the cycle; the highest stage whose day threshold
 * its release_due_at has passed, above every stage stored on the agent's HELD / QUARANTINED escrows,
 * is written onto it (FOR UPDATE SKIP
 * LOCKED, so two sweeps never both get it). Skips disabled users, agents with an open payout, and
 * floor(balance) below `minAmount`. A claim moves that escrow out of HELD, so the next cycle keys a
 * new escrow at stage 0; a FAILED payout returns it with its stage, so nothing repeats.
 */
export async function dueReminders(db: Db, q: { stages: readonly number[]; minAmount: number; limit: number }): Promise<DueReminder[]> {
  const { rows } = await db.query(
    `WITH due AS (
       SELECT e.escrow_id, t.agent_id, u.phone_number, s.stage, b.cents,
              EXISTS (SELECT 1 FROM payout_destinations d WHERE d.agent_id = t.agent_id AND d.status = 'ACTIVE') AS has_dest
         FROM escrow_accounts e
         JOIN transactions t USING (transaction_id)
         JOIN sales_agents a ON a.agent_id = t.agent_id
         JOIN users u ON u.user_id = a.user_id
         CROSS JOIN LATERAL (SELECT max(d.i)::int AS stage FROM unnest($1::int[]) WITH ORDINALITY d(days, i)
                              WHERE e.release_due_at <= NOW() - make_interval(days => d.days)) s
         CROSS JOIN LATERAL (SELECT (sum((c.gross_commission * 100)::bigint) + a.payout_carry_cents)::bigint AS cents
                               FROM escrow_accounts c JOIN transactions ct USING (transaction_id)
                              WHERE ct.agent_id = t.agent_id AND ${CLAIMABLE('c')} AND c.release_due_at <= NOW()) b
        WHERE ${CLAIMABLE('e')}
          AND e.release_due_at <= NOW() - make_interval(days => ($1::int[])[1])
          -- Against every stage still on the agent's unclaimed escrows: a key escrow leaving the claimable
          -- set (security hold, QUARANTINED) must not let the next one resend a stage. e's own stage is
          -- re-checked on the locked row, so concurrent sweeps stay exclusive.
          AND s.stage > GREATEST(e.unclaimed_reminder_stage, (
                SELECT max(m.unclaimed_reminder_stage) FROM escrow_accounts m JOIN transactions mt USING (transaction_id)
                 WHERE mt.agent_id = t.agent_id AND m.escrow_status IN ('HELD', 'QUARANTINED') AND m.ufaa_return_id IS NULL))
          AND NOT EXISTS (SELECT 1 FROM escrow_accounts o JOIN transactions ot USING (transaction_id)
                           WHERE ot.agent_id = t.agent_id AND ${CLAIMABLE('o')} AND (o.release_due_at, o.escrow_id) < (e.release_due_at, e.escrow_id))
          AND u.disabled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.agent_id = t.agent_id AND p.status IN ${OPEN})
          AND b.cents / 100 >= $2
        ORDER BY e.release_due_at
        LIMIT $3
        FOR UPDATE OF e SKIP LOCKED)
     UPDATE escrow_accounts x SET unclaimed_reminder_stage = due.stage FROM due WHERE x.escrow_id = due.escrow_id
     RETURNING due.agent_id, due.phone_number, due.cents, due.stage, due.has_dest`,
    [q.stages, q.minAmount, q.limit]
  );
  return rows.map((r) => ({ agentId: r.agent_id, phone: r.phone_number, cents: Number(r.cents), stage: Number(r.stage), hasActiveDestination: r.has_dest }));
}

/** The agent's most recent payouts, newest first. */
export async function listPayouts(db: Db, agentId: string, limit = 20): Promise<PayoutRow[]> {
  const { rows } = await db.query(`SELECT ${COLS} FROM payouts p WHERE p.agent_id = $1 ORDER BY p.created_at DESC LIMIT $2`, [agentId, limit]);
  return rows.map(toRow);
}

/** Health: payouts by status. */
export async function payoutStats(db: Db): Promise<Record<PayoutStatus, number>> {
  const { rows } = await db.query<{ status: PayoutStatus; n: number }>(`SELECT status, count(*)::int AS n FROM payouts GROUP BY status`);
  const out: Record<PayoutStatus, number> = { SENT: 0, UNKNOWN: 0, PAID: 0, FAILED: 0, UNRESOLVED: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
