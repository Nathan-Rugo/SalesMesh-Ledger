/**
 * @file reconcile.cli.test.ts
 * @description reconcile:import argument parsing (a broken --dry-run would run a real import).
 */

import { CliError, parseArgs } from '../src/scripts/reconcile-import';

describe('reconcile:import parseArgs', () => {
  it('--dry-run and --confirm set their flags; the file and --operator are taken', () => {
    expect(parseArgs(['s.csv', '--operator', '0722000000', '--dry-run'])).toEqual({ filePath: 's.csv', operator: '0722000000', dryRun: true, confirm: false });
    expect(parseArgs(['--operator', 'u-1', 's.csv', '--confirm'])).toEqual({ filePath: 's.csv', operator: 'u-1', dryRun: false, confirm: true });
    expect(parseArgs(['s.csv', '--operator', 'x']).dryRun).toBe(false);
  });

  it('refuses a missing --operator value, a missing operator / file, unknown flags and extra arguments', () => {
    expect(() => parseArgs(['s.csv', '--operator'])).toThrow(CliError);
    expect(() => parseArgs(['s.csv', '--operator', '--dry-run'])).toThrow(/--operator needs a value/);
    expect(() => parseArgs(['s.csv'])).toThrow(/--operator/);
    expect(() => parseArgs(['--operator', 'x'])).toThrow(/statement CSV file/);
    expect(() => parseArgs(['s.csv', '--operator', 'x', '--dryrun'])).toThrow(/unknown argument: --dryrun/);
    expect(() => parseArgs(['a.csv', 'b.csv', '--operator', 'x'])).toThrow(/unexpected argument/);
  });
});
