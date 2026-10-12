/**
 * @file payout_destination.repository.ts
 * @description SQL for verified payout destinations (spec gh-11). Every state change and its
 * PAYOUT_DESTINATION_CHANGED security event commit together. At most one ACTIVE and one in-flight
 * (PENDING_VERIFICATION / COOLING_OFF) row per agent is enforced by partial unique indexes.
 */

import type { QueryResultRow } from 'pg';
import type { B2cOutcome, B2cResult } from '../daraja/client';
import { maskMsisdn, namesMatch, type DestinationStatus } from '../domain/payout_destination';
import { withTransaction, type Db, type TxDb } from './db.types';
import { insertSubjectSecurityEvent } from './security.repository';

export interface DestinationRow {
  destinationId: string;
  agentId: string;
  msisdn: string;
  status: DestinationStatus;
  rejectReason: string | null;
  conversationId: string | null;
  resultCode: string | null;
  sentAt: Date;
  verifiedAt: Date | null;
  coolingOffUntil: Date | null;
  createdAt: Date;
}

/** A changed row and the user to alert (the agent's login user). */
export interface DestinationChange {
  destination: DestinationRow;
  userId: string | null;
  /** promoteDue: the agent's previous ACTIVE row, now SUPERSEDED (its phone gets an alert too). */
  superseded?: DestinationRow | null;
}

export type ApplyOutcome =
  | { kind: 'unknown' }
  | { kind: 'duplicate' }
  /** A result for an EXPIRED row: recorded (result_code + event), status unchanged. */
  | { kind: 'late' }
  | { kind: 'applied'; destination: DestinationRow; userId: string | null };

export type CancelOutcome = { kind: 'cancelled'; destination: DestinationRow } | { kind: 'not_found' } | { kind: 'not_cancellable' };

export interface DestinationEvent {
  detail: string;
  detectedAt: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = `destination_id, agent_id, msisdn, status, reject_reason, conversation_id, result_code,
              sent_at, verified_at, cooling_off_until, created_at`;
const OPEN = `('ACTIVE', 'PENDING_VERIFICATION', 'COOLING_OFF')`;

const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);
function toRow(r: QueryResultRow): DestinationRow {
  return {
    destinationId: r.destination_id,
    agentId: r.agent_id,
    msisdn: r.msisdn,
    status: r.status,
    rejectReason: r.reject_reason,
    conversationId: r.conversation_id,
    resultCode: r.result_code,
    sentAt: new Date(r.sent_at),
    verifiedAt: date(r.verified_at),
    coolingOffUntil: date(r.cooling_off_until),
    createdAt: new Date(r.created_at),
  };
}

/** The PAYOUT_DESTINATION_CHANGED detail: destination id, masked phone, what happened. */
export const eventDetail = (d: Pick<DestinationRow, 'destinationId' | 'msisdn'>, what: string): string =>
  `destination ${d.destinationId} (${maskMsisdn(d.msisdn)}): ${what}`;

async function event(db: Db, userId: string | null, d: DestinationRow, what: string): Promise<void> {
  await insertSubjectSecurityEvent(db, { type: 'PAYOUT_DESTINATION_CHANGED', userId, detail: eventDetail(d, what) });
}

/** The agent's ACTIVE and in-flight destinations. */
export async function findOpenDestinations(db: Db, agentId: string): Promise<DestinationRow[]> {
  const { rows } = await db.query(`SELECT ${COLS} FROM payout_destinations WHERE agent_id = $1 AND status IN ${OPEN}`, [agentId]);
  return rows.map(toRow);
}

/**
 * Records a new PENDING_VERIFICATION destination (its id becomes the OriginatorConversationID)
 * BEFORE the B2C call, with its registration event. Null when another in-flight row exists
 * (including one inserted concurrently).
 */
export async function claimDestination(db: TxDb, c: { agentId: string; userId: string; msisdn: string }): Promise<DestinationRow | null> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO payout_destinations (agent_id, msisdn) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING ${COLS}`,
      [c.agentId, c.msisdn]
    );
    if (!rows[0]) return null;
    const d = toRow(rows[0]);
    await event(tx, c.userId, d, 'registered; verification payment requested');
    return d;
  });
}

/**
 * The synchronous B2C answer: ACCEPTED records the ConversationID; REJECTED (definitive, nothing
 * paid) rejects a still-pending row; UNKNOWN changes nothing (the result or the sweep decides).
 */
export async function recordB2cOutcome(db: TxDb, id: string, userId: string, outcome: B2cOutcome): Promise<DestinationRow | null> {
  if (outcome.kind === 'ACCEPTED') {
    const { rows } = await db.query(
      `UPDATE payout_destinations SET conversation_id = COALESCE(conversation_id, $2), updated_at = NOW()
        WHERE destination_id = $1 RETURNING ${COLS}`,
      [id, outcome.conversationId]
    );
    return rows[0] ? toRow(rows[0]) : null;
  }
  if (outcome.kind === 'UNKNOWN') return null;
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE payout_destinations SET status = 'REJECTED', reject_reason = $2, result_code = $3, updated_at = NOW()
        WHERE destination_id = $1 AND status = 'PENDING_VERIFICATION' RETURNING ${COLS}`,
      [id, `b2c_${outcome.code}`.slice(0, 40), outcome.code.slice(0, 20)]
    );
    if (!rows[0]) return null;
    const d = toRow(rows[0]);
    await event(tx, userId, d, `rejected (${d.rejectReason})`);
    return d;
  });
}

