/**
 * @file statement.ts
 * @description M-Pesa org-portal statement (CSV) parser for reconciliation (spec gh-6-recon).
 *
 * Pure: bytes in, a validated statement out — or a StatementError listing every problem with its
 * line number (the whole file is rejected; nothing is written). Handles the CSV realities of the
 * portal export: preamble lines before the header (found by its "Receipt No." column), a BOM,
 * trailing total rows, quoted amounts with thousand separators, negative withdrawals.
 *
 *  - Columns are found by tolerant, case-insensitive header aliases; a missing required column or an
 *    unparseable value rejects the file.
 *  - Times: `dd-mm-yyyy HH:mm:ss` or `yyyy-mm-dd HH:mm:ss`, East Africa Time, converted to UTC.
 *    Anything else (e.g. an Excel-resaved `m/d/yyyy`) is ambiguous and rejects the file.
 *  - Rows are classified credit / reversal / non-credit. Only completed paid-in rows whose Details
 *    or Reason Type start with a whitelisted type ("Pay Bill Online", "Pay Bill from", "Merchant
 *    Payment", configurable) are credits; transfers, settlements, charges and withdrawals are not.
 *  - Other Party Info keeps only the phone (full → hashed later, masked → visible prefix/suffix);
 *    the payer name — and the Details text, which can carry it — never leave this module.
 */

import { parse } from 'csv-parse/sync';
import { RECEIPT_RE, parseOtherParty, type OtherParty } from '../domain/callback';

export class StatementError extends Error {
  constructor(public readonly errors: string[]) {
    super(`statement rejected: ${errors.length} problem(s)`);
  }
}

export type RowKind = 'credit' | 'reversal' | 'non_credit';
export type NonCreditReason = 'not_completed' | 'withdrawal' | 'charge' | 'not_whitelisted' | 'zero_amount';

export interface StatementRow {
  /** Line number in the CSV file (1-based). */
  line: number;
  receipt: string;
  /** UTC. */
  completionTime: Date;
  /** UTC; null when the column is absent or empty. */
  initiationTime: Date | null;
  status: string;
  paidInCents: number | null;
  /** Absolute value (withdrawals are often negative in the export). */
  withdrawnCents: number | null;
  /** The phone of the other party only; the name is dropped. */
  otherParty: OtherParty;
  linkedReceipt: string | null;
  /** A/C No. as printed (trimmed). */
  accountNo: string;
  kind: RowKind;
  nonCreditReason: NonCreditReason | null;
  /** Credit / reversal amount in cents. */
  amountCents: number;
  /** Running balance after this row (cents), or null when not printed. */
  balanceCents: number | null;
}

export interface Statement {
  shortCode: string | null;
  account: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  rows: StatementRow[];
  /** Identical rows repeated in the file (kept once). */
  duplicateRows: number;
  /** Total / summary rows after the data. */
  trailerRows: number;
  /**
   * Lines where the running Balance does not follow from the previous row (an inserted, edited or
   * missing row). Checked only when every row prints a Balance; a mismatch needs --confirm.
   */
  balanceMismatchLines: number[];
}

type Field =
  | 'receipt'
  | 'completion'
  | 'initiation'
  | 'details'
  | 'status'
  | 'paidIn'
  | 'withdrawn'
  | 'balance'
  | 'reasonType'
  | 'otherParty'
  | 'linked'
  | 'account';

const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header aliases (normalised: lower-case, alphanumerics only). */
const ALIASES: Record<Field, string[]> = {
  receipt: ['receiptno', 'receiptnumber', 'receipt', 'transactionid', 'transactionreceipt'],
  completion: ['completiontime', 'completiondate', 'completedtime', 'completiondatetime', 'completedon'],
  initiation: ['initiationtime', 'initiationdate', 'initiatedtime', 'initiationdatetime'],
  details: ['details', 'description', 'transactiondetails'],
  status: ['transactionstatus', 'status'],
  paidIn: ['paidin', 'moneyin', 'credit', 'paidinamount'],
  withdrawn: ['withdrawn', 'withdrawal', 'moneyout', 'debit', 'withdrawnamount'],
  balance: ['balance'],
  reasonType: ['reasontype', 'transactiontype', 'type'],
  otherParty: ['otherpartyinfo', 'otherparty', 'oppositeparty', 'otherpartyinformation'],
  linked: ['linkedtransactionid', 'linkedtransaction', 'linkedreceipt', 'linkedreceiptno'],
  account: ['acno', 'accountno', 'accountnumber', 'accno', 'billrefnumber', 'accountreference'],
};
const REQUIRED: Field[] = ['receipt', 'completion', 'status', 'paidIn', 'withdrawn', 'account'];
const HEADER_RECEIPT = new Set(ALIASES.receipt.slice(0, 3));

