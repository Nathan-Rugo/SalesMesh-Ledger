/**
 * @file payout-resolve.ts
 * @description Admin CLI (spec gh-11, part 2): settle an UNRESOLVED payout (Transaction Status gave
 * no definitive answer) from M-Pesa evidence, e.g. the B2C org portal or a statement line.
 *   paid <receipt>: PAID, escrows RELEASED, carry updated.  failed: FAILED, escrows claimable again.
 * Writes the PAYOUT_STATUS_CHANGED event ("resolved by admin <OS user>") and sends the SMS alert.
 *
 *   cd backend/gateway && npm run build
 *   npm run payout:resolve -- <payout_id> paid <receipt>
 *   npm run payout:resolve -- <payout_id> failed
 */

import 'dotenv/config'; // must run before any module reads process.env
import os from 'os';
import { shutdownDb } from '../config/db';
import { maskMsisdn } from '../domain/payout_destination';
import { payoutService, type PayoutService } from '../services/payout.service';
import { CliError } from './user-create';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT_RE = /^[A-Z0-9]{8,20}$/;
const USAGE = 'usage: payout:resolve -- <payout_id (uuid)> paid <M-Pesa receipt> | <payout_id (uuid)> failed';

export function parsePayoutResolveArgs(argv: string[]): { id: string; o: { paid: true; receipt: string } | { paid: false } } {
  const [id, verdict, receipt, ...extra] = argv;
  if (!id || !UUID_RE.test(id) || extra.length) throw new CliError(USAGE);
  if (verdict === 'failed' && receipt === undefined) return { id, o: { paid: false } };
  const r = receipt?.trim().toUpperCase() ?? '';
  if (verdict === 'paid' && RECEIPT_RE.test(r)) return { id, o: { paid: true, receipt: r } };
  throw new CliError(USAGE);
}

/** The OS account running the CLI, recorded in the event as the operator. */
function operator(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolves and waits for the alert; returns the line to print. Throws CliError when it cannot. */
export async function payoutResolve(service: Pick<PayoutService, 'adminResolve' | 'settled'>, argv: string[]): Promise<string> {
  const { id, o } = parsePayoutResolveArgs(argv);
  const r = await service.adminResolve(id, o, operator());
  await service.settled();
  if (r.kind === 'not_found') throw new CliError('no payout with this id');
  if (r.kind === 'not_unresolved') throw new CliError(`only an UNRESOLVED payout can be resolved (this one is ${r.status})`);
  return `Payout ${id} (KES ${r.payout.amount} to ${maskMsisdn(r.payout.msisdn)}) is now ${r.payout.status}; the agent was alerted.`;
}

if (require.main === module) {
  payoutResolve(payoutService, process.argv.slice(2))
    .then((line) => console.log(line))
    .catch((error) => {
      console.error(`payout-resolve: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
