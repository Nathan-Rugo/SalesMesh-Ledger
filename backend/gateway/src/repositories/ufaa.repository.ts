/**
 * @file ufaa.repository.ts
 * @description SQL for the annual UFAA return (spec gh-11, part 3b). A return is fenced by its
 * status (DRAFT → NOTICED → REPORTED → REMITTED); each step locks the return row. Until the report an
 * item (one per agent) is dropped once any of its escrows leaves the claimable set (a claim wins). The
 * report freezes the live items' escrows (ufaa_return_id, which takes them out of CLAIMABLE), locking
 * them in claimableEscrows order as a claim does, so an escrow ends CLAIMED or frozen, never both.
 * Remit turns only frozen HELD rows REMITTED, per escrow; a frozen escrow is never unfrozen.
 */

import type { PoolClient, QueryResultRow } from 'pg';
import { maskMsisdn } from '../domain/payout_destination';
import { withTransaction, type Db, type TxDb } from './db.types';
import { CLAIMABLE } from './payout.repository';
import { insertSubjectSecurityEvent, type SecurityEventType } from './security.repository';

export type UfaaStatus = 'DRAFT' | 'NOTICED' | 'REPORTED' | 'REMITTED';

export interface UfaaReturn {
  returnId: string;
  /** YYYY-MM-DD (a 30 June). */
  periodEnd: string;
  status: UfaaStatus;
  noticedAt: Date | null;
  reportedAt: Date | null;
  remittedAt: Date | null;
  reference: string | null;
  reportPath: string | null;
  noticedCents: number;
  noticedItems: number;
  reportedCents: number | null;
  reportedItems: number | null;
  remittedCents: number | null;
  remittedItems: number | null;
}

export interface UfaaItem {
  /** The holder reference in the report. */
  itemId: string;
  agentId: string;
  userId: string;
  escrowIds: string[];
  amountCents: number;
  ownerName: string;
  msisdn: string;
  /** The oldest escrow's release_due_at. */
  payableFrom: Date;
  /** sales_agents.ufaa_owner_no: the serial in the report's ID number. */
  ownerNo: number;
}

const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const RET = `return_id, period_end::text AS period_end, status, noticed_at, reported_at, remitted_at, remittance_reference, report_path,
             noticed_cents, noticed_items, reported_cents, reported_items, remitted_cents, remitted_items`;
const ITEM = `i.item_id, i.agent_id, a.user_id, i.escrow_ids, i.amount_cents, i.owner_name, i.msisdn, i.payable_from, a.ufaa_owner_no`;
const ITEM_FROM = `ufaa_return_items i JOIN sales_agents a ON a.agent_id = i.agent_id`;

function toReturn(r: QueryResultRow): UfaaReturn {
  return {
    returnId: r.return_id,
    periodEnd: r.period_end,
    status: r.status,
    noticedAt: date(r.noticed_at),
    reportedAt: date(r.reported_at),
    remittedAt: date(r.remitted_at),
    reference: r.remittance_reference,
    reportPath: r.report_path,
    noticedCents: Number(r.noticed_cents),
    noticedItems: Number(r.noticed_items),
    reportedCents: num(r.reported_cents),
    reportedItems: num(r.reported_items),
    remittedCents: num(r.remitted_cents),
    remittedItems: num(r.remitted_items),
  };
}

function toItem(r: QueryResultRow): UfaaItem {
  return {
    itemId: r.item_id,
    agentId: r.agent_id,
    userId: r.user_id,
    escrowIds: r.escrow_ids,
    amountCents: Number(r.amount_cents),
    ownerName: r.owner_name,
    msisdn: r.msisdn,
    payableFrom: new Date(r.payable_from),
    ownerNo: Number(r.ufaa_owner_no),
  };
}

/** KES with two decimals from integer cents (no floating-point money). */
export const kes = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

