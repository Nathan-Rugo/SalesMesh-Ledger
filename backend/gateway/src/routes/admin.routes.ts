/**
 * @file admin.routes.ts
 * @description /api/v1/admin (spec gh-11 part 3c, gh-14). MERCHANT_ADMIN only; works whether or not
 * PAYOUTS_ENABLED is set (quarantines exist without payouts). The overrides never call B2C.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { errorMessage, field } from '../domain/unknown';
import { AdminController } from '../controllers/admin.controller';

export function createAdminRouter(controller: AdminController = new AdminController()): Router {
  const router = Router();
  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const admin = requireAuth(['MERCHANT_ADMIN']);
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

  const json = express.json({ limit: '4kb' });

  router.get('/frozen-payouts', noStore, admin, wrap((req, res) => controller.frozenPayouts(req, res)));
  router.post('/escrows/:id/release', noStore, admin, json, wrap((req, res) => controller.overrideEscrow(req, res, 'release')));
  router.post('/escrows/:id/keep', noStore, admin, json, wrap((req, res) => controller.overrideEscrow(req, res, 'keep')));
  router.post('/payouts/:id/resolve', noStore, admin, json, wrap((req, res) => controller.resolvePayout(req, res)));

  // Malformed JSON -> 400; anything else -> 503 (no body, note or PIN in logs).
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = field(err, 'type');
    if (typeof type === 'string' && type.startsWith('entity.')) {
      if (!res.headersSent) res.status(400).json({ error: 'invalid_request' });
      return;
    }
    console.error('[Admin] request failed:', errorMessage(err));
    if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
  });

  return router;
}
