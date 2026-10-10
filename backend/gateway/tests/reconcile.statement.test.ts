/**
 * @file reconcile.statement.test.ts
 * @description M-Pesa statement CSV parsing (spec gh-6-recon): preamble, header aliases, BOM,
 * trailing totals, amounts with thousand separators, EAT → UTC, row classification, Other Party
 * Info (phone kept, name dropped), duplicates, and whole-file rejection with line numbers.
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_CREDIT_TYPES, reconcileImportConfig } from '../src/config/reconcile';
import { maskedPhoneParts, maskHashCandidates, msisdnMaskHash, parseOtherParty, stableStringify } from '../src/domain/callback';
import { checkIdentity } from '../src/reconcile/importer';
import { parseStatement, parseStatementAmount, parseStatementTime, parseTimePeriod, StatementError } from '../src/reconcile/statement';

const FIX = path.join(__dirname, 'fixtures', 'statements');
const read = (name: string) => fs.readFileSync(path.join(FIX, name));
const opts = { creditTypes: DEFAULT_CREDIT_TYPES };

function rejected(input: Buffer | string): string[] {
  try {
    parseStatement(input, opts);
  } catch (error) {
    expect(error).toBeInstanceOf(StatementError);
    return (error as StatementError).errors;
  }
  throw new Error('expected the statement to be rejected');
}

describe('statement parsing — happy fixture', () => {
  const s = parseStatement(read('happy.csv'), opts);

  it('reads the preamble (Short Code, Account, Time Period in EAT → UTC) despite the BOM', () => {
    expect(s.shortCode).toBe('174379');
    expect(s.account).toBe('Utility Account');
    expect(s.periodStart!.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(s.periodEnd!.toISOString()).toBe('2026-10-09T20:59:59.000Z');
  });

  it('finds the header by its Receipt No. column, skips the trailing Total row', () => {
    expect(s.rows.map((r) => r.receipt)).toEqual(['SJA1000001', 'SJA1000002', 'SJA1000003', 'SJA1000004', 'SJA1000005', 'SJA1000006']);
    expect(s.trailerRows).toBe(1);
    expect(s.rows[0].line).toBe(8);
  });

  it('parses quoted amounts with thousand separators, negative withdrawals, both date formats (EAT → UTC)', () => {
    expect(s.rows[0]).toMatchObject({ paidInCents: 150000, withdrawnCents: null, amountCents: 150000 });
    expect(s.rows[0].completionTime.toISOString()).toBe('2026-10-09T07:15:30.000Z');
    expect(s.rows[0].initiationTime!.toISOString()).toBe('2026-10-09T07:15:02.000Z');
    expect(s.rows[4].completionTime.toISOString()).toBe('2026-10-09T11:00:00.000Z'); // yyyy-mm-dd form
    expect(s.rows[5]).toMatchObject({ withdrawnCents: 500000 });
  });

  it('classifies: whitelisted completed paid-in rows are credits; charges, failed, transfers, withdrawals are not', () => {
    expect(s.rows.map((r) => [r.kind, r.nonCreditReason])).toEqual([
      ['credit', null],
      ['credit', null], // "Pay Bill from ..." Details
      ['non_credit', 'charge'],
      ['non_credit', 'not_completed'],
      ['non_credit', 'not_whitelisted'], // Business Transfer from: not a sale
      ['non_credit', 'withdrawal'],
    ]);
  });

  it('Other Party Info: full phone kept for hashing, masked phone as prefix/suffix, the name never kept', () => {
    expect(s.rows[0].otherParty).toEqual({ kind: 'full', msisdn: '254712345678' });
    expect(s.rows[1].otherParty).toEqual({ kind: 'masked', prefix: '2547', suffix: '678' });
    expect(s.rows[4].otherParty).toEqual({ kind: 'none' }); // a shortcode, not a phone
    expect(JSON.stringify(s)).not.toMatch(/JANE|JOHN|DOE|MARY|BANK/);
    expect(s.rows[1].accountNo).toBe('ag043');
  });

  it('identity check: Short Code must be the Daraja shortcode; Account must match RECONCILE_EXPECTED_ACCOUNT when set', () => {
    const cfg = (env: Record<string, string>) => reconcileImportConfig({ ...env } as any);
    expect(checkIdentity(s, cfg({ DARAJA_BUSINESS_SHORTCODE: '174379' }))).toEqual([]);
    expect(checkIdentity(s, cfg({ DARAJA_BUSINESS_SHORTCODE: '600000' }))[0]).toMatch(/not the Daraja shortcode/);
    expect(checkIdentity(s, cfg({ DARAJA_BUSINESS_SHORTCODE: '600000', DARAJA_PARTY_B: '174379' }))).toEqual([]);
    expect(checkIdentity(s, cfg({}))[0]).toMatch(/DARAJA_BUSINESS_SHORTCODE is not set/);
    expect(checkIdentity(s, cfg({ DARAJA_BUSINESS_SHORTCODE: '174379', RECONCILE_EXPECTED_ACCOUNT: 'utility  account' }))).toEqual([]);
    expect(checkIdentity(s, cfg({ DARAJA_BUSINESS_SHORTCODE: '174379', RECONCILE_EXPECTED_ACCOUNT: 'Working Account' }))[0]).toMatch(/RECONCILE_EXPECTED_ACCOUNT/);
  });
});

describe('statement parsing — other fixtures', () => {
  it('masked: "2547****678" and "07** *** 678" are masked phones; a bare name is no phone; date-only Time Period', () => {
    const s = parseStatement(read('masked.csv'), opts);
    expect(s.rows.map((r) => r.otherParty)).toEqual([
      { kind: 'masked', prefix: '2547', suffix: '678' },
      { kind: 'masked', prefix: '2547', suffix: '678' },
      { kind: 'none' },
    ]);
    expect(s.periodEnd!.toISOString()).toBe('2026-10-09T20:59:59.000Z');
  });

  it('reversal: keyed on Linked Transaction ID, amount from the (negative) withdrawal; unlinked kept as reversal', () => {
    const s = parseStatement(read('reversal.csv'), opts);
    expect(s.rows.map((r) => [r.kind, r.linkedReceipt, r.amountCents])).toEqual([
      ['reversal', 'SJA1000001', 150000],
      ['reversal', 'SJZ9999999', 10000],
      ['reversal', null, 5000],
    ]);
  });

  it('duplicate: an identical repeated row is kept once and counted; a conflicting repeat rejects the file', () => {
    const s = parseStatement(read('duplicate.csv'), opts);
    expect(s.rows.map((r) => r.receipt)).toEqual(['SJE5000001', 'SJE5000002']);
    expect(s.duplicateRows).toBe(1);
    const conflicting = read('duplicate.csv').toString().replace(/(SJE5000001,09-10-2026 10:15:30,09-10-2026 10:15:00,Pay Bill Online,Completed,)500\.00(,,500\.00,Pay Bill Online,,,AG042\s*)$/m, '$1999.00$2');
    expect(rejected(conflicting).join('\n')).toMatch(/line 5: receipt SJE5000001 also appears on line 4 with different values/);
  });

  it('malformed: ambiguous m/d/yyyy dates and European amounts reject the WHOLE file, with line numbers', () => {
    const errors = rejected(read('malformed.csv'));
    expect(errors).toEqual([
      expect.stringMatching(/^line 4: completion time "10\/9\/2026 10:15:30"/),
      expect.stringMatching(/^line 4: initiation time/),
      expect.stringMatching(/^line 5: Paid In "1\.500,00" is not an amount/),
    ]);
  });

  it('a missing required column, no header, a non-CSV file, or rows outside the Time Period reject the file', () => {
    const noAc = read('duplicate.csv').toString().replace(',A/C No.', ',Something');
    expect(rejected(noAc)[0]).toMatch(/missing required column\(s\): account/);
    expect(rejected('just,some,text\n1,2,3\n')[0]).toMatch(/no header row with a "Receipt No." column/);
    expect(rejected(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00]))[0]).toMatch(/not a CSV file/);
    expect(rejected(Buffer.from('PK\u0003\u0004xlsx'))[0]).toMatch(/not a CSV file/);
    const outside = read('duplicate.csv').toString().replace('09-10-2026 10:16:30', '12-10-2026 10:16:30');
    expect(rejected(outside)[0]).toMatch(/line 6: completion time is outside the statement's Time Period/);
    expect(rejected('')[0]).toMatch(/empty/);
  });
});

describe('statement integrity (review fixes)', () => {
  const head = 'Short Code:,174379\nTime Period:,From 01-10-2026 00:00:00 To 09-10-2026 23:59:59\n' +
    'Receipt No.,Completion Time,Initiation Time,Details,Transaction Status,Paid In,Withdrawn,Balance,Reason Type,Other Party Info,Linked Transaction ID,A/C No.\n';

  it('running Balance continuity: consistent fixtures pass; an edited / missing row is reported by line (either order)', () => {
    expect(parseStatement(read('happy.csv'), opts).balanceMismatchLines).toEqual([]);
    expect(parseStatement(read('masked.csv'), opts).balanceMismatchLines).toEqual([]);
    const rows = [
      'SJF6000001,09-10-2026 10:00:00,,Pay Bill Online,Completed,100.00,,1100.00,Pay Bill Online,,,AG042',
      'SJF6000002,09-10-2026 10:01:00,,Pay Bill Online,Completed,200.00,,1300.00,Pay Bill Online,,,AG042',
      'SJF6000003,09-10-2026 10:02:00,,Pay Bill Online,Completed,300.00,,1900.00,Pay Bill Online,,,AG042', // should be 1600
      'SJF6000004,09-10-2026 10:03:00,,Business Charge,Completed,,-50.00,1850.00,Pay Bill Charge,,,',
    ];
    expect(parseStatement(head + rows.join('\n'), opts).balanceMismatchLines).toEqual([6]);
    expect(parseStatement(head + [...rows].reverse().join('\n'), opts).balanceMismatchLines).toEqual([5]); // newest first
    // Not checked when any row prints no Balance.
    expect(parseStatement(head + rows.map((r, i) => (i === 0 ? r.replace('1100.00', '') : r)).join('\n'), opts).balanceMismatchLines).toEqual([]);
  });

  it('a data row with an empty Receipt No. rejects the file; only a recognised Total row is skipped', () => {
    const blankReceipt = head + ',09-10-2026 10:00:00,,Pay Bill Online,Completed,100.00,,100.00,Pay Bill Online,,,AG042\n';
    expect(rejected(blankReceipt)).toEqual(['line 4: a transaction row without a Receipt No.']);
    const total = head + 'SJF6000001,09-10-2026 10:00:00,,Pay Bill Online,Completed,100.00,,100.00,Pay Bill Online,,,AG042\nTotals:,,,,,100.00,,,,,,\n';
    expect(parseStatement(total, opts).trailerRows).toBe(1);
  });

  it('"revers" inside a payer name / Details stays a credit; Reason Type or a Details starting with "Reversal" is a reversal', () => {
    const s = parseStatement(head + [
      'SJF7000001,09-10-2026 10:00:00,,Pay Bill from 2547****678 - JANE REVERSO Acc. AG042,Completed,100.00,,,Pay Bill,2547****678 - JANE REVERSO,,AG042',
      'SJF7000002,09-10-2026 10:01:00,,Reversal of SJF7000001,Completed,,-100.00,,Business Payment,,SJF7000001,',
      'SJF7000003,09-10-2026 10:02:00,,Some text,Completed,,-10.00,,Reversal,,SJF7000001,',
    ].join('\n'), opts);
    expect(s.rows.map((r) => r.kind)).toEqual(['credit', 'reversal', 'reversal']);
  });

  it('Other Party Info: internal hyphens / spaces in the phone, or no " - " separator, keep the phone', () => {
    expect(parseOtherParty('0712-345-678 - JANE DOE')).toEqual({ kind: 'full', msisdn: '254712345678' });
    expect(parseOtherParty('254712345678 JANE DOE')).toEqual({ kind: 'full', msisdn: '254712345678' });
    expect(parseOtherParty('+254 712 345 678')).toEqual({ kind: 'full', msisdn: '254712345678' });
    expect(parseOtherParty('2547****678 JOHN')).toEqual({ kind: 'masked', prefix: '2547', suffix: '678' });
    expect(parseOtherParty('XAVIER DOE')).toEqual({ kind: 'none' });
    expect(parseOtherParty('600000 - SOME BANK')).toEqual({ kind: 'none' });
  });
});

describe('statement value parsers', () => {
  it('amounts → signed cents; invalid → undefined; empty → null', () => {
    expect(parseStatementAmount('1,500.00')).toBe(150000);
    expect(parseStatementAmount('-1,234,567.5')).toBe(-123456750);
    expect(parseStatementAmount('250')).toBe(25000);
    expect(parseStatementAmount('')).toBeNull();
    expect(parseStatementAmount('1.500,00')).toBeUndefined();
    expect(parseStatementAmount('12,34.00')).toBeUndefined();
    expect(parseStatementAmount('abc')).toBeUndefined();
  });

  it('times: only dd-mm-yyyy / yyyy-mm-dd HH:mm:ss (EAT), rollovers rejected', () => {
    expect(parseStatementTime('31-12-2026 23:59:59')!.toISOString()).toBe('2026-12-31T20:59:59.000Z');
    expect(parseStatementTime('2026-01-01 02:00:00')!.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(parseStatementTime('31-02-2026 10:00:00')).toBeNull();
    expect(parseStatementTime('10/9/2026 10:00:00')).toBeNull();
    expect(parseStatementTime('09-10-2026 10:00')).toBeNull();
    expect(parseTimePeriod('From 01-10-2026 To 02-10-2026')!.map((d) => d.toISOString())).toEqual([
      '2026-09-30T21:00:00.000Z',
      '2026-10-02T20:59:59.000Z',
    ]);
    expect(parseTimePeriod('yesterday')).toBeNull();
  });

  it('masked phones and fingerprints; Other Party never yields a name', () => {
    expect(maskedPhoneParts('2547****678')).toEqual({ prefix: '2547', suffix: '678' });
    expect(maskedPhoneParts('2547XXXXX678')).toEqual({ prefix: '2547', suffix: '678' });
    expect(maskedPhoneParts('0712345678')).toBeNull();
    expect(maskedPhoneParts('25****8')).toBeNull(); // too few visible digits
    expect(maskHashCandidates({ prefix: '2547', suffix: '678' })).toContain(msisdnMaskHash('254712345678'));
    expect(maskHashCandidates({ prefix: '2547', suffix: '679' })).not.toContain(msisdnMaskHash('254712345678'));
    expect(parseOtherParty('0712345678 - JANE')).toEqual({ kind: 'full', msisdn: '254712345678' });
    expect(parseOtherParty('JANE DOE')).toEqual({ kind: 'none' });
  });

  it('stableStringify sorts keys at every level and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});
