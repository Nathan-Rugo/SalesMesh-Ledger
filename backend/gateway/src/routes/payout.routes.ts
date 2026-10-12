/**
 * @file payout.routes.ts
 * @description /api/v1/payouts (spec gh-11, part 2). SALES_AGENT only; 503 payouts_disabled
 * unless PAYOUTS_ENABLED=true.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { errorMessage, field } from '../domain/unknown';
import { PayoutController } from '../controllers/payout.controller';
import { payoutsEnabled } from '../services/payout_destination.service';

export function createPayoutRouter(controller: PayoutController = new PayoutController()): Router {
  const router = Router();
  const guard = (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    if (!payoutsEnabled()) {
      res.status(503).json({ error: 'payouts_disabled' });
      return;
    }
    next();
  };
  const agent = requireAuth(['SALES_AGENT']);
  const json = express.json({ limit: '4kb' });
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

  router.get('/', guard, agent, wrap((req, res) => controller.list(req, res)));
  router.post('/claim', guard, agent, json, wrap((req, res) => controller.claim(req, res)));

  // Malformed JSON → 400; anything else → 503 (no body, phone or PIN in logs).
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = field(err, 'type');
    if (typeof type === 'string' && type.startsWith('entity.')) {
      if (!res.headersSent) res.status(400).json({ error: 'invalid_request' });
      return;
    }
    console.error('[Payouts] request failed:', errorMessage(err));
    if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
  });

  return router;
}
