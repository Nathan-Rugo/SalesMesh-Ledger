/**
 * @file payout.ts
 * @description Pure rules for agent-claimed payouts (spec gh-11, part 2): configuration, the
 * versioned Fuliza disclosure, the consent hash and the claim split (whole shillings + carry).
 */

import crypto from 'crypto';

export type PayoutStatus = 'SENT' | 'UNKNOWN' | 'PAID' | 'FAILED' | 'UNRESOLVED';

/**
 * The Fuliza disclosure an agent accepts before each claim, by version. Never edit a published
 * text: add a new version and point PAYOUT_DISCLOSURE_VERSION at it (stored consents hash the text).
 */
export const DISCLOSURES: Readonly<Record<string, string>> = {
  '1':
    'Your commission is paid to your verified M-Pesa line. If that line has an outstanding Fuliza ' +
    'balance, Safaricom may automatically use this payment to repay it, and SalesMesh cannot reverse ' +
    'that deduction. Clear any Fuliza balance before you claim if you want to receive the full amount. ' +
    'Commission is paid gross: no tax is withheld, and you are responsible for declaring it.',
};

export interface PayoutConfig {
  /** Whole shillings: a claim paying less is refused. */
  minAmount: number;
  /** Whole shillings: one payout never exceeds this; the rest stays claimable. */
  maxAmount: number;
  /** A SENT / UNKNOWN payout older than this is checked by Transaction Status. */
  statusAfterMs: number;
  /** Transaction Status attempts before the payout becomes UNRESOLVED. */
  statusMaxAttempts: number;
  disclosureVersion: string;
  /** Unclaimed reminder stages 1..3: days since the oldest claimable escrow matured (strictly increasing). */
  reminderDays: [number, number, number];
  /** Reminders are sent only from the first to before the second hour, Africa/Nairobi. */
  reminderHours: [number, number];
}

export class PayoutConfigError extends Error {}

function posInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name]?.trim() ?? '';
  if (!v) return fallback;
  if (!/^\d{1,9}$/.test(v) || Number(v) <= 0) throw new PayoutConfigError(`${name} must be a positive whole number`);
  return Number(v);
}

/** A comma list of exactly `n` strictly increasing whole numbers within [min, max]. */
function intList(env: NodeJS.ProcessEnv, name: string, fallback: number[], min: number, max: number): number[] {
  const v = env[name]?.trim() ?? '';
  if (!v) return fallback;
  const xs = v.split(',').map((x) => x.trim());
  const ok = xs.length === fallback.length && xs.every((x, i) => /^\d{1,4}$/.test(x) && +x >= min && +x <= max && (i === 0 || +x > +xs[i - 1]));
  if (!ok) throw new PayoutConfigError(`${name} must be ${fallback.length} strictly increasing whole numbers from ${min} to ${max}, comma-separated`);
  return xs.map(Number);
}

/** PAYOUT_* settings with their defaults; throws PayoutConfigError on an invalid value. */
export function payoutConfig(env: NodeJS.ProcessEnv = process.env): PayoutConfig {
  const cfg = {
    minAmount: posInt(env, 'PAYOUT_MIN_AMOUNT', 10),
    maxAmount: posInt(env, 'PAYOUT_MAX_AMOUNT', 150_000),
    statusAfterMs: posInt(env, 'PAYOUT_STATUS_AFTER_MS', 600_000),
    statusMaxAttempts: posInt(env, 'PAYOUT_STATUS_MAX_ATTEMPTS', 6),
    disclosureVersion: env.PAYOUT_DISCLOSURE_VERSION?.trim() || '1',
    reminderDays: intList(env, 'PAYOUT_REMINDER_DAYS', [7, 30, 90], 1, 3650) as PayoutConfig['reminderDays'],
    reminderHours: intList(env, 'PAYOUT_REMINDER_HOURS', [8, 20], 0, 24) as PayoutConfig['reminderHours'],
  };
  if (cfg.minAmount > cfg.maxAmount) throw new PayoutConfigError('PAYOUT_MIN_AMOUNT must not exceed PAYOUT_MAX_AMOUNT');
  if (!DISCLOSURES[cfg.disclosureVersion]) throw new PayoutConfigError(`PAYOUT_DISCLOSURE_VERSION ${cfg.disclosureVersion} has no disclosure text`);
  return cfg;
}

/** UFAA_DORMANCY_DAYS (default 365, the Act's unpaid wages rule): a matured escrow unclaimed this long is dormant. */
export function ufaaDormancyDays(env: NodeJS.ProcessEnv = process.env): number {
  return posInt(env, 'UFAA_DORMANCY_DAYS', 365);
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export interface Consent {
  agentId: string;
  payoutId: string;
  msisdn: string;
  amount: number;
  disclosureVersion: string;
  disclosureText: string;
  acceptedAt: Date;
}

/**
 * SHA-256 (hex) over the canonical JSON (sorted keys, no whitespace) of what the agent agreed to:
 * consumed by the chaincode's AuthorisePayout (#9), which recomputes it from the payout row.
 */
export function consentHash(c: Consent): string {
  return sha256(
    JSON.stringify({
      accepted_at: c.acceptedAt.toISOString(),
      agent_id: c.agentId,
      amount: c.amount,
      disclosure_text_sha256: sha256(c.disclosureText),
      disclosure_version: c.disclosureVersion,
      msisdn: c.msisdn,
      payout_id: c.payoutId,
    })
  );
}

export interface ClaimSplit {
  escrowIds: string[];
  grossCents: number;
  /** Whole shillings sent: floor((gross + carry in) / 100). */
  amount: number;
  /** The cents remainder, carried to the next claim once this payout is PAID. */
  carryOutCents: number;
}

/**
 * The longest prefix of `escrows` (oldest first) whose amount stays within `maxAmount`. Everything
 * else stays claimable. Cents are integers: no floating-point money.
 */
export function splitClaim(escrows: ReadonlyArray<{ escrowId: string; cents: number }>, carryInCents: number, maxAmount: number): ClaimSplit {
  const escrowIds: string[] = [];
  let grossCents = 0;
  for (const e of escrows) {
    if (Math.floor((grossCents + e.cents + carryInCents) / 100) > maxAmount) break;
    escrowIds.push(e.escrowId);
    grossCents += e.cents;
  }
  const total = grossCents + carryInCents;
  return { escrowIds, grossCents, amount: Math.floor(total / 100), carryOutCents: total % 100 };
}
