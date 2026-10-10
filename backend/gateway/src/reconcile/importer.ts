/**
 * @file importer.ts
 * @description M-Pesa statement import (spec gh-6-recon): recovers payments the gateway never
 * learned of and feeds them into the EXISTING intake → ML → escrow pipeline, flagged RECONCILED.
 *
 * Order (nothing is written until the whole file has been validated):
 *   1. read + SHA-256, parse and validate the whole CSV (statement.ts) and its identity (Short Code
 *      = the Daraja shortcode; Account = RECONCILE_EXPECTED_ACCOUNT when set; a Time Period);
 *   2. the operator must be an active MERCHANT_ADMIN;
 *   3. one importer at a time (session advisory lock); a file already COMPLETED is a recorded
 *      no-op; RUNNING runs left by a crash (any file) become FAILED and the file resumes;
 *   4. --confirm is required above RECONCILE_CONFIRM_MAX_ROWS / _AMOUNT new payments, above
 *      RECONCILE_TWO_WAY_MAX_HOLDS two-way holds, or when the running Balance breaks (a dry run
 *      reports which of these apply);
 *   5. the original file is copied to <evidence dir>/<sha256>/ (directory 0700, file 0600);
 *   6. per row, in its own transaction:
 *        credit, receipt already known → verified (amount, account / agent code, time; a verified
 *          receipt credits its agent's trust rating once, spec gh-23); a
 *          mismatch raises RECONCILE_AMOUNT_MISMATCH / RECONCILE_ATTRIBUTION_CONFLICT (+ hold);
 *        credit, new → bound (row lock) to exactly one eligible STK request → STK-shaped intake
 *          row carrying stkRequestId (and the request's CheckoutRequestID when it has one); a
 *          single FAILED/REJECTED match → STK_STATUS_CONFLICT and an STK-shaped row the worker
 *          holds UNRESOLVED; anything else → C2B-shaped (BillRefNumber = A/C No.);
 *        reversal → PAYMENT_REVERSED, escrow security-held QUARANTINED, or CLAWBACK_DUE when it
 *          was already RELEASED (nothing is ever paid out or clawed back automatically);
 *        anything else → ignored and counted — unless we hold that receipt as a payment, which is
 *          a RECONCILE_ATTRIBUTION_CONFLICT (+ hold): the statement says it was not a completed sale;
 *   7. two-way (only with RECONCILE_EXPECTED_ACCOUNT set): callback-origin receipts paid to this
 *      shortcode inside the Time Period but missing from the statement → RECONCILE_NOT_ON_STATEMENT
 *      + security hold (RELEASED → exception record);
 *   8. the run is COMPLETED (FAILED on error). The CLI is a separate process: recovered rows
 *      settle on the gateway settlement worker's next poll (<= WORKER_POLL_INTERVAL_MS); in-process
 *      callers may pass onNewIntake to wake it.
 *
 * Synthetic rows: payload canonical (sorted keys) and redacted (phone → HMAC, or absent when
 * masked; the name dropped), hashed under the separate `reconciled` HMAC domain, payment time and
 * received_at = the statement's Completion Time (EAT → UTC), evidence = file SHA + CSV line.
 * Logs carry receipts, line numbers and counts only — never phones, names or statement text.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../config/db';
import { keyedHash, KEYED_HASH_RE } from '../config/pii';
import { field } from '../domain/unknown';
import { reconcileImportConfig, type ReconcileImportConfig } from '../config/reconcile';
import { STK_TTL_MS } from '../config/stk';
import {
  centsToDecimal,
  extractIngress,
  formatDarajaTime,
  isPhoneLike,
  maskHashCandidates,
  msisdnHashCandidates,
  normaliseAgentCode,
  normaliseKenyanMsisdn,
  normalisedMsisdnHash,
  parseStoredCallback,
  stableStringify,
  toCents,
} from '../domain/callback';
import { withTransaction, type Db, type TxDb } from '../repositories/db.types';
import { insertIntake } from '../repositories/intake.repository';
import {
  callbackReceiptsMissingFrom,
  failAbandonedRuns,
  findBindingCandidates,
  findCompletedRun,
  findKnownReceipt,
  findOperator,
  finishRun,
  insertException,
  insertRun,
  knownReceipts,
  lockReceipt,
  releaseImportLock,
  setRunEvidence,
  tryImportLock,
  type BindingCandidate,
  type KnownReceipt,
} from '../repositories/reconcile.repository';
import { insertSecurityEvent, securityHoldReceipt, type SecurityEventType } from '../repositories/security.repository';
import { RECONCILE_BINDABLE } from '../repositories/stk.repository';
import { creditReceipt } from '../repositories/trust.repository';
import { parseStatement, StatementError, type NonCreditReason, type Statement, type StatementRow } from './statement';

export class ImportRejected extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
  }
}

export interface ImportOptions {
  filePath: string;
  /** user_id or phone of an active MERCHANT_ADMIN. */
  operator: string;
  dryRun?: boolean;
  confirm?: boolean;
  db?: TxDb;
  env?: NodeJS.ProcessEnv;
  /** Wakes the settlement worker when new intake rows were written (in-process callers). */
  onNewIntake?: () => void;
}

