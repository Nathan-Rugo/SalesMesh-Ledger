/**
 * @file ledger-requeue.ts
 * @description Operator CLI (DLT-03, #10): re-arm a DEAD ledger outbox row once its cause is fixed.
 *
 *   npm run build && npm run ledger:requeue -- <outbox_id>
 *
 * The row goes back to PENDING with its attempts reset and is sent unchanged (the stored request).
 * The outbox ids and errors of DEAD rows: SELECT outbox_id, op, last_error FROM ledger_outbox WHERE status = 'DEAD'.
 */

import 'dotenv/config'; // must run before any module reads process.env
import pool, { shutdownDb } from '../config/db';
import { requeueDead } from '../repositories/ledger.repository';

async function main(): Promise<void> {
  const id = process.argv[2] ?? '';
  const r = await requeueDead(pool, id);
  if (!r) throw new Error(`no DEAD ledger outbox row ${JSON.stringify(id)}`);
  console.log(`requeued ledger outbox row ${id} (${r.op}); its last error was: ${r.lastError ?? 'none'}`);
}

main()
  .catch((error) => {
    console.error(`ledger:requeue: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => shutdownDb());