/**
 * Applies a B2C result at most once (the row must still be PENDING_VERIFICATION, locked): a failed
 * payment or a name that does not match users.full_name → REJECTED; a match → ACTIVE, or
 * COOLING_OFF for `coolingOffMs` when the agent already has an ACTIVE destination (a replacement).
 */
export async function applyVerificationResult(db: TxDb, result: B2cResult, coolingOffMs: number): Promise<ApplyOutcome> {
  if (!UUID_RE.test(result.originatorConversationId)) return { kind: 'unknown' };
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT d.status, d.agent_id, d.conversation_id, a.user_id, u.full_name
         FROM payout_destinations d JOIN sales_agents a ON a.agent_id = d.agent_id JOIN users u ON u.user_id = a.user_id
        WHERE d.destination_id = $1 FOR UPDATE OF d`,
      [result.originatorConversationId]
    );
    const cur = rows[0];
    if (!cur) return { kind: 'unknown' } as const;
    if (cur.status === 'EXPIRED') {
      // The verification was paid after all: keep the row EXPIRED but record the result once.
      const { rows: late } = await tx.query(
        `UPDATE payout_destinations SET result_code = $2, conversation_id = COALESCE(conversation_id, $3), updated_at = NOW()
          WHERE destination_id = $1 AND result_code IS NULL RETURNING ${COLS}`,
        [result.originatorConversationId, result.resultCode, result.conversationId]
      );
      if (!late[0]) return { kind: 'duplicate' } as const;
      await event(tx, cur.user_id, toRow(late[0]), `late B2C result after expiry, ResultCode ${result.resultCode}`);
      return { kind: 'late' } as const;
    }
    if (cur.status !== 'PENDING_VERIFICATION') return { kind: 'duplicate' } as const;
    // A result whose ConversationID contradicts the one Daraja gave us is not ours.
    if (cur.conversation_id && result.conversationId && cur.conversation_id !== result.conversationId) return { kind: 'unknown' } as const;

    let status: DestinationStatus = 'REJECTED';
    let reason: string | null = null;
    let coolingOff = false;
    if (result.resultCode !== '0') reason = `b2c_${result.resultCode}`.slice(0, 40);
    else if (!namesMatch(result.receiverName, cur.full_name)) reason = 'name_mismatch';
    else {
      const active = await tx.query(`SELECT 1 FROM payout_destinations WHERE agent_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [cur.agent_id]);
      coolingOff = active.rows.length > 0;
      status = coolingOff ? 'COOLING_OFF' : 'ACTIVE';
    }
    const { rows: upd } = await tx.query(
      `UPDATE payout_destinations
          SET status = $2, reject_reason = $3, result_code = $4, conversation_id = COALESCE(conversation_id, $5),
              verified_at = CASE WHEN $6::boolean THEN NOW() END,
              cooling_off_until = NOW() + make_interval(secs => $7::double precision / 1000),
              updated_at = NOW()
        WHERE destination_id = $1 RETURNING ${COLS}`,
      [result.originatorConversationId, status, reason, result.resultCode, result.conversationId, reason === null, coolingOff ? coolingOffMs : null]
    );
    const d = toRow(upd[0]);
    const what =
      status === 'ACTIVE' ? 'verified; active' : status === 'COOLING_OFF' ? `verified; replacement cooling off until ${d.coolingOffUntil!.toISOString()}` : `rejected (${reason})`;
    await event(tx, cur.user_id, d, what);
    return { kind: 'applied', destination: d, userId: cur.user_id } as const;
  });
}

