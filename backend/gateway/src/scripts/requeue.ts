/**
 * @file requeue.ts
 * @description Operator CLI: put UNRESOLVED / FAILED / DEAD intake rows back to PENDING.
 *
 *   npm run build && npm run requeue -- --status UNRESOLVED --receipt NLJ7RT61SV [--dry-run]
 *
 * Flags (repeatable): --status <UNRESOLVED|FAILED|DEAD>, --receipt <receipt>. At least one
 * filter is required. Counters and the UNRESOLVED retry window are reset; the worker picks the
 * rows up on its next poll. Uses the same DB_* settings as the gateway.
 */

import 'dotenv/config'; // must run before any module reads process.env
import pool, { shutdownDb } from '../config/db';
import { requeue, REQUEUEABLE, type IntakeStatus } from '../repositories/intake.repository';

function parseArgs(argv: string[]): { statuses: IntakeStatus[]; receipts: string[]; dryRun: boolean } {
  const statuses: IntakeStatus[] = [];
  const receipts: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--status') {
      const s = (argv[++i] ?? '').toUpperCase() as IntakeStatus;
      if (!REQUEUEABLE.includes(s)) throw new Error(`--status must be one of ${REQUEUEABLE.join(', ')}`);
      statuses.push(s);
    } else if (arg === '--receipt') {
      const r = argv[++i];
      if (!r) throw new Error('--receipt needs a value');
      receipts.push(r.trim().toUpperCase());
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (statuses.length === 0 && receipts.length === 0) {
    throw new Error('give at least one --status or --receipt filter');
  }
  return { statuses, receipts, dryRun };
}

async function main(): Promise<void> {
  const filter = parseArgs(process.argv.slice(2));
  const rows = await requeue(pool, filter);
  for (const r of rows) console.log(`${filter.dryRun ? 'would requeue' : 'requeued'} ${r.mpesa_receipt_id}${filter.dryRun ? ` (${r.status})` : ''}`);
  console.log(`${rows.length} row(s) ${filter.dryRun ? 'match' : 'requeued'}.`);
}

main()
  .catch((error) => {
    console.error(`requeue: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => shutdownDb());
