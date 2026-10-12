/**
 * @file ufaa-report.ts
 * @description Admin CLI (spec gh-11, part 3b), UFAA step 2: at least 60 days after the notices,
 * write the holder report CSV (upload it to the UFAA portal) and freeze the reported escrows (no
 * longer claimable). Owners who claimed meanwhile are dropped. After 1 November it is still written,
 * with a LATE warning.
 *
 *   cd backend/gateway && npm run build
 *   npm run ufaa:report -- <return_id>
 */

import 'dotenv/config'; // must run before any module reads process.env
import { shutdownDb } from '../config/db';
import { kes } from '../repositories/ufaa.repository';
import { nairobiDate, UfaaService } from '../services/ufaa.service';
import { operator } from './payout-resolve';
import { CliError } from './user-create';

/** Runs step 2; returns the lines to print. Throws CliError when it cannot (exit 1). */
export async function ufaaReport(service: Pick<UfaaService, 'report'>, argv: string[], who = operator()): Promise<string> {
  const [id, ...extra] = argv;
  if (!id || extra.length) throw new CliError('usage: ufaa:report -- <return_id>');
  const r = await service.report(id, who);
  switch (r.kind) {
    case 'not_found':
      throw new CliError('no UFAA return with this id');
    case 'wrong_status':
      throw new CliError(
        r.ret.status === 'DRAFT'
          ? 'refused: not every owner has been noticed yet (re-run ufaa:prepare)'
          : `already reported: the return is ${r.ret.status} (${r.ret.reportPath})`
      );
    case 'too_early':
      throw new CliError(`refused: the owners were noticed less than 60 days ago; report on or after ${nairobiDate(r.earliest)}`);
    case 'reported': {
      const cents = kes(r.ret.reportedCents ?? 0);
      const lines = [
        `Return ${r.ret.returnId} (${r.ret.periodEnd}) is REPORTED: ${r.ret.reportedItems} owner(s), KES ${cents} ` +
          `(${r.ret.noticedItems - (r.ret.reportedItems ?? 0)} dropped: claimed or no longer dormant).`,
        `Holder report: ${r.ret.reportPath}`,
        `Upload it to the UFAA portal, transfer KES ${cents} to the Unclaimed Assets Trust Fund, then:`,
        `  npm run ufaa:remit -- ${r.ret.returnId} --reference <CBK reference>`,
      ];
      if (r.stale) lines.unshift('WARNING: the last notice was sent more than a year ago (the Act allows 60 days to 1 year): re-notice owners.');
      if (r.late) lines.unshift(`LATE: penalties may apply. The filing deadline was ${nairobiDate(r.deadline)}.`);
      return lines.join('\n');
    }
  }
}

if (require.main === module) {
  ufaaReport(new UfaaService(), process.argv.slice(2))
    .then((out) => (/^(LATE|WARNING)/.test(out) ? console.warn(out) : console.log(out)))
    .catch((error) => {
      console.error(`ufaa-report: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