async function event(db: Db, type: SecurityEventType, ret: Pick<UfaaReturn, 'periodEnd'>, item: UfaaItem, what: string): Promise<void> {
  await insertSubjectSecurityEvent(db, {
    type,
    userId: item.userId,
    detail: `UFAA return ${ret.periodEnd} item ${item.itemId} (KES ${kes(item.amountCents)}, ${maskMsisdn(item.msisdn)}): ${what}`,
  });
}

/**
 * Dormant commission per agent: claimable escrows (HELD, not security-held, not frozen) whose
 * release_due_at is before the end of `periodEnd` (Africa/Nairobi) minus `years` calendar years, and not in a
 * live item of another return that is not REMITTED (one escrow, one return).
 */
export async function dormantByAgent(db: Db, periodEnd: string, years: number) {
  const { rows } = await db.query(
    `SELECT t.agent_id, array_agg(e.escrow_id ORDER BY e.release_due_at, e.escrow_id) AS escrow_ids,
            sum((e.gross_commission * 100)::bigint) AS cents, min(e.release_due_at) AS payable_from,
            u.full_name, u.phone_number
       FROM escrow_accounts e JOIN transactions t USING (transaction_id)
       JOIN sales_agents a ON a.agent_id = t.agent_id JOIN users u ON u.user_id = a.user_id
      WHERE ${CLAIMABLE('e')}
        AND e.release_due_at < ((($1::date + 1)::timestamp - make_interval(years => $2::int)) AT TIME ZONE 'Africa/Nairobi')
        AND NOT EXISTS (SELECT 1 FROM ufaa_return_items oi JOIN ufaa_returns o USING (return_id)
                         WHERE o.status <> 'REMITTED' AND oi.dropped_at IS NULL AND e.escrow_id = ANY(oi.escrow_ids))
      GROUP BY t.agent_id, u.full_name, u.phone_number
      ORDER BY t.agent_id`,
    [periodEnd, years]
  );
  return rows.map((r) => ({
    agentId: r.agent_id as string,
    escrowIds: r.escrow_ids as string[],
    cents: Number(r.cents),
    payableFrom: new Date(r.payable_from),
    ownerName: r.full_name as string,
    msisdn: r.phone_number as string,
  }));
}

/**
 * The DRAFT return for the period with one item per agent holding dormant commission, in one
 * transaction. `exists` when the period already has a return (DRAFT is resumed by the caller);
 * `nothing` (and nothing written) when no commission is dormant.
 */
export async function createReturn(
  db: TxDb,
  periodEnd: string,
  years: number
): Promise<{ kind: 'nothing' } | { kind: 'exists' | 'created'; ret: UfaaReturn }> {
  return withTransaction(db, async (tx) => {
    const existing = async () => (await tx.query(`SELECT ${RET} FROM ufaa_returns WHERE period_end = $1`, [periodEnd])).rows[0];
    const found = await existing();
    if (found) return { kind: 'exists', ret: toReturn(found) } as const;
    const dormant = await dormantByAgent(tx, periodEnd, years);
    if (!dormant.length) return { kind: 'nothing' } as const;
    const { rows: [ins] } = await tx.query(
      `INSERT INTO ufaa_returns (period_end, noticed_cents, noticed_items) VALUES ($1, $2, $3)
       ON CONFLICT (period_end) DO NOTHING RETURNING ${RET}`,
      [periodEnd, dormant.reduce((s, d) => s + d.cents, 0), dormant.length]
    );
    // A concurrent prepare created it first.
    if (!ins) return { kind: 'exists', ret: toReturn(await existing()) } as const;
    for (const d of dormant) {
      await tx.query(
        `INSERT INTO ufaa_return_items (return_id, agent_id, escrow_ids, amount_cents, owner_name, msisdn, payable_from)
         VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7)`,
        [ins.return_id, d.agentId, d.escrowIds, d.cents, d.ownerName, d.msisdn, d.payableFrom.toISOString()]
      );
    }
    return { kind: 'created', ret: toReturn(ins) } as const;
  });
}

