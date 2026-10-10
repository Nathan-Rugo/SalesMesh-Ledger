/**
 * @file user-admin.ts
 * @description Admin CLI: disable a user, or reissue a one-time PIN (also the way out of an expired
 * one-time PIN). Both revoke every refresh-token family and are recorded in security_events.
 *
 *   cd backend/gateway && npm run build
 *   npm run user:disable   -- --phone 0712345678
 *   npm run user:reset-pin -- --phone 0712345678
 *
 * A disabled user gets 401 at login and at refresh; outstanding access tokens lapse within 15 min.
 * The reset prints a new one-time PIN once (72 h, must be changed at first login).
 */

import 'dotenv/config'; // must run before any module reads process.env
import pool, { shutdownDb } from '../config/db';
import { generateOneTimePin, hashPin, ONE_TIME_PIN_TTL_MS } from '../auth/credentials';
import { normaliseKenyanMsisdn } from '../domain/callback';
import { revokeAllForUser, upsertCredential } from '../repositories/auth.repository';
import { withTransaction, type TxDb } from '../repositories/db.types';
import { recordAdminAction } from './admin-audit';
import { CliError } from './user-create';

async function userIdFor(db: TxDb, phone: string): Promise<string> {
  const { rows } = await db.query(`SELECT user_id FROM users WHERE phone_number = $1`, [phone]);
  if (!rows[0]) throw new CliError('no user with this phone number');
  return rows[0].user_id;
}

/** Sets disabled_at and revokes every refresh-token family, atomically, with an audit row. */
export async function disableUser(db: TxDb, phone: string): Promise<string> {
  const userId = await userIdFor(db, phone);
  await withTransaction(db, async (tx) => {
    await tx.query(`UPDATE users SET disabled_at = COALESCE(disabled_at, NOW()) WHERE user_id = $1`, [userId]);
    const n = await revokeAllForUser(tx, userId);
    await recordAdminAction(tx, 'ADMIN_DISABLE', userId, `user disabled; ${n} refresh token(s) revoked`);
  });
  return userId;
}

/** New one-time PIN (must_change, 72 h), every family revoked, with an audit row. */
export async function resetPin(db: TxDb, phone: string): Promise<{ userId: string; oneTimePin: string; expiresAt: Date }> {
  const userId = await userIdFor(db, phone);
  const oneTimePin = generateOneTimePin();
  const cred = await hashPin(oneTimePin);
  const expiresAt = new Date(Date.now() + ONE_TIME_PIN_TTL_MS);
  await withTransaction(db, async (tx) => {
    await upsertCredential(tx, userId, cred, { mustChange: true, oneTimeExpiresAt: expiresAt });
    const n = await revokeAllForUser(tx, userId);
    await recordAdminAction(tx, 'ADMIN_PIN_RESET', userId, `one-time PIN reissued; ${n} refresh token(s) revoked`);
  });
  return { userId, oneTimePin, expiresAt };
}

export function parseAdminArgs(argv: string[]): { command: 'disable' | 'reset-pin'; phone: string } {
  const [command, flag, value, ...extra] = argv;
  if (command !== 'disable' && command !== 'reset-pin') throw new CliError('command must be disable or reset-pin');
  if (flag !== '--phone' || extra.length) throw new CliError(`usage: user:${command} -- --phone <07XXXXXXXX>`);
  const phone = normaliseKenyanMsisdn(value);
  if (!phone) throw new CliError('--phone must be a Kenyan mobile number');
  return { command, phone };
}

async function main(): Promise<void> {
  const { command, phone } = parseAdminArgs(process.argv.slice(2));
  if (command === 'disable') {
    const userId = await disableUser(pool, phone);
    console.log(`Disabled user ${userId}; every session revoked.`);
    return;
  }
  const r = await resetPin(pool, phone);
  console.log(`New one-time PIN for user ${r.userId}:`);
  console.log('');
  console.log(`  One-time PIN: ${r.oneTimePin}`);
  console.log('');
  console.log(`Shown only once. It expires ${r.expiresAt.toISOString()} and must be changed at first login.`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`user-admin: ${(error as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => shutdownDb());
}
