/**
 * @file trust-adjust.ts
 * @description Operator CLI (spec gh-23): an audited OPERATOR_ADJUST change to an agent's trust
 * rating, e.g. to undo a penalty raised by a clock-skew false alarm. The result is clamped to [0, 1].
 *
 *   npm run build && npm run trust:adjust -- --agent AG042 --delta 0.15 --reason "undo PAYMENT_REVERSED:NLJ7RT61SV" [--ref TICKET-123]
 *
 * --ref (at most 154 characters) makes the adjustment idempotent per agent (a second run with the
 * same ref on the same agent changes nothing); without it every run is a new adjustment. Uses the same DB_* settings as the gateway.
 */

import 'dotenv/config'; // must run before any module reads process.env
import crypto from 'crypto';
import os from 'os';
import pool, { shutdownDb } from '../config/db';
import { withTransaction } from '../repositories/db.types';
import { findAgent, MAX_OPERATOR_REF_LENGTH, operatorAdjust } from '../repositories/trust.repository';

export function parseAdjustArgs(argv: string[]): { agent: string; delta: number; reason: string; ref: string } {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--agent', '--delta', '--reason', '--ref'].includes(flag) || value === undefined) throw new Error(`unexpected argument: ${flag}`);
    opts[flag.slice(2)] = value;
  }
  const delta = Number(opts.delta);
  if (!opts.agent || !opts.reason?.trim() || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1) {
    throw new Error('usage: trust:adjust --agent <agent_code|agent_id> --delta <non-zero, -1..1> --reason <text> [--ref <id>]');
  }
  const ref = opts.ref?.trim() || crypto.randomUUID();
  if (ref.length > MAX_OPERATOR_REF_LENGTH) throw new Error(`--ref is longer than ${MAX_OPERATOR_REF_LENGTH} characters`);
  return { agent: opts.agent, delta, reason: opts.reason.trim(), ref };
}

async function main(): Promise<void> {
  const a = parseAdjustArgs(process.argv.slice(2));
  const agentId = await findAgent(pool, a.agent);
  if (!agentId) throw new Error(`no agent ${a.agent}`);
  let operator = 'unknown';
  try {
    operator = os.userInfo().username;
  } catch {
    /* no user info (container) */
  }
  const next = await withTransaction(pool, (tx) =>
    operatorAdjust(tx, { agentId, delta: a.delta, ref: a.ref, detail: `${a.reason} (via CLI by ${operator}@${os.hostname()})` })
  );
  console.log(next === null ? `adjustment ${a.ref} was already applied to agent ${a.agent}; nothing changed.` : `agent ${a.agent} rating is now ${next.toFixed(6)}.`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`trust:adjust: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
