/**
 * @file middleware.ts
 * @description `requireAuth(roles)` — Bearer access-token check without a DB round trip (thesis
 * §3 RBAC), plus the cookie / Origin helpers the auth routes share.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthTokenError, verifyAccessToken, type AccessClaims, type Role } from './tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      /** Raw request bytes as received (webhook routes): the stored hash covers exactly these. */
      rawBody?: Buffer;
      /** Per-request trace id (X-Request-ID). */
      reqId?: string;
    }
  }
}

function unauthorized(res: Response): void {
  res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * 401 without a valid access token; 403 `pin_change_required` while the one-time PIN is unchanged
 * (unless `allowPinChangeRequired`); 403 `forbidden` for a role outside `roles` (null = any role).
 */
export function requireAuth(
  roles: readonly Role[] | null,
  opts: { allowPinChangeRequired?: boolean } = {}
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim());
    if (!m || m[1].length > 4096) return unauthorized(res);
    verifyAccessToken(m[1]).then(
      (claims) => {
        if (claims.pinChangeRequired && !opts.allowPinChangeRequired) {
          res.status(403).json({ error: 'pin_change_required' });
          return;
        }
        if (roles && !roles.includes(claims.role)) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        req.auth = claims;
        next();
      },
      (error) => {
        if (!(error instanceof AuthTokenError)) console.error('[Auth] token verification error:', (error as Error).message);
        unauthorized(res);
      }
    );
  };
}

// ── Cookies ─────────────────────────────────────────────────────────────────

export const AUTH_COOKIE_PATH = '/api/v1/auth';

export interface CookieNames {
  refresh: string;
  device: string;
  secure: boolean;
}

/**
 * `__Secure-` prefixed, Secure cookies. AUTH_COOKIE_INSECURE_DEV=true (never honoured when
 * NODE_ENV=production) drops the prefix and the Secure flag for plain-HTTP local development.
 */
export function cookieNames(env: NodeJS.ProcessEnv = process.env): CookieNames {
  const insecure = env.AUTH_COOKIE_INSECURE_DEV === 'true' && env.NODE_ENV !== 'production';
  return insecure
    ? { refresh: 'sm_rt', device: 'sm_dev', secure: false }
    : { refresh: '__Secure-sm_rt', device: '__Secure-sm_dev', secure: true };
}

/** Minimal Cookie header parser (no dependency): first occurrence wins. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ── Origin / CORS ───────────────────────────────────────────────────────────

/** CORS_ORIGINS: comma-separated exact origins allowed to make credentialed requests. */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** PUBLIC_ORIGIN: the gateway's public origin (e.g. https://pay.example.co.ke), behind a TLS proxy. */
export const publicOrigin = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, '') || null;

/**
 * Refresh and logout are cookie-authenticated, so they check Origin (CSRF): an Origin header, when
 * present, must be in CORS_ORIGINS or be the gateway's own origin — PUBLIC_ORIGIN, compared
 * exactly, when set (behind a TLS-terminating proxy req.protocol/host are the proxy's view);
 * otherwise req.protocol://host. Non-browser clients send none.
 */
export function originAllowed(req: Request, allowlist: readonly string[] = corsOrigins()): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  if (allowlist.includes(origin)) return true;
  const own = publicOrigin();
  return origin === (own ?? `${req.protocol}://${req.get('host') ?? ''}`);
}
