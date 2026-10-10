/**
 * @file auth.routes.ts
 * @description /api/v1/auth — login, refresh, logout, PIN change (spec gh-5).
 *
 *   POST /login    {phone, pin}             → 200 {access_token, …} + refresh cookie (HttpOnly, Secure,
 *                                             SameSite=Strict, path /api/v1/auth) + trusted-device cookie
 *   POST /refresh  (refresh cookie, Origin)  → 200 new access token + rotated cookie
 *   POST /logout   (refresh cookie, Origin)  → 204, family revoked, cookie cleared
 *   POST /pin      (Bearer) {current_pin, new_pin} → 200 new session; the only route a
 *                                             pin_change_required token may call
 *
 * Bodies are never logged. Access tokens are returned in JSON only, never in cookies.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { errorMessage, field } from '../domain/unknown';
import { REFRESH_TOKEN_TTL_S } from '../config/jwt';
import { AuthService, type ClientInfo, type Session } from '../auth/auth.service';
import { AUTH_COOKIE_PATH, cookieNames, originAllowed, readCookie, requireAuth } from '../auth/middleware';

/** A failed login never answers faster than this (AUTH_FAILURE_MIN_MS), known user or not. */
const failureFloorMs = (): number => {
  const n = parseInt(process.env.AUTH_FAILURE_MIN_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 250;
};

function sessionBody(s: Session) {
  return {
    access_token: s.accessToken,
    token_type: 'Bearer',
    expires_in: s.expiresIn,
    pin_change_required: s.pinChangeRequired,
    user: { user_id: s.userId, role: s.role },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAuthRouter(service: AuthService = new AuthService()): Router {
  const router = Router();
  const parseJson = express.json({ limit: '4kb' });
  const names = () => cookieNames();

  const client = (req: Request): ClientInfo => ({
    ip: req.ip ?? 'unknown',
    userAgent: req.get('user-agent') ?? undefined,
    deviceCookie: readCookie(req, names().device),
  });

  const setRefreshCookie = (res: Response, token: string) => {
    const n = names();
    res.cookie(n.refresh, token, {
      httpOnly: true,
      secure: n.secure,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_S * 1000,
    });
  };
  const clearRefreshCookie = (res: Response) => {
    const n = names();
    res.clearCookie(n.refresh, { httpOnly: true, secure: n.secure, sameSite: 'strict', path: AUTH_COOKIE_PATH });
  };
  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const checkOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (!originAllowed(req)) {
      res.status(403).json({ error: 'origin_not_allowed' });
      return;
    }
    next();
  };
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch(next);
    };

  router.post(
    '/login',
    noStore,
    parseJson,
    wrap(async (req, res) => {
      const started = Date.now();
      const { phone, pin } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof phone !== 'string' || typeof pin !== 'string' || phone.length > 32 || pin.length > 32) {
        res.status(400).json({ error: 'invalid_request', fields: ['phone', 'pin'] });
        return;
      }
      const result = await service.login(phone, pin, client(req));
      if (result.kind === 'ok') {
        setRefreshCookie(res, result.session.refreshToken!);
        if (result.deviceCookie) {
          const n = names();
          res.cookie(n.device, result.deviceCookie, {
            httpOnly: true,
            secure: n.secure,
            sameSite: 'strict',
            path: AUTH_COOKIE_PATH,
            maxAge: service.throttle.config.deviceCookieTtlMs,
          });
        }
        res.status(200).json(sessionBody(result.session));
        return;
      }
      if (result.kind === 'throttled') {
        if (result.retryAfterS !== null) res.set('Retry-After', String(result.retryAfterS));
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      }
      if (result.kind === 'unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      // Same body, and a latency floor, whether or not the user exists.
      const wait = failureFloorMs() - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      res.status(401).json({ error: 'invalid_credentials' });
    })
  );

  router.post(
    '/refresh',
    noStore,
    checkOrigin,
    wrap(async (req, res) => {
      const result = await service.refresh(readCookie(req, names().refresh), client(req));
      if (result.kind === 'ok') {
        if (result.session.refreshToken) setRefreshCookie(res, result.session.refreshToken);
        res.status(200).json(sessionBody(result.session));
        return;
      }
      clearRefreshCookie(res);
      res.status(401).json({ error: 'invalid_refresh_token' });
    })
  );

  router.post(
    '/logout',
    noStore,
    checkOrigin,
    wrap(async (req, res) => {
      await service.logout(readCookie(req, names().refresh), client(req));
      clearRefreshCookie(res);
      res.status(204).end();
    })
  );

  router.post(
    '/pin',
    noStore,
    requireAuth(null, { allowPinChangeRequired: true }),
    parseJson,
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await service.changePin(req.auth!.userId, body.current_pin, body.new_pin, client(req));
      switch (result.kind) {
        case 'ok':
          setRefreshCookie(res, result.session.refreshToken!);
          res.status(200).json(sessionBody(result.session));
          return;
        case 'weak_pin':
          res.status(400).json({ error: 'invalid_pin', reason: result.violation, field: result.violation === 'current_pin_missing' ? 'current_pin' : 'new_pin' });
          return;
        case 'throttled':
          if (result.retryAfterS !== null) res.set('Retry-After', String(result.retryAfterS));
          res.status(429).json({ error: 'too_many_attempts' });
          return;
        case 'unavailable':
          res.status(503).json({ error: 'temporarily_unavailable' });
          return;
        default:
          res.status(401).json({ error: 'invalid_credentials' });
      }
    })
  );

  // Body-parser errors (malformed / oversized JSON): a JSON 400, never the payload in logs.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = field(err, 'type');
    if (typeof type === 'string' && type.startsWith('entity.')) {
      if (!res.headersSent) res.status(400).json({ error: 'invalid_request' });
      return;
    }
    console.error('[Auth] request failed:', errorMessage(err));
    if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
  });

  return router;
}
