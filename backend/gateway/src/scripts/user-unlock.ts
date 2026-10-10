/**
 * @file user-unlock.ts
 * @description Admin CLI: lift a login lockout (the 24 h failure cap needs an admin; progressive
 * lockouts also clear). Uses the same REDIS_* and PII_HMAC_KEY settings as the gateway.
 *
 *   npm run build && npm run user:unlock -- --phone 0712345678
 */

import 'dotenv/config'; // must run before any module reads process.env
import { redisClient } from '../config/redis';
import pool, { shutdownDb } from '../config/db';
import { LoginThrottle, loginPhoneKeys, RedisThrottleStore } from '../auth/throttle';
import { normaliseKenyanMsisdn } from '../domain/callback';
import { recordAdminAction } from './admin-audit';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--phone') throw new Error('usage: user:unlock --phone <07XXXXXXXX>');
  const phone = normaliseKenyanMsisdn(argv[1]);
  if (!phone) throw new Error('--phone must be a Kenyan mobile number');
  await redisClient.connect();
  // Clears the lockout under the current and (during a rotation) the previous PII key.
  const keys = loginPhoneKeys(phone);
  await new LoginThrottle(new RedisThrottleStore(redisClient)).unlock(keys);
  const { rows } = await pool.query(`SELECT user_id FROM users WHERE phone_number = $1`, [phone]);
  await recordAdminAction(pool, 'ADMIN_UNLOCK', rows[0]?.user_id ?? null, `login lockout cleared for phone ${keys[0]}`);
  console.log('Login lockout cleared for that phone.');
}

main()
  .catch((error) => {
    console.error(`user:unlock: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redisClient.quit().catch(() => undefined);
    await shutdownDb();
  });
