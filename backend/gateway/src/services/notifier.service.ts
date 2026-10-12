/**
 * @file notifier.service.ts
 * @description Agent alerts (spec gh-11): SMS through Africa's Talking (fetch, no SDK, 5 s timeout)
 * when AFRICASTALKING_USERNAME / AFRICASTALKING_API_KEY are set (username "sandbox" uses the sandbox
 * API, whose messages appear in the web simulator); otherwise a log-only notifier. SMS reaches any
 * Kenyan line (feature phones too) with no recipient opt-in. `notifySafely` never throws: a failed send is logged and counted,
 * and never blocks or rolls back the flow that raised it.
 */

import { maskMsisdn } from '../domain/payout_destination';
import { metrics as defaultMetrics, type GatewayMetrics } from './metrics.service';

export interface Notifier {
  /** Sends `message` to a normalised MSISDN (2547…). Throws on failure. */
  send(msisdn: string, message: string): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AfricasTalkingConfig {
  username: string;
  apiKey: string;
  /** Registered alphanumeric sender ID; omitted → the shared default (always omitted in the sandbox). */
  senderId?: string;
  timeoutMs: number;
}

/** Recipient statusCode 100 Processed, 101 Sent, 102 Queued; 4xx/5xx are failures inside an HTTP 201. */
const AT_ACCEPTED = new Set([100, 101, 102]);

export class AfricasTalkingSmsNotifier implements Notifier {
  constructor(
    private readonly cfg: AfricasTalkingConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  async send(msisdn: string, message: string): Promise<void> {
    const host = this.cfg.username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = new URLSearchParams({ username: this.cfg.username, to: `+${msisdn}`, message });
    if (this.cfg.senderId) body.set('from', this.cfg.senderId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://${host}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey: this.cfg.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}`);
      const recipients = ((await res.json()) as { SMSMessageData?: { Recipients?: { statusCode?: number; status?: string }[] } })
        ?.SMSMessageData?.Recipients;
      const first = recipients?.[0];
      if (!first || !AT_ACCEPTED.has(Number(first.statusCode))) {
        throw new Error(`Africa's Talking rejected: ${first ? `${first.statusCode} ${first.status}` : 'no recipient'}`);
      }
    } catch (error) {
      throw new Error(controller.signal.aborted ? "Africa's Talking timeout" : (error as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fallback when Africa's Talking is not configured: the alert is only logged (masked phone, no names). */
export class LogNotifier implements Notifier {
  async send(msisdn: string): Promise<void> {
    console.info(`[Notify] (log-only) payout-destination alert for ${maskMsisdn(msisdn)}`);
  }
}

/** Africa's Talking when the username and API key are set, else the log-only notifier. */
export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): Notifier {
  const username = env.AFRICASTALKING_USERNAME?.trim();
  const apiKey = env.AFRICASTALKING_API_KEY?.trim();
  if (!username || !apiKey) return new LogNotifier();
  return new AfricasTalkingSmsNotifier({ username, apiKey, senderId: env.AFRICASTALKING_SENDER_ID?.trim() || undefined, timeoutMs: 5_000 });
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
