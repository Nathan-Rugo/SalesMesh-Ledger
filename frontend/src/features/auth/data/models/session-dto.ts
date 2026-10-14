import { isRole, type Session } from '../../domain/entities/session';

/** Gateway session body (auth.routes.ts `sessionBody`). */
export interface SessionDto {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  pin_change_required: boolean;
  user: { user_id: string; role: string };
}

/** Validates an untrusted response body and maps it to a Session, or null when malformed. */
export function toSession(body: unknown, now: number = Date.now()): Session | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<SessionDto>;
  const user = b.user;
  if (typeof b.access_token !== 'string' || b.access_token.length === 0) return null;
  if (typeof b.expires_in !== 'number' || !Number.isFinite(b.expires_in) || b.expires_in <= 0) return null;
  if (!user || typeof user.user_id !== 'string' || !isRole(user.role)) return null;
  return {
    accessToken: b.access_token,
    expiresAt: now + b.expires_in * 1000,
    pinChangeRequired: b.pin_change_required === true,
    user: { id: user.user_id, role: user.role },
  };
}
