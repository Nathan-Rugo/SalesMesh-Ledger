import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { field } from '../domain/unknown';
import webhookController from '../controllers/webhook.controller';

const router = Router();

/**
 * We need both parsed JSON and raw bytes: the stored hash covers the bytes as received.
 */
const rawBodySaver = (req: Request, _res: Response, buf: Buffer, _encoding: string) => {
  if (buf && buf.length) {
    req.rawBody = buf;
  }
};

/**
 * Daraja does not sign callbacks, so the CallBackURL registered with Safaricom carries a
 * secret path token (MPESA_CALLBACK_TOKEN), compared in constant time. Unset ⇒ all rejected.
 */
function verifyCallbackToken(req: Request, res: Response, next: NextFunction): void {
  const expected = crypto.createHash('sha256').update(process.env.MPESA_CALLBACK_TOKEN ?? '').digest();
  const given = crypto.createHash('sha256').update(String(req.params.token ?? '')).digest();
  // Hashing first makes the comparison length-independent as well as constant-time.
  if (!process.env.MPESA_CALLBACK_TOKEN || !crypto.timingSafeEqual(given, expected)) {
    res.status(404).end();
    return;
  }
  next();
}

const normaliseIp = (ip: string): string => ip.trim().replace(/^::ffff:/i, '');

/**
 * Optional Safaricom source-IP allowlist (MPESA_ALLOWED_IPS, comma-separated). Behind a proxy,
 * set TRUST_PROXY so req.ip is the client address. Unset ⇒ no IP filtering.
 */
function verifySourceIp(req: Request, res: Response, next: NextFunction): void {
  const allowed = (process.env.MPESA_ALLOWED_IPS ?? '').split(',').map(normaliseIp).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(normaliseIp(req.ip ?? ''))) {
    console.warn('[Webhook] callback from a non-allowlisted source IP rejected');
    res.status(404).end();
    return;
  }
  next();
}

// JSON parsing (keeping the raw bytes) runs per route, only AFTER the IP and token checks.
const parseJson = express.json({ verify: rawBodySaver, limit: '1mb' });

/**
 * POST /api/v1/mpesa/callback/:token
 * Daraja callback endpoint for M-Pesa STK Push results and C2B confirmations.
 */
router.post(
  '/api/v1/mpesa/callback/:token',
  verifySourceIp,
  verifyCallbackToken,
  parseJson,
  (req: Request, res: Response, next: NextFunction) => {
    webhookController.handleMpesaCallback(req, res).catch(next);
  }
);

/**
 * POST /api/v1/mpesa/c2b/validation/:token
 * Daraja C2B validation: accept/reject before any money moves. Never writes intake.
 */
router.post(
  '/api/v1/mpesa/c2b/validation/:token',
  verifySourceIp,
  verifyCallbackToken,
  parseJson,
  (req: Request, res: Response, next: NextFunction) => {
    webhookController.handleC2BValidation(req, res).catch(next);
  }
);

/**
 * POST /api/v1/mpesa/b2c/result/:token and /timeout/:token
 * Daraja B2C result and queue-timeout callbacks (payout-destination verification, spec gh-11).
 */
router.post(
  '/api/v1/mpesa/b2c/result/:token',
  verifySourceIp,
  verifyCallbackToken,
  parseJson,
  (req: Request, res: Response, next: NextFunction) => {
    webhookController.handleB2cResult(req, res).catch(next);
  }
);
router.post('/api/v1/mpesa/b2c/timeout/:token', verifySourceIp, verifyCallbackToken, parseJson, (req: Request, res: Response) => {
  webhookController.handleB2cTimeout(req, res);
});

/**
 * Malformed or oversized JSON (body-parser errors, `err.type` "entity.*"): answer in Daraja's
 * terms without logging any payload bytes. Callbacks are ACKed and dropped (a retry cannot fix
 * them); validation requests are rejected before any money moves.
 */
router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const type = field(err, 'type');
  if (typeof type !== 'string' || !type.startsWith('entity.')) return next(err);
  const isValidation = req.path.startsWith('/api/v1/mpesa/c2b/validation/');
  console.warn(`[Webhook] unparseable request body (${type}) on ${isValidation ? 'C2B validation' : 'callback'} — dropped`);
  if (res.headersSent) return;
  if (isValidation) res.status(200).json({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' });
  else res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

export default router;
