/**
 * @file ufaa.service.ts
 * @description The annual Unclaimed Financial Assets Act return for dormant commission (spec gh-11,
 * part 3b). Unpaid wages unclaimed for more than UFAA_DORMANCY_YEARS (1) calendar year(s) after becoming payable are presumed
 * abandoned; the holder notices each owner 60 days to 1 year before filing, files by 1 November for
 * the 12 months to 30 June, and remits to the Unclaimed Assets Trust Fund. Three admin steps:
 *
 *   prepare <period_end>        snapshot the dormant escrows per agent; SMS notice each owner  → NOTICED
 *   report  <return_id>         ≥ 60 days after the notices: holder report CSV (local file);
 *                               the reported escrows are frozen (no longer claimable)           → REPORTED
 *   remit   <return_id> <ref>   after the CBK transfer of the reported total: frozen escrows REMITTED → REMITTED
 *
 * An agent who claims before the report drops out (a claim wins until the report). Nothing here moves
 * money or calls UFAA / CBK, and nothing runs on a timer: filing and remittance are human acts.
 */

import fs from 'fs/promises';
import path from 'path';
import pool from '../config/db';
import { ufaaDormancyYears } from '../domain/payout';
import { maskMsisdn } from '../domain/payout_destination';
import type { TxDb } from '../repositories/db.types';
import {
  createReturn,
  kes,
  liveItems,
  markNoticed,
  markReported,
  maxOwnerNo,
  pendingNotices,
  recordNotice,
  remit,
  type UfaaItem,
  type UfaaReturn,
} from '../repositories/ufaa.repository';
import { metrics as defaultMetrics, type GatewayMetrics } from './metrics.service';
import { LogNotifier, notifierFromEnv, notifySafely, type Notifier } from './notifier.service';
import { payoutsEnabled } from './payout_destination.service';

const DAY_MS = 86_400_000;
/** The Act: notice at least 60 days before filing. */
export const NOTICE_GAP_DAYS = 60;
const EAT_MS = 3 * 3600_000; // Africa/Nairobi: UTC+3, no DST

