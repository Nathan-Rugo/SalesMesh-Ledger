/**
 * @file ufaa-prepare.ts
 * @description Admin CLI (spec gh-11, part 3b), UFAA step 1: snapshot the commission dormant at the
 * period end (a past 30 June) into a return and SMS-notice each owner. Re-run to retry failed notices;
 * with --accept-failed, a notice whose SMS still fails is recorded as a good-faith attempt
 * (undeliverable). Refuses without real SMS (AFRICASTALKING_*) or with PAYOUTS_ENABLED off.
 *
 *   cd backend/gateway && npm run build
 *   npm run ufaa:prepare -- 2026-06-30 [--accept-failed]
 */

import 'dotenv/config'; // must run before any module reads process.env
import { shutdownDb } from '../config/db';
import { kes } from '../repositories/ufaa.repository';
import { filingDeadline, nairobiDate, UfaaService } from '../services/ufaa.service';
import { operator } from './payout-resolve';
import { CliError } from './user-create';

/** Runs step 1; returns the line to print. Throws CliError when it cannot (exit 1). */
export async function ufaaPrepare(service: Pick<UfaaService, 'prepare'>, argv: string[], who = operator()): Promise<string> {
  const [period, ...flags] = argv;
  const acceptFailed = flags.length === 1 && flags[0] === '--accept-failed';
  if (!period || (flags.length && !acceptFailed)) throw new CliError('usage: ufaa:prepare -- <period_end YYYY-06-30> [--accept-failed]');
  const r = await service.prepare(period, who, { acceptFailed });
  switch (r.kind) {
    case 'sms_not_configured':
      throw new CliError('SMS is not configured (AFRICASTALKING_USERNAME / AFRICASTALKING_API_KEY): statutory notices cannot be sent; nothing written');
    case 'payouts_disabled':
      throw new CliError('refused: payouts are disabled (PAYOUTS_ENABLED is not true), so owners could not claim; nothing written');
    case 'invalid_period':
      throw new CliError(`refused: ${r.reason}; nothing written`);
    case 'nothing':
      return `Nothing to report for the period ending ${period}: no dormant commission. No return created.`;
    case 'already':
      throw new CliError(`already prepared: return ${r.ret.returnId} for ${period} is ${r.ret.status}`);
    case 'notices_failed':
      throw new CliError(
        `return ${r.ret.returnId} (${period}): ${r.sent} notice(s) sent, ${r.failed} FAILED; it stays DRAFT. ` +
          'Re-run ufaa:prepare to retry, or add --accept-failed to record undeliverable notices as good-faith attempts.'
      );
    case 'noticed': {
      const lines = [
        `Return ${r.ret.returnId} (${period}) is NOTICED: ${r.items} owner(s), KES ${kes(r.cents)} dormant; ` +
          `${r.sent} notice(s) sent now${r.undeliverable ? `, ${r.undeliverable} undeliverable (recorded as attempts)` : ''}. ` +
          `Report on or after ${nairobiDate(r.reportFrom)}: npm run ufaa:report -- ${r.ret.returnId}`,
      ];
      if (r.late) lines.push(`WARNING: the earliest report date is after the filing deadline (${nairobiDate(filingDeadline(period))}): the report will be LATE.`);
      return lines.join('\n');
    }
  }
}

if (require.main === module) {
  ufaaPrepare(new UfaaService(), process.argv.slice(2))
    .then((line) => console.log(line))
    .catch((error) => {
      console.error(`ufaa-prepare: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
