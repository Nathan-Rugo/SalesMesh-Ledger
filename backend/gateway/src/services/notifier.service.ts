/**
 * @file notifier.service.ts
 * @description Agent alerts (spec gh-11): WhatsApp through the Twilio API (fetch + Basic auth, no
 * SDK, 5 s timeout) when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM are all set;
 * otherwise a log-only notifier. `notifySafely` never throws: a failed send is logged and counted,
 * and never blocks or rolls back the flow that raised it.
 */

import { maskMsisdn } from '../domain/payout_destination';
import { metrics as defaultMetrics, type GatewayMetrics } from './metrics.service';

export interface Notifier {
  /** Sends `message` to a normalised MSISDN (2547…). Throws on failure. */
  send(msisdn: string, message: string): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** "whatsapp:+14155238886" */
  from: string;
  timeoutMs: number;
}

export class TwilioWhatsAppNotifier implements Notifier {
  constructor(
    private readonly cfg: TwilioConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  async send(msisdn: string, message: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: this.cfg.from, To: `whatsapp:+${msisdn}`, Body: message }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
    } catch (error) {
      throw new Error(controller.signal.aborted ? 'Twilio timeout' : (error as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fallback when Twilio is not configured: the alert is only logged (masked phone, no names). */
export class LogNotifier implements Notifier {
  async send(msisdn: string): Promise<void> {
    console.info(`[Notify] (log-only) payout-destination alert for ${maskMsisdn(msisdn)}`);
  }
}

/** Twilio when all three TWILIO_* are set, else the log-only notifier. */
export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): Notifier {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_WHATSAPP_FROM?.trim();
  if (!accountSid || !authToken || !from) return new LogNotifier();
  return new TwilioWhatsAppNotifier({ accountSid, authToken, from: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`, timeoutMs: 5_000 });
}

/** Sends one alert; never throws (logged and counted on failure). */
export async function notifySafely(notifier: Notifier, msisdn: string, message: string, metrics: GatewayMetrics = defaultMetrics): Promise<boolean> {
  try {
    await notifier.send(msisdn, message);
    metrics.payouts.alertsSent += 1;
    return true;
  } catch (error) {
    metrics.payouts.alertsFailed += 1;
    console.error(`[Notify] alert to ${maskMsisdn(msisdn)} failed:`, (error as Error).message);
    return false;
  }
}
