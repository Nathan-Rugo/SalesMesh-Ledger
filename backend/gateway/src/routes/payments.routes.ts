/**
 * @file payments.routes.ts
 * @description /api/v1/payments — STK Push initiation (spec gh-5). SALES_AGENT only.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { PaymentsController } from '../controllers/payments.controller';

/** STK_ENABLED=true turns initiation on (startup then requires the Daraja credentials). */
export const stkEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.STK_ENABLED === 'true';

export function createPaymentsRouter(controller: PaymentsController = new PaymentsController()): Router {
  const router = Router();

  router.post(
    '/stk',
    requireAuth(['SALES_AGENT']),
    (_req: Request, res: Response, next: NextFunction) => {
      if (!stkEnabled()) {
        res.status(503).json({ error: 'stk_disabled' });
        return;
      }
      next();
    },
    express.json({ limit: '4kb' }),
    (req: Request, res: Response, next: NextFunction) => {
      controller.initiate(req, res).catch(next);
    }
  );

  router.get('/stk/:id', requireAuth(['SALES_AGENT']), (req: Request, res: Response, next: NextFunction) => {
    controller.status(req, res).catch(next);
  });

  // Malformed JSON → 400; anything else → 503 (no payload, phone or token in logs).
  router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof err?.type === 'string' && err.type.startsWith('entity.')) {
      if (!res.headersSent) res.status(400).json({ error: 'invalid_request' });
      return;
    }
    console.error('[Payments] STK initiation failed:', (err as Error)?.message);
    if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
  });

  return router;
}
