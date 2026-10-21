/**
 * @file ledger-init.ts
 * @description Operator CLI (DLT-03, #10): initialise the commission chaincode and backfill the outbox.
 *
 *   npm run build && npm run ledger:init
 *
 * 1. InitLedger as gateway@merchant (idempotent: a repeat returns the existing meta record), retried
 *    on infrastructure errors for up to 60 s.
 * 2. Queues a CommitTransaction for every HELD / QUARANTINED escrow that has none (settled before the
 *    LEDGER_*_HMAC_KEYs were set). Safe to re-run. Needs the FABRIC_* settings and the keys.
 */

import 'dotenv/config'; // must run before any module reads process.env
import pool, { shutdownDb } from '../config/db';
import { fabricConfig } from '../config/fabric';
import type { TxDb } from '../repositories/db.types';
import { backfillCommits } from '../repositories/ledger.repository';
import { fabricLedger, type LedgerClient } from '../services/fabric.service';

export async function ledgerInit(db: TxDb, ledger: LedgerClient, o: { timeoutMs?: number; log?: (s: string) => void } = {}): Promise<{ meta: unknown; backfilled: number }> {
  const log = o.log ?? console.log;
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const r = await ledger.submit('InitLedger', '{}');
    if (r.ok) {
      log(`InitLedger committed in block ${r.blockNumber} (tx ${r.txId}): ${r.result}`);
      const backfilled = await backfillCommits(db);
      log(`${backfilled} escrow(s) queued for CommitTransaction.`);
      return { meta: JSON.parse(r.result), backfilled };
    }
    if (r.code || Date.now() > deadline) throw new Error(`InitLedger failed: ${r.message}`);
    log(`InitLedger not committed yet (${r.message}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

if (require.main === module) {
  fabricConfig(); // fail fast on a bad FABRIC_* / key setting
  const ledger = fabricLedger();
  ledgerInit(pool, ledger)
    .catch((error) => {
      console.error(`ledger:init: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => {
      ledger.close();
      return shutdownDb();
    });
}
