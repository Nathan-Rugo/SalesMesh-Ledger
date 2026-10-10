/**
 * @file reconcile-import.ts
 * @description Admin CLI: import an M-Pesa org-portal statement (CSV) to recover payments the
 * gateway never learned of (spec gh-6-recon). Runbook: docs/operations/reconciliation.md.
 *
 *   npm run build && npm run reconcile:import -- statement.csv --operator 0722000000 [--dry-run] [--confirm]
 *
 *   --operator  user_id or phone of an active MERCHANT_ADMIN (recorded on the run). Required.
 *   --dry-run   print the would-be actions and counts; writes only the run record.
 *   --confirm   required above RECONCILE_CONFIRM_MAX_ROWS / RECONCILE_CONFIRM_MAX_AMOUNT new payments.
 *
 * Exit codes: 0 done (including a no-op re-import), 1 rejected (bad file, wrong statement, operator,
 * caps, another import running) or failed. Output carries receipts, line numbers and counts only.
 * This CLI is a separate process: recovered rows settle on the gateway settlement worker's next
 * poll (<= WORKER_POLL_INTERVAL_MS).
 */

import 'dotenv/config'; // must run before any module reads process.env
import { shutdownDb } from '../config/db';
import { ImportRejected, importStatement, type ImportReport } from '../reconcile/importer';

export class CliError extends Error {}

export interface CliArgs {
  filePath: string;
  operator: string;
  dryRun: boolean;
  confirm: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let filePath = '';
  let operator = '';
  let dryRun = false;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--confirm') confirm = true;
    else if (a === '--operator') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new CliError('--operator needs a value');
      operator = v;
    } else if (a.startsWith('--')) throw new CliError(`unknown argument: ${a}`);
    else if (!filePath) filePath = a;
    else throw new CliError(`unexpected argument: ${a}`);
  }
  if (!filePath) throw new CliError('give the statement CSV file: reconcile:import -- <file.csv> --operator <phone|user_id>');
  if (!operator) throw new CliError('--operator <phone|user_id> of an active MERCHANT_ADMIN is required');
  return { filePath, operator, dryRun, confirm };
}

export function formatReport(r: ImportReport): string[] {
  const c = r.counts;
  const out: string[] = [];
  const head =
    r.outcome === 'NOOP'
      ? `Already imported (run ${r.noopOfRunId}): nothing changed. Recorded as run ${r.runId}.`
      : r.outcome === 'DRY_RUN'
        ? `DRY RUN (run ${r.runId}): nothing was written except the run record.`
        : `Imported (run ${r.runId}).`;
  out.push(head, `File SHA-256: ${r.sha256}`);
  if (r.evidencePath) out.push(`Evidence copy: ${r.evidencePath}`);
  for (const w of r.warnings) out.push(`WARNING: ${w}`);
  if (r.outcome === 'DRY_RUN') {
    out.push(
      r.confirmRequired.length
        ? `A real import of this file needs --confirm: ${r.confirmRequired.join('; ')}`
        : 'A real import of this file does not need --confirm.'
    );
  }
  if (r.outcome !== 'NOOP') {
    out.push('', ...r.actions.map((a) => `  ${a}`), '');
    const nc = Object.entries(c.nonCredit).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    out.push(
      `Rows ${c.rows} (credits ${c.credits}, reversals ${c.reversals}, ignored: ${nc}; duplicate rows ${c.duplicateRows}, total rows ${c.trailerRows})`,
      `${r.outcome === 'DRY_RUN' ? 'Would recover' : 'Recovered'} ${c.newPayments} payment(s): ${c.boundStk} bound to an STK request, ${c.unbound} by account number, ${c.statusConflicts} STK status conflict(s)`,
      `Known receipts: ${c.verified} verified, ${c.amountMismatches} amount mismatch(es), ${c.attributionConflicts} attribution conflict(s)`,
      `Reversals: ${c.reversalsOfKnown} of known receipts, ${c.reversalsOfUnknown} of unknown, ${c.reversalsUnlinked} unlinked; ${c.clawbacksDue} CLAWBACK_DUE`,
      `Two-way: ${c.notOnStatement} callback receipt(s) missing from the statement (${c.notOnStatementReleased} already RELEASED → exception)`
    );
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await importStatement(args);
  for (const line of formatReport(report)) console.log(line);
  if (report.outcome === 'COMPLETED' && report.rowsNew > 0) {
    console.log('The gateway settlement worker picks the recovered rows up on its next poll (<= WORKER_POLL_INTERVAL_MS): ML scoring → escrow.');
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      if (error instanceof ImportRejected) {
        console.error('reconcile:import: rejected — nothing was imported:');
        for (const p of error.problems) console.error(`  - ${p}`);
      } else {
        console.error(`reconcile:import: ${error instanceof CliError ? error.message : (error as Error).message}`);
      }
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
