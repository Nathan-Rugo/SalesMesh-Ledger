/**
 * @file user-create.ts
 * @description Admin CLI: provision a user (and, for agents, the sales_agents row) with a one-time PIN.
 *
 *   npm run build && npm run user:create -- --role SALES_AGENT --name "Jane Wanjiku" \
 *       --phone 0712345678 --agent-code AG042 --outlet OUT-NBI-01
 *   npm run user:create -- --role MERCHANT_ADMIN --name "Ops Admin" --phone 0722000000
 *
 * Optional for a new outlet: --create-outlet --region Nairobi --baseline 150000.
 *
 * Everything is written in ONE transaction (no partial rows on error). The one-time PIN is printed
 * once, expires after 72 h, and must be changed at first login (must_change). Exit code 1 with a
 * clear message on a duplicate phone / agent code, a bad phone, or a missing outlet.
 */

import 'dotenv/config'; // must run before any module reads process.env
import pool, { shutdownDb } from '../config/db';
import { generateOneTimePin, hashPin, ONE_TIME_PIN_TTL_MS } from '../auth/credentials';
import { isRole, type Role } from '../auth/tokens';
import { isPhoneLike, normaliseKenyanMsisdn } from '../domain/callback';
import { upsertCredential } from '../repositories/auth.repository';
import { withTransaction, type TxDb } from '../repositories/db.types';

export class CliError extends Error {}

export interface CreateUserInput {
  role: Role;
  name: string;
  phone: string;
  agentCode: string | null;
  outlet: string | null;
  createOutlet: { region: string; baseline: number } | null;
}

/** Daraja AccountReference limit (also a DB CHECK). */
const AGENT_CODE_RE = /^[A-Z0-9-]{1,12}$/;

export function parseArgs(argv: string[]): CreateUserInput {
  const opts: Record<string, string> = {};
  let createOutlet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--create-outlet') {
      createOutlet = true;
      continue;
    }
    const m = /^--(role|name|phone|agent-code|outlet|region|baseline)$/.exec(arg);
    if (!m) throw new CliError(`unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} needs a value`);
    opts[m[1]] = value;
  }

  const role = (opts.role ?? '').trim().toUpperCase();
  if (!isRole(role)) throw new CliError('--role must be SALES_AGENT or MERCHANT_ADMIN');
  const name = (opts.name ?? '').trim();
  if (!name || name.length > 150) throw new CliError('--name is required (at most 150 characters)');
  const phone = normaliseKenyanMsisdn(opts.phone);
  if (!phone) throw new CliError('--phone must be a Kenyan mobile number (07XXXXXXXX, 01XXXXXXXX or 254XXXXXXXXX)');

  let agentCode: string | null = null;
  let outlet: string | null = null;
  let outletSpec: CreateUserInput['createOutlet'] = null;
  if (role === 'SALES_AGENT') {
    agentCode = (opts['agent-code'] ?? '').trim().toUpperCase();
    if (!AGENT_CODE_RE.test(agentCode)) {
      throw new CliError('--agent-code is required for SALES_AGENT: 1-12 of A-Z 0-9 - (it is the Daraja AccountReference)');
    }
    if (isPhoneLike(agentCode)) throw new CliError('--agent-code must not look like a phone number');
    outlet = (opts.outlet ?? '').trim();
    if (!outlet || outlet.length > 50) throw new CliError('--outlet (an outlet_code) is required for SALES_AGENT');
    if (createOutlet) {
      const region = (opts.region ?? '').trim();
      const baseline = Number(opts.baseline);
      if (!region || !Number.isFinite(baseline) || baseline < 0) {
        throw new CliError('--create-outlet needs --region and a non-negative --baseline');
      }
      outletSpec = { region, baseline };
    }
  } else if (opts['agent-code'] || opts.outlet || createOutlet) {
    throw new CliError('--agent-code / --outlet apply to SALES_AGENT only');
  }
  return { role, name, phone, agentCode, outlet, createOutlet: outletSpec };
}

const UNIQUE_MESSAGES: Record<string, string> = {
  users_phone_number_key: 'a user with this phone number already exists',
  sales_agents_agent_code_key: 'this agent code is already in use',
  retail_outlets_outlet_code_key: 'an outlet with this code already exists (drop --create-outlet to use it)',
};

/** Creates the user, credential and (for agents) the agent row atomically. Returns the one-time PIN. */
export async function createUser(
  db: TxDb,
  input: CreateUserInput
): Promise<{ userId: string; agentId: string | null; oneTimePin: string; expiresAt: Date }> {
  const oneTimePin = generateOneTimePin();
  const cred = await hashPin(oneTimePin);
  const expiresAt = new Date(Date.now() + ONE_TIME_PIN_TTL_MS);
  try {
    return await withTransaction(db, async (tx) => {
      const { rows: [u] } = await tx.query(
        `INSERT INTO users (full_name, phone_number, role) VALUES ($1, $2, $3) RETURNING user_id`,
        [input.name, input.phone, input.role]
      );
      await upsertCredential(tx, u.user_id, cred, { mustChange: true, oneTimeExpiresAt: expiresAt });
      let agentId: string | null = null;
      if (input.role === 'SALES_AGENT') {
        let outletId: string | undefined;
        if (input.createOutlet) {
          const { rows: [o] } = await tx.query(
            `INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ($1, $2, $3) RETURNING outlet_id`,
            [input.outlet, input.createOutlet.region, input.createOutlet.baseline]
          );
          outletId = o.outlet_id;
        } else {
          const { rows } = await tx.query(`SELECT outlet_id FROM retail_outlets WHERE outlet_code = $1`, [input.outlet]);
          outletId = rows[0]?.outlet_id;
          if (!outletId) throw new CliError(`outlet ${input.outlet} does not exist (add --create-outlet --region R --baseline N)`);
        }
        const { rows: [a] } = await tx.query(
          `INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, $3) RETURNING agent_id`,
          [u.user_id, outletId, input.agentCode]
        );
        agentId = a.agent_id;
      }
      return { userId: u.user_id as string, agentId, oneTimePin, expiresAt };
    });
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint && UNIQUE_MESSAGES[e.constraint]) throw new CliError(UNIQUE_MESSAGES[e.constraint]);
    if (e.code === '23514') throw new CliError(`rejected by the database (${e.constraint ?? 'check constraint'})`);
    throw error;
  }
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const r = await createUser(pool, input);
  console.log(`Created ${input.role} "${input.name}" (user_id ${r.userId}${r.agentId ? `, agent_id ${r.agentId}, agent_code ${input.agentCode}` : ''}).`);
  console.log('');
  console.log(`  One-time PIN: ${r.oneTimePin}`);
  console.log('');
  console.log(`Shown only once. It expires ${r.expiresAt.toISOString()} and must be changed at first login.`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`user:create: ${error instanceof CliError ? error.message : (error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
