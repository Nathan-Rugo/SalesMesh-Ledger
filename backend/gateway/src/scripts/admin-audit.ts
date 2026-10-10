/**
 * @file admin-audit.ts
 * @description Every admin CLI action (unlock, disable, PIN reset) leaves a security_events row.
 */

import os from 'os';
import type { Db } from '../repositories/db.types';
import { insertSubjectSecurityEvent } from '../repositories/security.repository';

export type AdminAction = 'ADMIN_UNLOCK' | 'ADMIN_DISABLE' | 'ADMIN_PIN_RESET';

export async function recordAdminAction(db: Db, action: AdminAction, userId: string | null, detail: string): Promise<void> {
  let operator = 'unknown';
  try {
    operator = os.userInfo().username;
  } catch {
    /* no user info (container) */
  }
  await insertSubjectSecurityEvent(db, { type: action, userId, detail: `${detail} (via CLI by ${operator}@${os.hostname()})` });
}
