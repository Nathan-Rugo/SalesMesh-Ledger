/**
 * @file admin.routes.ts
 * @description /api/v1/admin (spec gh-11, part 3c). MERCHANT_ADMIN only; works whether or not
 * PAYOUTS_ENABLED is set (quarantines exist without payouts).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { errorMessage } from '../domain/unknown';
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

  router.get('/frozen-payouts', noStore, admin, wrap((req, res) => controller.frozenPayouts(req, res)));

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Admin] request failed:', errorMessage(err));
    if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
  });

  return router;
}