/** Items of a DRAFT return whose notice has not been sent yet. */
export async function pendingNotices(db: Db, returnId: string): Promise<UfaaItem[]> {
  const { rows } = await db.query(
    `SELECT ${ITEM} FROM ${ITEM_FROM} WHERE i.return_id = $1 AND i.notice_sent_at IS NULL AND i.dropped_at IS NULL ORDER BY i.item_id`,
    [returnId]
  );
  return rows.map(toItem);
}

/** Records one sent notice and its UFAA_NOTICE_SENT event, together. */
export async function recordNotice(db: TxDb, ret: UfaaReturn, item: UfaaItem, at: Date, what: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const { rowCount } = await tx.query(`UPDATE ufaa_return_items SET notice_sent_at = $2 WHERE item_id = $1 AND notice_sent_at IS NULL`, [item.itemId, at.toISOString()]);
    if (rowCount) await event(tx, 'UFAA_NOTICE_SENT', ret, item, what);
  });
}

/**
 * DRAFT → NOTICED once every live item has its notice; noticed_at is the last notice (the 60-day
 * clock), or now when every item was dropped before its notice.
 */
export async function markNoticed(db: Db, returnId: string, at: Date): Promise<UfaaReturn | null> {
  const { rows: [r] } = await db.query(
    `UPDATE ufaa_returns r SET status = 'NOTICED',
            noticed_at = COALESCE((SELECT max(notice_sent_at) FROM ufaa_return_items WHERE return_id = r.return_id), $2::timestamptz)
      WHERE r.return_id = $1 AND r.status = 'DRAFT'
        AND NOT EXISTS (SELECT 1 FROM ufaa_return_items WHERE return_id = r.return_id AND notice_sent_at IS NULL AND dropped_at IS NULL)
      RETURNING ${RET}`,
    [returnId, at.toISOString()]
  );
  return r ? toReturn(r) : null;
}

/** The largest owner serial among the return's live items (null: none), checked before the report writes. */
export async function maxOwnerNo(db: Db, returnId: string): Promise<number | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(returnId)) return null;
  const { rows: [r] } = await db.query(
    `SELECT max(a.ufaa_owner_no) AS n FROM ufaa_return_items i JOIN sales_agents a USING (agent_id) WHERE i.return_id = $1 AND i.dropped_at IS NULL`,
    [returnId]
  );
  return r?.n === null || r?.n === undefined ? null : Number(r.n);
}

/** Locks a return (by id) for a step; null when there is none. */
async function lockReturn(tx: PoolClient, returnId: string): Promise<UfaaReturn | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(returnId)) return null;
  const { rows: [r] } = await tx.query(`SELECT ${RET} FROM ufaa_returns WHERE return_id = $1 FOR UPDATE`, [returnId]);
  return r ? toReturn(r) : null;
}

/**
 * Drops (dropped_at) every item of the return with an escrow no longer claimable, and returns the
 * items still live. Unlocked: the report re-checks each item under its escrow locks.
 */
export async function liveItems(db: Db, returnId: string, at: Date): Promise<UfaaItem[]> {
  await db.query(
    `UPDATE ufaa_return_items i SET dropped_at = $2
      WHERE i.return_id = $1 AND i.dropped_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest(i.escrow_ids) x(id) LEFT JOIN escrow_accounts e ON e.escrow_id = x.id
                     WHERE e.escrow_id IS NULL OR NOT (${CLAIMABLE('e')}))`,
    [returnId, at.toISOString()]
  );
  const { rows } = await db.query(`SELECT ${ITEM} FROM ${ITEM_FROM} WHERE i.return_id = $1 AND i.dropped_at IS NULL ORDER BY i.payable_from, i.item_id`, [returnId]);
  return rows.map(toItem);
}

