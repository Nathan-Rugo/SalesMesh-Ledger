/**
 * @file payout-cancel.ts
 * @description Admin CLI (spec gh-11): cancel a COOLING_OFF payout destination, e.g. a replacement
 * registered after a hijacked phone change, which locks the real owner out of the agent cancel.
 * Writes the PAYOUT_DESTINATION_CHANGED event ("cancelled by admin") and sends the CANCELLED alerts.
 *
 *   cd backend/gateway && npm run build
 *   npm run payout:cancel -- <destination_id>
 */

import 'dotenv/config'; // must run before any module reads process.env
import { shutdownDb } from '../config/db';
import { maskMsisdn } from '../domain/payout_destination';
import { payoutDestinationService, type PayoutDestinationService } from '../services/payout_destination.service';
import { CliError } from './user-create';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePayoutCancelArgs(argv: string[]): string {
  const [id, ...extra] = argv;
  if (!id || extra.length || !UUID_RE.test(id)) throw new CliError('usage: payout:cancel -- <destination_id (uuid)>');
  return id;
}

/** Cancels and waits for the alerts; returns the line to print. Throws CliError when it cannot. */
export async function payoutCancel(service: Pick<PayoutDestinationService, 'adminCancel' | 'settled'>, argv: string[]): Promise<string> {
  const id = parsePayoutCancelArgs(argv);
  const r = await service.adminCancel(id);
  await service.settled();
  if (r.kind === 'not_found') throw new CliError('no payout destination with this id');
  if (r.kind === 'not_cancellable') throw new CliError('only a COOLING_OFF destination can be cancelled');
  return `Cancelled payout destination ${id} (${maskMsisdn(r.destination.msisdn)}); the agent was alerted.`;
}

if (require.main === module) {
  payoutCancel(payoutDestinationService, process.argv.slice(2))
    .then((line) => console.log(line))
    .catch((error) => {
      console.error(`payout-cancel: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