export interface ImportCounts {
  rows: number;
  credits: number;
  reversals: number;
  nonCredit: Record<NonCreditReason, number>;
  duplicateRows: number;
  trailerRows: number;
  newPayments: number;
  boundStk: number;
  unbound: number;
  statusConflicts: number;
  verified: number;
  amountMismatches: number;
  attributionConflicts: number;
  reversalsOfKnown: number;
  reversalsOfUnknown: number;
  reversalsUnlinked: number;
  clawbacksDue: number;
  notOnStatement: number;
  notOnStatementReleased: number;
}

export interface ImportReport {
  runId: string;
  outcome: 'COMPLETED' | 'NOOP' | 'DRY_RUN';
  sha256: string;
  rowsTotal: number;
  rowsNew: number;
  counts: ImportCounts;
  /** One line per action (receipts and CSV line numbers only, never PII). */
  actions: string[];
  evidencePath: string | null;
  noopOfRunId: string | null;
  /** E.g. two-way reconciliation skipped. */
  warnings: string[];
  /** Why a real import of this file needs --confirm (empty: it does not). */
  confirmRequired: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyCounts(s: Statement): ImportCounts {
  return {
    rows: s.rows.length,
    credits: s.rows.filter((r) => r.kind === 'credit').length,
    reversals: s.rows.filter((r) => r.kind === 'reversal').length,
    nonCredit: { not_completed: 0, withdrawal: 0, charge: 0, not_whitelisted: 0, zero_amount: 0 },
    duplicateRows: s.duplicateRows,
    trailerRows: s.trailerRows,
    newPayments: 0,
    boundStk: 0,
    unbound: 0,
    statusConflicts: 0,
    verified: 0,
    amountMismatches: 0,
    attributionConflicts: 0,
    reversalsOfKnown: 0,
    reversalsOfUnknown: 0,
    reversalsUnlinked: 0,
    clawbacksDue: 0,
    notOnStatement: 0,
    notOnStatementReleased: 0,
  };
}

interface Ctx {
  write: boolean;
  runId: string | null;
  sha: string;
  shortCode: string;
  cfg: ReconcileImportConfig;
  counts: ImportCounts;
  actions: string[];
}

const sameText = (a: string | null, b: string | null) =>
  (a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === (b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Validates the statement belongs to this business (Short Code, Account) and has a Time Period. */
export function checkIdentity(s: Statement, cfg: ReconcileImportConfig): string[] {
  const problems: string[] = [];
  if (cfg.shortCodes.length === 0) problems.push('DARAJA_BUSINESS_SHORTCODE is not set: cannot check that the statement belongs to this business');
  else if (!s.shortCode) problems.push('the statement preamble has no Short Code');
  else if (!cfg.shortCodes.includes(s.shortCode.replace(/\s+/g, ''))) {
    problems.push(`statement Short Code ${s.shortCode.slice(0, 20)} is not the Daraja shortcode (${cfg.shortCodes.join(' / ')})`);
  }
  if (cfg.expectedAccount && !sameText(s.account, cfg.expectedAccount)) {
    problems.push(`statement Account "${(s.account ?? '').slice(0, 60)}" is not RECONCILE_EXPECTED_ACCOUNT ("${cfg.expectedAccount}")`);
  }
  if (!s.periodStart || !s.periodEnd) problems.push('the statement preamble has no Time Period');
  return problems;
}

/** A/C No. as stored on a synthetic row: a phone-like value is replaced by its HMAC (like the hot path). */
function storedAccountNo(acNo: string): string {
  return isPhoneLike(acNo) ? keyedHash('counterparty', `billref:${acNo.replace(/[\s+()-]/g, '')}`) : acNo;
}

function evidenceBlock(row: StatementRow, ctx: Ctx, extra: Record<string, unknown>) {
  return {
    source: 'MPESA_STATEMENT',
    runId: ctx.runId,
    fileSha256: ctx.sha,
    line: row.line,
    completionTime: row.completionTime.toISOString(),
    initiationTime: row.initiationTime?.toISOString() ?? null,
    ...extra,
  };
}

function phoneHash(row: StatementRow): string | undefined {
  return row.otherParty.kind === 'full' ? normalisedMsisdnHash(row.otherParty.msisdn) : undefined;
}

/** STK-shaped payload bound to a request (never a fabricated CheckoutRequestID). */
function stkShaped(row: StatementRow, c: BindingCandidate, ctx: Ctx, corroborated: boolean) {
  const items: Array<{ Name: string; Value: unknown }> = [
    { Name: 'Amount', Value: centsToDecimal(row.amountCents) },
    { Name: 'MpesaReceiptNumber', Value: row.receipt },
    { Name: 'TransactionDate', Value: formatDarajaTime(row.completionTime) },
  ];
  const phone = phoneHash(row);
  if (phone) items.push({ Name: 'PhoneNumber', Value: phone });
  return {
    Body: {
      stkCallback: {
        CheckoutRequestID: c.checkoutRequestId ?? undefined,
        ResultCode: 0,
        ResultDesc: 'Recovered from the M-Pesa statement',
        CallbackMetadata: { Item: items },
      },
    },
    Reconciliation: evidenceBlock(row, ctx, {
      stkRequestId: c.stkRequestId,
      corroborated,
      accountNo: storedAccountNo(row.accountNo),
      ...(corroborated ? {} : { statusConflict: c.status }),
    }),
  };
}

/** C2B-shaped payload: resolves by agent code (BillRefNumber = A/C No.). */
function c2bShaped(row: StatementRow, ctx: Ctx) {
  return {
    TransactionType: 'Pay Bill',
    TransID: row.receipt,
    TransTime: formatDarajaTime(row.completionTime),
    TransAmount: centsToDecimal(row.amountCents),
    BusinessShortCode: ctx.shortCode,
    BillRefNumber: storedAccountNo(row.accountNo),
    MSISDN: phoneHash(row),
    Reconciliation: evidenceBlock(row, ctx, { corroborated: false }),
  };
}

/** The agent code a known receipt belongs to, as best we know it (null when unknowable). */
function knownAgentCode(k: KnownReceipt): string | null {
  if (k.txAgentCode) return k.txAgentCode;
  if (k.channel === 'C2B') {
    const ref = String(field(k.payload, 'BillRefNumber') ?? '').trim();
    return ref && !KEYED_HASH_RE.test(ref) ? normaliseAgentCode(ref) : null;
  }
  return k.stkAccountReference ? normaliseAgentCode(k.stkAccountReference) : null;
}

function knownPaymentTime(k: KnownReceipt): Date | null {
  if (k.txTime) return k.txTime;
  try {
    const p = parseStoredCallback(k.payload);
    if (p.paymentTime) return p.paymentTime;
  } catch {
    /* fall through */
  }
  return k.receivedAt;
}

function knownAmountCents(k: KnownReceipt): number | null {
  if (k.txAmount) return toCents(k.txAmount);
  const ingress = extractIngress(k.payload);
  return ingress.kind === 'ok' ? ingress.amountCents : null;
}

async function alarmAndHold(db: Db, ctx: Ctx, type: SecurityEventType, receipt: string, detail: string): Promise<void> {
  await lockReceipt(db, receipt);
  await insertSecurityEvent(db, { type, receipt, originalHash: null, incomingHash: `stmt:${ctx.sha}`, detail });
  await securityHoldReceipt(db, receipt);
}

/** A statement row whose receipt we already hold: verify amount, account / agent code and time. */
async function verifyKnown(db: Db, row: StatementRow, k: KnownReceipt, ctx: Ctx): Promise<void> {
  const where = `line ${row.line}: ${row.receipt}`;
  const stored = knownAmountCents(k);
  if (stored !== null && stored !== row.amountCents) {
    ctx.counts.amountMismatches += 1;
    ctx.actions.push(`${where} known receipt, AMOUNT MISMATCH (ours ${centsToDecimal(stored)}, statement ${centsToDecimal(row.amountCents)}) → RECONCILE_AMOUNT_MISMATCH`);
    if (ctx.write) {
      await alarmAndHold(db, ctx, 'RECONCILE_AMOUNT_MISMATCH', row.receipt,
        `statement line ${row.line} amount ${centsToDecimal(row.amountCents)} differs from ours ${centsToDecimal(stored)}`);
    }
    return;
  }
  const problems: string[] = [];
  const expected = knownAgentCode(k);
  const statementCode = isPhoneLike(row.accountNo) ? null : normaliseAgentCode(row.accountNo);
  if (expected && statementCode && expected !== statementCode) problems.push('account / agent code differs');
  const at = knownPaymentTime(k);
  if (at && Math.abs(at.getTime() - row.completionTime.getTime()) > ctx.cfg.timeToleranceMs) problems.push('payment time differs');
  if (problems.length) {
    ctx.counts.attributionConflicts += 1;
    ctx.actions.push(`${where} known receipt, ${problems.join(' and ')} → RECONCILE_ATTRIBUTION_CONFLICT`);
    if (ctx.write) await alarmAndHold(db, ctx, 'RECONCILE_ATTRIBUTION_CONFLICT', row.receipt, `statement line ${row.line}: ${problems.join(', ')}`);
    return;
  }
  ctx.counts.verified += 1;
  ctx.actions.push(`${where} known receipt, verified`);
  // Spec gh-23: independent evidence the money was legitimate → +β, once per receipt (re-import: none).
  if (ctx.write) await creditReceipt(db, 'STATEMENT_CONFIRMED', row.receipt);
}

async function processCredit(db: Db, row: StatementRow, ctx: Ctx): Promise<void> {
  const known = await findKnownReceipt(db, row.receipt);
  if (known) return verifyKnown(db, row, known, ctx);

  const code = isPhoneLike(row.accountNo) ? null : normaliseAgentCode(row.accountNo);
  let candidates: BindingCandidate[] = [];
  if (code) {
    candidates = await findBindingCandidates(
      db,
      {
        agentCode: code,
        amount: centsToDecimal(row.amountCents),
        initiatedAt: row.initiationTime ?? row.completionTime,
        ttlMs: STK_TTL_MS,
        skewMs: ctx.cfg.clockSkewMs,
        phoneHashes: row.otherParty.kind === 'full' ? msisdnHashCandidates(row.otherParty.msisdn) : null,
        maskHashes: row.otherParty.kind === 'masked' ? maskHashCandidates(row.otherParty) : null,
      },
      ctx.write
    );
  }
  // Ambiguity counts every unconsumed request of any status; only exactly one can bind.
  const only = candidates.length === 1 && !candidates[0].hasIntake ? candidates[0] : null;
  const bind = only && RECONCILE_BINDABLE.includes(only.status) ? only : null;
  const conflict = only && (only.status === 'FAILED' || only.status === 'REJECTED') ? only : null;
  const target = bind ?? conflict;
  const payload = target ? stkShaped(row, target, ctx, !!bind) : c2bShaped(row, ctx);
  const channel = target ? ('DARAJA_STK' as const) : ('C2B' as const);
  const where = `line ${row.line}: ${row.receipt}`;

  if (ctx.write) {
    const res = await insertIntake(db, {
      receipt: row.receipt,
      hash: keyedHash('reconciled', stableStringify(payload)),
      channel,
      payload,
      receivedAt: row.completionTime,
      origin: 'RECONCILED',
      reconciliationRunId: ctx.runId,
      stkRequestId: target?.stkRequestId ?? null,
    });
    if (res.outcome === 'existing') {
      // A genuine callback won the race since we looked: verify against it instead.
      const now = await findKnownReceipt(db, row.receipt);
      if (!now) throw new Error(`receipt ${row.receipt}: intake conflict without a visible row`);
      return verifyKnown(db, row, now, ctx);
    }
    if (conflict) {
      await insertSecurityEvent(db, {
        type: 'STK_STATUS_CONFLICT',
        receipt: row.receipt,
        originalHash: null,
        incomingHash: `stmt:${ctx.sha}`,
        detail: `statement line ${row.line} is a payment for an STK request recorded ${conflict.status}`,
        stkRequestId: conflict.stkRequestId,
      });
    }
  }
  ctx.counts.newPayments += 1;
  if (bind) {
    ctx.counts.boundStk += 1;
    ctx.actions.push(`${where} new payment, bound to STK request ${bind.stkRequestId} (${bind.status}) → RECONCILED STK intake`);
  } else if (conflict) {
    ctx.counts.statusConflicts += 1;
    ctx.actions.push(`${where} new payment matching ${conflict.status} STK request ${conflict.stkRequestId} → STK_STATUS_CONFLICT, held UNRESOLVED`);
  } else {
    ctx.counts.unbound += 1;
    const why = candidates.length > 1 ? `${candidates.length} candidate STK requests (ambiguous)` : candidates.length === 1 ? `candidate not bindable (${candidates[0].status}${candidates[0].hasIntake ? ', has intake' : ''})` : 'no STK request';
    ctx.actions.push(`${where} new payment, ${why} → RECONCILED C2B intake by account number (corroborated=false)`);
  }
}

async function processReversal(db: Db, row: StatementRow, ctx: Ctx): Promise<void> {
  const where = `line ${row.line}: reversal ${row.receipt}`;
  if (!row.linkedReceipt) {
    ctx.counts.reversalsUnlinked += 1;
    ctx.actions.push(`${where} has no Linked Transaction ID → counted, not applied`);
    return;
  }
  const linked = row.linkedReceipt;
  const k = await findKnownReceipt(db, linked);
  const original = k ? knownAmountCents(k) : null;
  const partial = original !== null && row.amountCents < original;
  if (k) ctx.counts.reversalsOfKnown += 1;
  else ctx.counts.reversalsOfUnknown += 1;
  let released: Array<{ escrowId: string; amount: string }> = [];
  if (ctx.write) {
    await lockReceipt(db, linked);
    await insertSecurityEvent(db, {
      type: 'PAYMENT_REVERSED',
      receipt: linked,
      originalHash: null,
      incomingHash: `reversal:${row.receipt}`,
      detail: `reversed by ${row.receipt} (${partial ? 'partial' : 'full'}, ${centsToDecimal(row.amountCents)}), statement line ${row.line}`,
    });
    released = (await securityHoldReceipt(db, linked)).released;
    for (const r of released) {
      await insertException(db, {
        kind: 'CLAWBACK_DUE',
        receipt: linked,
        relatedReceipt: row.receipt,
        runId: ctx.runId!,
        escrowId: r.escrowId,
        amount: centsToDecimal(row.amountCents),
        detail: `escrow already RELEASED when ${row.receipt} reversed ${linked} (statement line ${row.line})`,
      });
    }
  }
  ctx.counts.clawbacksDue += released.length;
  ctx.actions.push(
    `${where} of ${linked} (${partial ? 'partial' : 'full'}) → PAYMENT_REVERSED` +
      (k ? (released.length ? ', escrow already RELEASED → CLAWBACK_DUE' : ', escrow security-held') : ' (receipt unknown: event only)')
  );
}

/**
 * Two-way candidates: callback receipts paid to this statement's shortcode in its Time Period that
 * it does not list. null (skipped, with a warning) unless RECONCILE_EXPECTED_ACCOUNT proves which
 * account the statement is.
 */
async function planTwoWay(db: Db, s: Statement, ctx: Ctx, warnings: string[]): Promise<string[] | null> {
  if (!ctx.cfg.expectedAccount) {
    warnings.push('two-way reconciliation skipped: set RECONCILE_EXPECTED_ACCOUNT so the statement is proven to be the account callbacks are paid into');
    return null;
  }
  const from = new Date(s.periodStart!.getTime() + ctx.cfg.clockSkewMs);
  const to = new Date(s.periodEnd!.getTime() - ctx.cfg.clockSkewMs);
  if (from >= to) return [];
  return callbackReceiptsMissingFrom(db, {
    from,
    to,
    statementReceipts: s.rows.map((r) => r.receipt),
    shortCode: ctx.shortCode,
    includeStk: ctx.cfg.receivingShortCode === ctx.shortCode,
  });
}

async function twoWay(db: TxDb, missing: string[], ctx: Ctx): Promise<void> {
  for (const receipt of missing) {
    ctx.counts.notOnStatement += 1;
    let released: Array<{ escrowId: string; amount: string }> = [];
    if (ctx.write) {
      released = await withTransaction(db, async (tx) => {
        await lockReceipt(tx, receipt);
        await insertSecurityEvent(tx, {
          type: 'RECONCILE_NOT_ON_STATEMENT',
          receipt,
          originalHash: null,
          incomingHash: `stmt:${ctx.sha}`,
          detail: 'callback receipt inside the statement Time Period is missing from the statement',
        });
        const held = await securityHoldReceipt(tx, receipt);
        for (const r of held.released) {
          await insertException(tx, {
            kind: 'RELEASED_NOT_ON_STATEMENT',
            receipt,
            runId: ctx.runId!,
            escrowId: r.escrowId,
            amount: r.amount,
            detail: 'escrow already RELEASED for a callback receipt missing from the statement',
          });
        }
        return held.released;
      });
    }
    ctx.counts.notOnStatementReleased += released.length;
    ctx.actions.push(`${receipt}: callback receipt not on the statement → RECONCILE_NOT_ON_STATEMENT${released.length ? ' (RELEASED → exception)' : ', escrow security-held'}`);
  }
}

async function resolveOperator(db: Db, ref: string): Promise<string> {
  const value = ref.trim();
  const phone = UUID_RE.test(value) ? null : normaliseKenyanMsisdn(value);
  if (!UUID_RE.test(value) && !phone) throw new ImportRejected(['--operator must be a user_id or the phone of an active MERCHANT_ADMIN']);
  const op = await findOperator(db, UUID_RE.test(value) ? { userId: value } : { phone: phone! });
  if (!op || op.role !== 'MERCHANT_ADMIN' || op.disabled) {
    throw new ImportRejected(['--operator is not an active MERCHANT_ADMIN user']);
  }
  return op.userId;
}

/** Runs one statement import (or dry run). Throws ImportRejected for a refused file or operator. */
export async function importStatement(opts: ImportOptions): Promise<ImportReport> {
  const db = opts.db ?? pool;
  const cfg = reconcileImportConfig(opts.env);
  const dryRun = opts.dryRun === true;

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(opts.filePath);
  } catch (error) {
    throw new ImportRejected([`cannot read ${path.basename(opts.filePath)}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`]);
  }
  if (!/\.csv$/i.test(opts.filePath)) throw new ImportRejected(['only .csv statements are accepted (export the statement as CSV)']);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  let statement: Statement;
  try {
    statement = parseStatement(bytes, { creditTypes: cfg.creditTypes });
  } catch (error) {
    if (error instanceof StatementError) throw new ImportRejected(error.errors);
    throw error;
  }
  const identity = checkIdentity(statement, cfg);
  if (identity.length) throw new ImportRejected(identity);
  const operatorId = await resolveOperator(db, opts.operator);

  const counts = emptyCounts(statement);
  for (const r of statement.rows) if (r.kind === 'non_credit' && r.nonCreditReason) counts.nonCredit[r.nonCreditReason] += 1;
  const ctx: Ctx = { write: !dryRun, runId: null, sha, shortCode: statement.shortCode!.replace(/\s+/g, ''), cfg, counts, actions: [] };
  const baseRun = {
    sha256: sha,
    fileName: path.basename(opts.filePath),
    operatorUserId: operatorId,
    shortCode: ctx.shortCode,
    account: statement.account,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    rowsTotal: statement.rows.length,
  };

  const lockClient = await db.connect();
  try {
    if (!(await tryImportLock(lockClient))) throw new ImportRejected(['another reconciliation import is running; try again when it has finished']);
    const prior = await findCompletedRun(db, sha);
    if (prior && !dryRun) {
      const runId = await insertRun(db, { ...baseRun, dryRun: false, status: 'COMPLETED', noopOfRunId: prior.runId, counts: { noop: true } });
      return { runId, outcome: 'NOOP', sha256: sha, rowsTotal: statement.rows.length, rowsNew: 0, counts, actions: [], evidencePath: null, noopOfRunId: prior.runId, warnings: [], confirmRequired: [] };
    }

    // Every --confirm cap, computed before anything is written (a dry run reports them).
    const warnings: string[] = [];
    const credits = statement.rows.filter((r) => r.kind === 'credit');
    const known = await knownReceipts(db, credits.map((r) => r.receipt));
    const fresh = credits.filter((r) => !known.has(r.receipt));
    const freshCents = fresh.reduce((sum, r) => sum + r.amountCents, 0);
    const missing = await planTwoWay(db, statement, ctx, warnings);
    const confirmRequired: string[] = [];
    if (fresh.length > cfg.confirmMaxRows) confirmRequired.push(`${fresh.length} new payment(s) exceed RECONCILE_CONFIRM_MAX_ROWS (${cfg.confirmMaxRows})`);
    if (freshCents > cfg.confirmMaxAmountCents) {
      confirmRequired.push(`new payments totalling KES ${centsToDecimal(freshCents)} exceed RECONCILE_CONFIRM_MAX_AMOUNT (${centsToDecimal(cfg.confirmMaxAmountCents)})`);
    }
    if (missing && missing.length > cfg.twoWayMaxHolds) {
      confirmRequired.push(`${missing.length} callback receipt(s) missing from the statement would be security-held, above RECONCILE_TWO_WAY_MAX_HOLDS (${cfg.twoWayMaxHolds})`);
    }
    if (statement.balanceMismatchLines.length) {
      confirmRequired.push(`the running Balance breaks at line(s) ${statement.balanceMismatchLines.slice(0, 20).join(', ')}: rows may be missing or edited`);
    }

    if (dryRun) {
      for (const row of statement.rows) await processRow(db, row, ctx);
      if (missing) await twoWay(db, missing, ctx);
      const runId = await insertRun(db, { ...baseRun, dryRun: true, status: 'COMPLETED', counts: { ...counts, wouldBeNew: counts.newPayments, confirmRequired, warnings } });
      return { runId, outcome: 'DRY_RUN', sha256: sha, rowsTotal: statement.rows.length, rowsNew: 0, counts, actions: ctx.actions, evidencePath: null, noopOfRunId: null, warnings, confirmRequired };
    }
    if (!opts.confirm && confirmRequired.length) {
      throw new ImportRejected([...confirmRequired, 'review a --dry-run, then re-run with --confirm']);
    }

    await failAbandonedRuns(db);
    const runId = await insertRun(db, { ...baseRun, dryRun: false, status: 'RUNNING' });
    ctx.runId = runId;
    let evidencePath: string | null = null;
    try {
      const dir = path.resolve(cfg.evidenceDir, sha);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      evidencePath = path.join(dir, path.basename(opts.filePath));
      try {
        fs.writeFileSync(evidencePath, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await setRunEvidence(db, runId, evidencePath);

      for (const row of statement.rows) await withTransaction(db, (tx) => processRow(tx, row, ctx));
      if (missing) await twoWay(db, missing, ctx);
      await finishRun(db, runId, { status: 'COMPLETED', rowsNew: counts.newPayments, counts: { ...counts, warnings } });
    } catch (error) {
      await finishRun(db, runId, { status: 'FAILED', rowsNew: counts.newPayments, counts: { ...counts }, error: (error as Error).message }).catch(() => undefined);
      throw error;
    }
    if (counts.newPayments > 0) opts.onNewIntake?.();
    return { runId, outcome: 'COMPLETED', sha256: sha, rowsTotal: statement.rows.length, rowsNew: counts.newPayments, counts, actions: ctx.actions, evidencePath, noopOfRunId: null, warnings, confirmRequired };
  } finally {
    await releaseImportLock(lockClient).catch(() => undefined);
    lockClient.release();
  }
}

async function processRow(db: Db, row: StatementRow, ctx: Ctx): Promise<void> {
  if (row.kind === 'credit') return processCredit(db, row, ctx);
  if (row.kind === 'reversal') return processReversal(db, row, ctx);
  // We hold this receipt as a payment, but the bank says it was not a completed sale.
  if (await findKnownReceipt(db, row.receipt)) {
    ctx.counts.attributionConflicts += 1;
    ctx.actions.push(`line ${row.line}: ${row.receipt} known receipt, statement says not a completed sale (${row.nonCreditReason}) → RECONCILE_ATTRIBUTION_CONFLICT`);
    if (ctx.write) {
      await alarmAndHold(db, ctx, 'RECONCILE_ATTRIBUTION_CONFLICT', row.receipt, `statement line ${row.line} says not a completed sale (${row.nonCreditReason})`);
    }
    return;
  }
  ctx.actions.push(`line ${row.line}: ${row.receipt} ignored (${row.nonCreditReason})`);
}
