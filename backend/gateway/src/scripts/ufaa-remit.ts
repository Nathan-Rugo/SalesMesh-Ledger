/**
 * @file ufaa-remit.ts
 * @description Admin CLI (spec gh-11, part 3b), UFAA step 3: after the bank transfer of the reported
 * total to the Unclaimed Assets Trust Fund, mark the frozen escrows REMITTED (final: never claimable or
 * reminded again). An escrow security-held since the report is not remitted and stays frozen; its amount
 * was in the transfer and must be recovered from UFAA.
 *
 *   cd backend/gateway && npm run build
 *   npm run ufaa:remit -- <return_id> --reference <CBK reference>
 */

import 'dotenv/config'; // must run before any module reads process.env
import { shutdownDb } from '../config/db';
import { kes } from '../repositories/ufaa.repository';
import { UfaaService } from '../services/ufaa.service';
import { operator } from './payout-resolve';
import { CliError } from './user-create';

const USAGE = 'usage: ufaa:remit -- <return_id> --reference <CBK reference>';

/** Runs step 3; returns the lines to print. Throws CliError when it cannot (exit 1). */
export async function ufaaRemit(service: Pick<UfaaService, 'remit'>, argv: string[], who = operator()): Promise<string> {
  const [id, flag, reference, ...extra] = argv;
  if (!id || flag !== '--reference' || !reference || extra.length) throw new CliError(USAGE);
  const r = await service.remit(id, reference, who);
  switch (r.kind) {
    case 'not_found':
      throw new CliError('no UFAA return with this id');
    case 'invalid_reference':
      throw new CliError('the reference must be 1-100 letters, digits, ".", "/", "_" or "-"');
    case 'wrong_status':
      throw new CliError(
        r.ret.status === 'REMITTED'
          ? `already remitted (reference ${r.ret.reference})`
          : r.ret.status === 'DRAFT'
            ? 'refused: notices incomplete; re-run ufaa:prepare'
            : `refused: the return is ${r.ret.status}; run ufaa:report first`
      );
    case 'remitted': {
      const lines = [
        `Return ${r.ret.returnId} (${r.ret.periodEnd}) is REMITTED: ${r.ret.remittedItems} owner(s), KES ${kes(r.ret.remittedCents ?? 0)}, reference ${r.ret.reference}.`,
      ];
      if (r.held.length) {
        const cents = r.held.reduce((s, i) => s + i.amountCents, 0);
        const n = r.held.reduce((s, i) => s + i.escrowIds.length, 0);
        lines.push(
          `WARNING: ${n} escrow(s) of ${r.held.length} owner(s) security-held after the report (KES ${kes(cents)}): not remitted, kept frozen. ` +
            `This amount was in the transfer: recover KES ${kes(cents)} from UFAA.`
        );
      }
      return lines.join('\n');
    }
  }
}

if (require.main === module) {
  ufaaRemit(new UfaaService(), process.argv.slice(2))
    .then((out) => console.log(out))
    .catch((error) => {
      console.error(`ufaa-remit: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