const EAT_OFFSET_MS = 3 * 3_600_000;

/** `dd-mm-yyyy HH:mm:ss` or `yyyy-mm-dd HH:mm:ss` (EAT) → UTC; null for anything else. */
export function parseStatementTime(raw: unknown): Date | null {
  const v = String(raw ?? '').trim();
  let m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v);
  let y: number, mo: number, d: number;
  if (m) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v);
    if (!m) return null;
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  return eatToUtc(y, mo, d, h, mi, s);
}

function eatToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d) return null;
  return new Date(local.getTime() - EAT_OFFSET_MS);
}

/** A date or date-time (EAT) bounding the Time Period; a bare date covers the whole day. */
function parsePeriodBound(raw: string, end: boolean): Date | null {
  const t = parseStatementTime(raw);
  if (t) return t;
  const v = raw.trim();
  let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
  let parts: number[] | null = m ? [Number(m[3]), Number(m[2]), Number(m[1])] : null;
  if (!parts) {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    parts = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  if (!parts) return null;
  return end ? eatToUtc(parts[0], parts[1], parts[2], 23, 59, 59) : eatToUtc(parts[0], parts[1], parts[2], 0, 0, 0);
}

/** "From A To B", "A to B", "A - B" → [start, end] (UTC), or null. */
export function parseTimePeriod(raw: string): [Date, Date] | null {
  const m = /^(?:from\s+)?(.+?)\s+(?:to|-|–)\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const start = parsePeriodBound(m[1], false);
  const end = parsePeriodBound(m[2], true);
  return start && end && start.getTime() <= end.getTime() ? [start, end] : null;
}

/**
 * Statement amount → signed cents: "1500", "1500.5", "1,500.00", "-1,500.00" (quotes already
 * removed by the CSV reader). Empty → null. Anything else → undefined (invalid).
 */
export function parseStatementAmount(raw: unknown): number | null | undefined {
  const v = String(raw ?? '').trim().replace(/^KES\s*/i, '');
  if (v === '' || v === '-') return null;
  const m = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return undefined;
  const cents = Number(m[2].replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return undefined;
  return m[1] ? -cents : cents;
}

function preambleEntry(cells: string[]): [string, string] | null {
  const filled = cells.map((c) => c.trim()).filter((c) => c.length > 0);
  if (filled.length === 0) return null;
  const first = filled[0];
  const colon = first.indexOf(':');
  if (colon > 0 && first.slice(colon + 1).trim()) return [norm(first.slice(0, colon)), [first.slice(colon + 1), ...filled.slice(1)].join(' ').trim()];
  return [norm(first.replace(/:$/, '')), filled.slice(1).join(' ').trim()];
}

const startsWithAny = (value: string, types: string[]) => {
  const v = value.trim().toLowerCase();
  return v.length > 0 && types.some((t) => v.startsWith(t.trim().toLowerCase()));
};

export interface ParseOptions {
  /** Whitelisted Details / Reason Type prefixes that make a completed paid-in row a credit. */
  creditTypes: string[];
}

/** Parses and validates a whole statement; throws StatementError (with line numbers) on any problem. */
export function parseStatement(input: Buffer | string, opts: ParseOptions): Statement {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  if (buf.length === 0) throw new StatementError(['the file is empty']);
  if (buf.includes(0) || buf.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004' || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    throw new StatementError(['not a CSV file (binary content): export the statement as CSV']);
  }
  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parse(buf.toString('utf-8'), {
      bom: true,
      relax_column_count: true,
      relax_quotes: false,
      skip_empty_lines: false,
      info: true,
    }) as any;
  } catch (error) {
    const line = (error as any)?.lines;
    throw new StatementError([`${line ? `line ${line}: ` : ''}not valid CSV (${String((error as Error).message).split('\n')[0].slice(0, 160)})`]);
  }

  const errors: string[] = [];
  const headerIdx = records.findIndex((r) => r.record.some((c) => HEADER_RECEIPT.has(norm(c))));
  if (headerIdx < 0) throw new StatementError(['no header row with a "Receipt No." column: is this an M-Pesa statement CSV?']);

  // ── preamble ──────────────────────────────────────────────────────────
  const pre = new Map<string, string>();
  for (const r of records.slice(0, headerIdx)) {
    const e = preambleEntry(r.record);
    if (e && !pre.has(e[0])) pre.set(e[0], e[1]);
  }
  const pick = (...keys: string[]) => keys.map((k) => pre.get(k)).find((v) => v !== undefined && v !== '') ?? null;
  const shortCode = pick('shortcode', 'organisationshortcode', 'organizationshortcode', 'paybill', 'tillnumber');
  const account = pick('account', 'accounttype', 'accountname');
  const periodRaw = pick('timeperiod', 'period', 'statementperiod');
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  if (periodRaw !== null) {
    const p = parseTimePeriod(periodRaw);
    if (!p) errors.push(`preamble: Time Period "${periodRaw.slice(0, 60)}" is not a recognised date range`);
    else [periodStart, periodEnd] = p;
  }

  // ── header ────────────────────────────────────────────────────────────
  const header = records[headerIdx];
  const col: Partial<Record<Field, number>> = {};
  header.record.forEach((cell, i) => {
    const n = norm(cell);
    if (!n) return;
    for (const [field, aliases] of Object.entries(ALIASES) as Array<[Field, string[]]>) {
      if (!aliases.includes(n)) continue;
      if (col[field] !== undefined) errors.push(`line ${header.info.lines}: more than one column maps to "${field}"`);
      else col[field] = i;
    }
  });
  const missing = REQUIRED.filter((f) => col[f] === undefined);
  if (col.details === undefined && col.reasonType === undefined) missing.push('details' as Field);
  if (missing.length) errors.push(`line ${header.info.lines}: missing required column(s): ${missing.join(', ')}`);
  if (errors.length) throw new StatementError(errors);

  // ── rows ──────────────────────────────────────────────────────────────
  const get = (rec: string[], f: Field) => (col[f] === undefined ? '' : String(rec[col[f]!] ?? '').trim());
  const rows: StatementRow[] = [];
  const seen = new Map<string, { line: number; signature: string }>();
  let duplicateRows = 0;
  let trailerRows = 0;

  for (const { record, info } of records.slice(headerIdx + 1)) {
    const line = info.lines;
    if (record.every((c) => String(c ?? '').trim() === '')) continue;
    const receipt = get(record, 'receipt').toUpperCase();
    // Only a recognised total row is skipped; any other row without a receipt rejects the file.
    if (!receipt || /^total/i.test(receipt)) {
      if (/^total/i.test(receipt) || record.some((c) => /^totals?:?$/i.test(String(c ?? '').trim()))) trailerRows += 1;
      else errors.push(`line ${line}: a transaction row without a Receipt No.`);
      continue;
    }
    if (!RECEIPT_RE.test(receipt)) {
      errors.push(`line ${line}: receipt "${receipt.slice(0, 24)}" is not an M-Pesa receipt number`);
      continue;
    }
    const completionTime = parseStatementTime(get(record, 'completion'));
    if (!completionTime) errors.push(`line ${line}: completion time "${get(record, 'completion').slice(0, 30)}" is not dd-mm-yyyy HH:mm:ss or yyyy-mm-dd HH:mm:ss`);
    const initRaw = get(record, 'initiation');
    const initiationTime = initRaw ? parseStatementTime(initRaw) : null;
    if (initRaw && !initiationTime) errors.push(`line ${line}: initiation time "${initRaw.slice(0, 30)}" is not dd-mm-yyyy HH:mm:ss or yyyy-mm-dd HH:mm:ss`);
    const paidIn = parseStatementAmount(get(record, 'paidIn'));
    const withdrawn = parseStatementAmount(get(record, 'withdrawn'));
    if (paidIn === undefined) errors.push(`line ${line}: Paid In "${get(record, 'paidIn').slice(0, 20)}" is not an amount`);
    if (withdrawn === undefined) errors.push(`line ${line}: Withdrawn "${get(record, 'withdrawn').slice(0, 20)}" is not an amount`);
    if (typeof paidIn === 'number' && paidIn < 0) errors.push(`line ${line}: Paid In is negative`);
    const balanceRaw = get(record, 'balance');
    const balance = parseStatementAmount(balanceRaw);
    if (balance === undefined) errors.push(`line ${line}: Balance "${balanceRaw.slice(0, 20)}" is not an amount`);
    const linkedRaw = get(record, 'linked').toUpperCase();
    if (linkedRaw && !RECEIPT_RE.test(linkedRaw)) errors.push(`line ${line}: Linked Transaction ID is not an M-Pesa receipt number`);
    if (!completionTime || (initRaw && !initiationTime) || paidIn === undefined || withdrawn === undefined || balance === undefined || (paidIn ?? 0) < 0) continue;
    if (periodStart && periodEnd && (completionTime < periodStart || completionTime > periodEnd)) {
      errors.push(`line ${line}: completion time is outside the statement's Time Period`);
      continue;
    }

    const status = get(record, 'status');
    const details = get(record, 'details');
    const reasonType = get(record, 'reasonType');
    const paidInCents = paidIn === null || paidIn === 0 ? null : paidIn;
    const withdrawnCents = withdrawn === null || withdrawn === 0 ? null : Math.abs(withdrawn);
    let kind: RowKind = 'non_credit';
    let reason: NonCreditReason | null = null;
    let amountCents = 0;
    if (status.toLowerCase() !== 'completed') reason = 'not_completed';
    // Reason Type says so, or Details STARTS with "Reversal" (a payer name may merely contain it).
    else if (/revers/i.test(reasonType) || /^reversal/i.test(details)) {
      kind = 'reversal';
      amountCents = withdrawnCents ?? paidInCents ?? 0;
    } else if (paidInCents && !withdrawnCents) {
      if (startsWithAny(details, opts.creditTypes) || startsWithAny(reasonType, opts.creditTypes)) {
        kind = 'credit';
        amountCents = paidInCents;
      } else reason = 'not_whitelisted';
    } else if (withdrawnCents) reason = /charge|fee/i.test(`${details} ${reasonType}`) ? 'charge' : 'withdrawal';
    else reason = 'zero_amount';

    const row: StatementRow = {
      line,
      receipt,
      completionTime,
      initiationTime,
      status,
      paidInCents,
      withdrawnCents,
      otherParty: parseOtherParty(get(record, 'otherParty')),
      linkedReceipt: linkedRaw || null,
      accountNo: get(record, 'account'),
      kind,
      nonCreditReason: reason,
      amountCents,
      balanceCents: balance,
    };
    // Same receipt twice: identical rows are kept once; conflicting rows reject the file.
    const signature = JSON.stringify([record.map((c) => String(c ?? '').trim())]);
    const prior = seen.get(receipt);
    if (prior) {
      if (prior.signature === signature) duplicateRows += 1;
      else errors.push(`line ${line}: receipt ${receipt} also appears on line ${prior.line} with different values`);
      continue;
    }
    seen.set(receipt, { line, signature });
    rows.push(row);
  }
  if (rows.length === 0 && errors.length === 0) errors.push('the statement has no transaction rows');
  if (errors.length) throw new StatementError(errors);
  return { shortCode, account, periodStart, periodEnd, rows, duplicateRows, trailerRows, balanceMismatchLines: balanceMismatches(rows) };
}

/**
 * Running-balance continuity in statement order: balance[i] = balance[i-1] + paidIn - withdrawn
 * (non-completed rows move nothing). Exports list oldest or newest first, so the direction with
 * fewer breaks is reported. Empty when any row prints no Balance.
 */
export function balanceMismatches(rows: StatementRow[]): number[] {
  if (rows.length < 2 || rows.some((r) => r.balanceCents === null)) return [];
  const delta = (r: StatementRow) => (r.status.toLowerCase() === 'completed' ? (r.paidInCents ?? 0) - (r.withdrawnCents ?? 0) : 0);
  const forward: number[] = [];
  const backward: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]];
    if (cur.balanceCents !== prev.balanceCents! + delta(cur)) forward.push(cur.line);
    if (prev.balanceCents !== cur.balanceCents! + delta(prev)) backward.push(prev.line);
  }
  return forward.length <= backward.length ? forward : backward;
}