const drop = (tx: PoolClient, item: UfaaItem, at: Date) =>
  tx.query(`UPDATE ufaa_return_items SET dropped_at = $2 WHERE item_id = $1`, [item.itemId, at.toISOString()]);

/**
 * Locks the item's escrows in claimableEscrows order (release_due_at, escrow_id), as a claim does, so
 * the two never deadlock; per escrow, whether it still satisfies `ok` (SQL over `e`; `$2` is `arg`).
 */
async function lockItem(tx: PoolClient, item: UfaaItem, ok: string, arg?: string): Promise<Array<{ escrowId: string; cents: number; ok: boolean }>> {
  const { rows } = await tx.query(
    `SELECT e.escrow_id, (e.gross_commission * 100)::bigint AS cents, (${ok}) AS ok FROM escrow_accounts e
      WHERE e.escrow_id = ANY($1::uuid[]) ORDER BY e.release_due_at, e.escrow_id FOR UPDATE`,
    arg === undefined ? [item.escrowIds] : [item.escrowIds, arg]
  );
  return rows.map((r) => ({ escrowId: r.escrow_id, cents: Number(r.cents), ok: r.ok === true }));
}

export type StepOutcome<T> =
  | { kind: 'not_found' }
  /** The return is not at the status this step needs. */
  | { kind: 'wrong_status'; ret: UfaaReturn }
  | ({ kind: 'too_early'; ret: UfaaReturn })
  | ({ kind: 'done'; ret: UfaaReturn; items: UfaaItem[] } & T);

/**
 * NOTICED → REPORTED: drops items no longer claimable and freezes the escrows of the rest
 * (ufaa_return_id: no claim, no reminder from now on), has `write` produce the report from them
 * (returns its path), records totals and one UFAA_REPORTED event per reported agent. `ready` decides
 * whether the notice gap has passed. The reported total is exactly what the operator transfers.
 */
export async function markReported(
  db: TxDb,
  returnId: string,
  at: Date,
  ready: (ret: UfaaReturn) => boolean,
  write: (ret: UfaaReturn, items: UfaaItem[]) => Promise<string>,
  what: string
): Promise<StepOutcome<object>> {
  return withTransaction(db, async (tx) => {
    const cur = await lockReturn(tx, returnId);
    if (!cur) return { kind: 'not_found' } as const;
    if (cur.status !== 'NOTICED') return { kind: 'wrong_status', ret: cur } as const;
    if (!ready(cur)) return { kind: 'too_early', ret: cur } as const;
    const items: UfaaItem[] = [];
    for (const item of await liveItems(tx, returnId, at)) {
      // Re-checked under the escrow locks: a claim that committed after liveItems wins.
      const locked = await lockItem(tx, item, CLAIMABLE('e'));
      if (locked.length !== item.escrowIds.length || !locked.every((l) => l.ok)) {
        await drop(tx, item, at);
        continue;
      }
      await tx.query(`UPDATE escrow_accounts SET ufaa_return_id = $1 WHERE escrow_id = ANY($2::uuid[])`, [returnId, item.escrowIds]);
      items.push(item);
    }
    const reportPath = await write(cur, items);
    const { rows: [r] } = await tx.query(
      `UPDATE ufaa_returns SET status = 'REPORTED', reported_at = $2, report_path = $3, reported_cents = $4, reported_items = $5
        WHERE return_id = $1 RETURNING ${RET}`,
      [returnId, at.toISOString(), reportPath, items.reduce((s, i) => s + i.amountCents, 0), items.length]
    );
    for (const item of items) await event(tx, 'UFAA_REPORTED', cur, item, what);
    return { kind: 'done', ret: toReturn(r), items } as const;
  });
}

/**
 * REPORTED → REMITTED in one transaction, per escrow: each live item's escrows are locked
 * (claimableEscrows order); those still frozen HELD and not security-held → REMITTED, with a
 * UFAA_REMITTED event for their amount. An escrow security-held after the report is not remitted and
 * stays frozen (never payable: its money was in the transfer); it gets a UFAA_REMITTED event saying to
 * recover its amount from UFAA, and is returned in `held`. `items` / `held` carry the remitted / held
 * amounts. The agent's sub-shilling carry is never touched.
 */