/** COOLING_OFF rows past cooling_off_until become ACTIVE; the agent's previous ACTIVE row SUPERSEDED. */
export async function promoteDue(db: TxDb, limit = 100): Promise<DestinationChange[]> {
  return withTransaction(db, async (tx) => {
    const { rows: due } = await tx.query(
      `SELECT d.destination_id, d.agent_id, a.user_id FROM payout_destinations d JOIN sales_agents a ON a.agent_id = d.agent_id
        WHERE d.status = 'COOLING_OFF' AND d.cooling_off_until <= NOW()
        ORDER BY d.cooling_off_until LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
      [limit]
    );
    if (due.length === 0) return [];
    const userOf = new Map<string, string>(due.map((r) => [r.agent_id, r.user_id]));
    // Supersede first: the one-ACTIVE-per-agent index is checked row by row.
    const { rows: old } = await tx.query(
      `UPDATE payout_destinations SET status = 'SUPERSEDED', updated_at = NOW()
        WHERE agent_id = ANY($1::uuid[]) AND status = 'ACTIVE' RETURNING ${COLS}`,
      [[...userOf.keys()]]
    );
    const supersededOf = new Map<string, DestinationRow>();
    for (const r of old.map(toRow)) {
      supersededOf.set(r.agentId, r);
      await event(tx, userOf.get(r.agentId) ?? null, r, 'superseded by a replacement');
    }
    const { rows } = await tx.query(
      `UPDATE payout_destinations SET status = 'ACTIVE', updated_at = NOW()
        WHERE destination_id = ANY($1::uuid[]) AND status = 'COOLING_OFF' RETURNING ${COLS}`,
      [due.map((r) => r.destination_id)]
    );
    const changes: DestinationChange[] = [];
    for (const d of rows.map(toRow)) {
      const userId = userOf.get(d.agentId) ?? null;
      await event(tx, userId, d, 'cooling-off ended; active');
      changes.push({ destination: d, userId, superseded: supersededOf.get(d.agentId) ?? null });
    }
    return changes;
  });
}

/** PENDING_VERIFICATION rows sent more than `olderThanMs` ago with no result become EXPIRED. */
export async function expireStale(db: TxDb, olderThanMs: number, limit = 100): Promise<DestinationChange[]> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE payout_destinations d SET status = 'EXPIRED', reject_reason = 'no_result', updated_at = NOW()
         FROM sales_agents a
        WHERE a.agent_id = d.agent_id AND d.destination_id IN (
              SELECT destination_id FROM payout_destinations
               WHERE status = 'PENDING_VERIFICATION' AND sent_at < NOW() - make_interval(secs => $1::double precision / 1000)
               ORDER BY sent_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING d.destination_id, d.agent_id, d.msisdn, d.status, d.reject_reason, d.conversation_id, d.result_code,
                  d.sent_at, d.verified_at, d.cooling_off_until, d.created_at, a.user_id`,
      [olderThanMs, limit]
    );
    const changes: DestinationChange[] = [];
    for (const r of rows) {
      const d = toRow(r);
      await event(tx, r.user_id, d, 'expired (no B2C result)');
      changes.push({ destination: d, userId: r.user_id });
    }
    return changes;
  });
}

/**
 * Cancels a COOLING_OFF destination: the agent's own (`agentId`), or any one by an admin
 * (`agentId` null, `npm run payout:cancel`).
 */
export async function cancelCoolingOff(db: TxDb, id: string, by: { agentId: string } | { admin: true }): Promise<CancelOutcome> {
  if (!UUID_RE.test(id)) return { kind: 'not_found' };
  const agentId = 'agentId' in by ? by.agentId : null;
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT d.status, a.user_id FROM payout_destinations d JOIN sales_agents a ON a.agent_id = d.agent_id
        WHERE d.destination_id = $1 AND ($2::uuid IS NULL OR d.agent_id = $2::uuid) FOR UPDATE OF d`,
      [id, agentId]
    );
    if (!rows[0]) return { kind: 'not_found' } as const;
    if (rows[0].status !== 'COOLING_OFF') return { kind: 'not_cancellable' } as const;
    const who = agentId ? 'agent' : 'admin';
    const { rows: upd } = await tx.query(
      `UPDATE payout_destinations SET status = 'CANCELLED', reject_reason = $2, updated_at = NOW()
        WHERE destination_id = $1 RETURNING ${COLS}`,
      [id, `cancelled_by_${who}`]
    );
    const d = toRow(upd[0]);
    await event(tx, rows[0].user_id, d, `cancelled by ${who === 'agent' ? 'the agent' : 'admin'} during cooling-off`);
    return { kind: 'cancelled', destination: d } as const;
  });
}

/** The agent's most recent destinations, newest first. */
export async function listDestinations(db: Db, agentId: string, limit = 20): Promise<DestinationRow[]> {
  const { rows } = await db.query(`SELECT ${COLS} FROM payout_destinations WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`, [agentId, limit]);
  return rows.map(toRow);
}

/** The user's most recent PAYOUT_DESTINATION_CHANGED events (the in-app alert list). */
export async function listDestinationEvents(db: Db, userId: string, limit = 20): Promise<DestinationEvent[]> {
  const { rows } = await db.query(
    `SELECT detail, detected_at FROM security_events
      WHERE subject_user_id = $1 AND event_type = 'PAYOUT_DESTINATION_CHANGED'
      ORDER BY detected_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => ({ detail: r.detail, detectedAt: new Date(r.detected_at) }));
}