/** The Africa/Nairobi calendar date (YYYY-MM-DD) of an instant. */
export const nairobiDate = (d: Date): string => new Date(d.getTime() + EAT_MS).toISOString().slice(0, 10);
const longDate = (d: Date): string => new Date(d.getTime() + EAT_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export interface UfaaDeps {
  db?: TxDb;
  notifier?: Notifier;
  metrics?: GatewayMetrics;
  now?: () => Date;
  /** Where report CSVs are written (UFAA_REPORT_DIR, default ufaa-returns). */
  reportDir?: string;
  /** UFAA_HOLDER_ID_CODE: the 1-6 digit code UFAA issues on holder registration. */
  holderIdCode?: string;
  dormancyYears?: number;
}

export type PrepareResult =
  | { kind: 'invalid_period'; reason: string }
  /** Only the log-only notifier is configured: a statutory notice must really be sent. Nothing written. */
  | { kind: 'sms_not_configured' }
  /** PAYOUTS_ENABLED is not true: owners could not claim. Nothing written. */
  | { kind: 'payouts_disabled' }
  | { kind: 'nothing' }
  | { kind: 'already'; ret: UfaaReturn }
  /** Some notices could not be sent: the return stays DRAFT; re-run prepare to retry them. */
  | { kind: 'notices_failed'; ret: UfaaReturn; sent: number; failed: number }
  /**
   * `undeliverable`: notices recorded as good-faith attempts (--accept-failed); `items` / `cents`: the
   * live (not dropped) items; `late`: the earliest report date is already after the filing deadline.
   */
  | { kind: 'noticed'; ret: UfaaReturn; sent: number; undeliverable: number; items: number; cents: number; reportFrom: Date; late: boolean };

export type ReportResult =
  | { kind: 'not_found' }
  /** UFAA_HOLDER_ID_CODE missing or not 1-6 digits; nothing written. */
  | { kind: 'no_holder_code' }
  /** An owner serial does not fit the 8-digit ID number after the holder code; nothing written. */
  | { kind: 'owner_no_too_large'; ownerNo: number }
  | { kind: 'wrong_status'; ret: UfaaReturn }
  | { kind: 'too_early'; ret: UfaaReturn; earliest: Date }
  /** `stale`: the last notice is more than a year old (outside the Act's 60 days to 1 year): re-notice owners. */
  | { kind: 'reported'; ret: UfaaReturn; items: UfaaItem[]; late: boolean; deadline: Date; stale: boolean };

export type RemitResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_reference' }
  | { kind: 'wrong_status'; ret: UfaaReturn }
  /** `held`: escrows security-held after the report, not remitted and kept frozen (recover from UFAA). */
  | { kind: 'remitted'; ret: UfaaReturn; items: UfaaItem[]; held: UfaaItem[] };

/** One CSV cell: quoted when needed; a leading formula character is neutralised (CSV injection). */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ['owner_name', 'id_number', 'phone', 'amount_kes', 'asset_type', 'date_payable', 'holder_reference'];

/**
 * The owner's ID number. No national ID is held, so UFAA's fallback: the holder's ID code followed by
 * a serial, 8 digits in all (holder 45, owner 1 → 45000001). null when it does not fit.
 */
export function ownerIdNumber(holderIdCode: string, ownerNo: number): string | null {
  const width = 8 - holderIdCode.length;
  return Number.isInteger(ownerNo) && ownerNo > 0 && String(ownerNo).length <= width ? holderIdCode + String(ownerNo).padStart(width, '0') : null;
}

/** The holder report: one row per agent still holding dormant commission. */
export function holderReportCsv(items: readonly UfaaItem[], holderIdCode: string): string {
  const rows = items.map((i) => [
    i.ownerName,
    ownerIdNumber(holderIdCode, i.ownerNo) ?? '',
    i.msisdn,
    kes(i.amountCents),
    'Unpaid commission',
    nairobiDate(i.payableFrom),
    i.itemId,
  ]);
  return [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The filing deadline for a period: end of 1 November (Africa/Nairobi) of the period's year. */
export const filingDeadline = (periodEnd: string): Date => new Date(Date.parse(`${periodEnd.slice(0, 4)}-11-02T00:00:00+03:00`) - 1);

export class UfaaService {
  private readonly db: TxDb;
  private readonly notifier: Notifier;
  private readonly metrics: GatewayMetrics;
  private readonly now: () => Date;
  private readonly reportDir: string;
  private readonly holderIdCode: string;
  private readonly years?: number;

  constructor(deps: UfaaDeps = {}) {
    this.db = deps.db ?? pool;
    this.notifier = deps.notifier ?? notifierFromEnv();
    this.metrics = deps.metrics ?? defaultMetrics;
    this.now = deps.now ?? (() => new Date());
    this.reportDir = deps.reportDir ?? (process.env.UFAA_REPORT_DIR?.trim() || 'ufaa-returns');
    this.holderIdCode = (deps.holderIdCode ?? process.env.UFAA_HOLDER_ID_CODE ?? '').trim();
    this.years = deps.dormancyYears;
  }

  /**
   * Step 1: the return for `periodEnd` (a past 30 June) and one SMS notice per owner. Resumes a DRAFT.
   * `acceptFailed`: a notice whose SMS still fails is recorded as a good-faith attempt (undeliverable).
   */
  async prepare(periodEnd: string, operator: string, opts: { acceptFailed?: boolean } = {}): Promise<PrepareResult> {
    const now = this.now();
    if (this.notifier instanceof LogNotifier) return { kind: 'sms_not_configured' };
    if (!payoutsEnabled()) return { kind: 'payouts_disabled' };
    if (!/^\d{4}-06-30$/.test(periodEnd)) return { kind: 'invalid_period', reason: 'the period must end on a 30 June (YYYY-06-30)' };
    if (periodEnd >= nairobiDate(now)) return { kind: 'invalid_period', reason: 'the period has not ended yet' };
    const created = await createReturn(this.db, periodEnd, this.years ?? ufaaDormancyYears());
    if (created.kind === 'nothing') return created;
    if (created.ret.status !== 'DRAFT') return { kind: 'already', ret: created.ret };

    const ret = created.ret;
    const reportFrom = new Date(now.getTime() + NOTICE_GAP_DAYS * DAY_MS);
    let sent = 0;
    let failed = 0;
    let undeliverable = 0;
    const live = await liveItems(this.db, ret.returnId, now); // never notice an owner who has claimed since the snapshot
    for (const item of await pendingNotices(this.db, ret.returnId)) {
      const text =
        `SalesMesh: KES ${kes(item.amountCents)} unpaid commission has been waiting for you since ${longDate(item.payableFrom)}. ` +
        `Claim it in the SalesMesh app before ${longDate(reportFrom)} or it will be transferred to the Unclaimed Financial Assets Authority.`;
      const ok = await notifySafely(this.notifier, item.msisdn, text, this.metrics);
      console.info(`[UFAA] return ${periodEnd} notice to ${maskMsisdn(item.msisdn)} (KES ${kes(item.amountCents)}): ${ok ? 'sent' : 'FAILED'}`);
      if (!ok && opts.acceptFailed) {
        await recordNotice(this.db, ret, item, this.now(), `notice SMS undeliverable; recorded as a good-faith attempt (--accept-failed) by ${operator}`);
        undeliverable += 1;
        continue;
      }
      if (!ok) {
        failed += 1;
        continue;
      }
      await recordNotice(this.db, ret, item, this.now(), `owner noticed by SMS (claim before ${nairobiDate(reportFrom)}) by ${operator}`);
      sent += 1;
    }
    const noticed = await markNoticed(this.db, ret.returnId, this.now());
    if (!noticed) return { kind: 'notices_failed', ret, sent, failed };
    const earliest = new Date(noticed.noticedAt!.getTime() + NOTICE_GAP_DAYS * DAY_MS);
    return {
      kind: 'noticed',
      ret: noticed,
      sent,
      undeliverable,
      items: live.length,
      cents: live.reduce((n, i) => n + i.amountCents, 0),
      reportFrom: earliest,
      late: earliest > filingDeadline(periodEnd),
    };
  }

  /** Step 2: the holder report CSV, ≥ 60 days after the last notice. Late after 1 November: still written. */
  async report(returnId: string, operator: string): Promise<ReportResult> {
    const now = this.now();
    const earliest = (r: UfaaReturn) => new Date(r.noticedAt!.getTime() + NOTICE_GAP_DAYS * DAY_MS);
    // The ID number column is mandatory: check it can be built before anything is written.
    if (!/^\d{1,6}$/.test(this.holderIdCode)) return { kind: 'no_holder_code' };
    const maxNo = await maxOwnerNo(this.db, returnId);
    if (maxNo !== null && ownerIdNumber(this.holderIdCode, maxNo) === null) return { kind: 'owner_no_too_large', ownerNo: maxNo };
    const r = await markReported(
      this.db,
      returnId,
      now,
      (ret) => now >= earliest(ret),
      async (ret, items) => {
        await fs.mkdir(this.reportDir, { recursive: true });
        const file = path.resolve(this.reportDir, `ufaa-return-${ret.periodEnd}-${ret.returnId}.csv`);
        await fs.writeFile(file, holderReportCsv(items, this.holderIdCode), { encoding: 'utf8', mode: 0o600 }); // names and phones
        return file;
      },
      `reported to UFAA (holder report) by ${operator}`
    );
    if (r.kind === 'not_found' || r.kind === 'wrong_status') return r;
    if (r.kind === 'too_early') return { kind: 'too_early', ret: r.ret, earliest: earliest(r.ret) };
    const deadline = filingDeadline(r.ret.periodEnd);
    const yearAfterNotice = new Date(r.ret.noticedAt!);
    yearAfterNotice.setUTCFullYear(yearAfterNotice.getUTCFullYear() + 1);
    return { kind: 'reported', ret: r.ret, items: r.items, late: now > deadline, deadline, stale: now > yearAfterNotice };
  }

  /** Step 3: after the CBK transfer of the reported total, the frozen escrows become REMITTED. */
  async remit(returnId: string, reference: string, operator: string): Promise<RemitResult> {
    const ref = reference.trim();
    if (!/^[\w./-]{1,100}$/.test(ref)) return { kind: 'invalid_reference' };
    const r = await remit(this.db, returnId, ref, this.now(), `remitted to the Unclaimed Assets Trust Fund (CBK reference ${ref}) by ${operator}`);
    if (r.kind === 'done') return { kind: 'remitted', ret: r.ret, items: r.items, held: r.held };
    if (r.kind === 'too_early') return { kind: 'wrong_status', ret: r.ret };
    return r;
  }
}