export async function remit(db: TxDb, returnId: string, reference: string, at: Date, what: string): Promise<StepOutcome<{ held: UfaaItem[] }>> {
  return withTransaction(db, async (tx) => {
    const cur = await lockReturn(tx, returnId);
    if (!cur) return { kind: 'not_found' } as const;
    if (cur.status !== 'REPORTED') return { kind: 'wrong_status', ret: cur } as const;
    const { rows } = await tx.query(`SELECT ${ITEM} FROM ${ITEM_FROM} WHERE i.return_id = $1 AND i.dropped_at IS NULL ORDER BY i.item_id`, [returnId]);
    const items: UfaaItem[] = [];
    const held: UfaaItem[] = [];
    for (const item of rows.map(toItem)) {
      const locked = await lockItem(tx, item, `e.escrow_status = 'HELD' AND NOT e.security_hold AND e.ufaa_return_id = $2::uuid`, returnId);
      const ok = locked.filter((l) => l.ok);
      const bad = locked.filter((l) => !l.ok);
      if (ok.length) {
        await tx.query(`UPDATE escrow_accounts SET escrow_status = 'REMITTED' WHERE escrow_id = ANY($1::uuid[])`, [ok.map((l) => l.escrowId)]);
        const done = { ...item, escrowIds: ok.map((l) => l.escrowId), amountCents: ok.reduce((n, l) => n + l.cents, 0) };
        await event(tx, 'UFAA_REMITTED', cur, done, what);
        items.push(done);
      }
      if (bad.length) {
        const h = { ...item, escrowIds: bad.map((l) => l.escrowId), amountCents: bad.reduce((n, l) => n + l.cents, 0) };
        await event(tx, 'UFAA_REMITTED', cur, h, `${bad.length} escrow(s) security-held after the report: not remitted, kept frozen; recover KES ${kes(h.amountCents)} from UFAA`);
        held.push(h);
      }
    }
    const { rows: [r] } = await tx.query(
      `UPDATE ufaa_returns SET status = 'REMITTED', remitted_at = $2, remittance_reference = $3, remitted_cents = $4, remitted_items = $5
        WHERE return_id = $1 RETURNING ${RET}`,
      [returnId, at.toISOString(), reference, items.reduce((n, i) => n + i.amountCents, 0), items.length]
    );
    return { kind: 'done', ret: toReturn(r), items, held } as const;
  });
}

/**
 * GET /payouts: the agent's commission transferred to UFAA (reference set: its REMITTED escrows), or
 * frozen in a reported return and being transferred (reference null), newest period first. The
 * holder reference (item id) is what the owner quotes to claim at UFAA.
 */
export async function remittedForAgent(
  db: Db,
  agentId: string
): Promise<Array<{ cents: number; periodEnd: string; reference: string | null; holderReference: string }>> {
  const { rows } = await db.query(
    `SELECT i.item_id, sum((e.gross_commission * 100)::bigint) AS cents, r.period_end::text AS period_end, r.remittance_reference
       FROM ufaa_return_items i JOIN ufaa_returns r USING (return_id)
       JOIN escrow_accounts e ON e.escrow_id = ANY(i.escrow_ids) AND e.ufaa_return_id = r.return_id
      WHERE i.agent_id = $1 AND i.dropped_at IS NULL
        AND (r.status = 'REPORTED' OR (r.status = 'REMITTED' AND e.escrow_status = 'REMITTED'))
      GROUP BY i.item_id, r.period_end, r.remittance_reference
      ORDER BY r.period_end DESC`,
    [agentId]
  );
  return rows.map((r) => ({ cents: Number(r.cents), periodEnd: r.period_end, reference: r.remittance_reference, holderReference: r.item_id }));
}
