/**
 * @file client.ts
 * @description Safaricom Daraja client for M-Pesa Express (STK Push) — spec gh-5 — and B2C
 * BusinessPayment (payout-destination verification) — spec gh-11.
 *
 *  - OAuth token cached and refreshed 60 s before expiry; concurrent refreshes share one request
 *    (single flight); a failed token fetch is retried once (the token fetch only).
 *  - Password / Timestamp computed in EAT.
 *  - stkPush() has ONE overall deadline (DARAJA_TOTAL_TIMEOUT_MS, default 25 s) bounding every
 *    sub-call (OAuth fetch + retry, push, token refresh + push); callers derive their own waits
 *    from it (config/stk.ts). It is NEVER retried blindly (a retry could prompt the customer
 *    twice). The single exception: Daraja said the access token was invalid/expired, which means
 *    the push was not processed — one retry after a token refresh is safe.
 *  - Typed outcomes: ACCEPTED (CheckoutRequestID), REJECTED (definitive: the customer was not
 *    prompted), UNKNOWN (sent, but no definitive answer: timeout, connection lost, 5xx without a
 *    definitive errorCode). ResponseCode is compared as the string "0".
 *  - stkQuery() (spec gh-6-recon): STK Push Query for the reconciliation sweep, under the same
 *    overall-deadline discipline. A query never prompts the customer, so a token-invalid answer is
 *    retried once after a refresh. Typed outcomes PAID / FAILED(code) / PENDING / UNKNOWN from an
 *    explicit table keyed on (HTTP status, errorCode, errorMessage, ResultCode as a string);
 *    unlisted codes are retried (UNKNOWN), never FAILED.
 *  - Never logs the customer MSISDN, the token, or any Daraja secret.
 */

import { darajaTotalTimeoutMs } from '../config/stk';
import { formatDarajaTime } from '../domain/callback';
import { errorCode as thrownErrorCode, field, isRecord, type JsonRecord } from '../domain/unknown';
import { metrics as defaultMetrics, type GatewayMetrics } from '../services/metrics.service';

export type TransactionType = 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';

/** What the OAuth token cache needs (shared by the STK and B2C clients). */
export interface DarajaAuthConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  oauthTimeoutMs: number;
}

export interface DarajaConfig extends DarajaAuthConfig {
  /** BusinessShortCode (Paybill number, or the store/HO number for a till); also used in Password. */
  shortCode: string;
  passkey: string;
  /** PartyB: the Paybill, or the till number for Buy Goods (may differ from shortCode). */
  partyB: string;
  transactionType: TransactionType;
  callbackUrl: string;
  transactionDesc: string;
  timeoutMs: number;
  /** Overall budget of one stkPush(), bounding every sub-call. */
  totalTimeoutMs: number;
}

export class DarajaConfigError extends Error {}

const BASE_URLS: Record<string, string> = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

function parseTransactionType(raw: string | undefined): TransactionType | null {
  const v = (raw ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!v || v === 'paybill' || v === 'customerpaybillonline') return 'CustomerPayBillOnline';
  if (v === 'buygoods' || v === 'till' || v === 'customerbuygoodsonline') return 'CustomerBuyGoodsOnline';
  return null;
}

const posInt = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Reads and validates the Daraja settings; throws DarajaConfigError naming what is missing. */
export function darajaConfig(env: NodeJS.ProcessEnv = process.env): DarajaConfig {
  const missing = ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_BUSINESS_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_CALLBACK_URL']
    .filter((k) => !env[k]?.trim());
  if (missing.length) throw new DarajaConfigError(`missing ${missing.join(', ')}`);
  const environment = (env.DARAJA_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
  const baseUrl = BASE_URLS[environment];
  if (!baseUrl) throw new DarajaConfigError('DARAJA_ENVIRONMENT must be sandbox or production');
  const transactionType = parseTransactionType(env.DARAJA_TRANSACTION_TYPE);
  if (!transactionType) throw new DarajaConfigError('DARAJA_TRANSACTION_TYPE must be Paybill or BuyGoods');
  const shortCode = env.DARAJA_BUSINESS_SHORTCODE!.trim();
  const partyB = (env.DARAJA_PARTY_B ?? '').trim() || shortCode;
  if (!/^\d{5,7}$/.test(shortCode) || !/^\d{5,7}$/.test(partyB)) {
    throw new DarajaConfigError('DARAJA_BUSINESS_SHORTCODE / DARAJA_PARTY_B must be 5-7 digit numbers');
  }
  const callbackUrl = env.DARAJA_CALLBACK_URL!.trim();
  if (!/^https:\/\/[^\s]+$/.test(callbackUrl)) throw new DarajaConfigError('DARAJA_CALLBACK_URL must be an https:// URL');
  // dotenv does not expand variables: a literal "${MPESA_CALLBACK_TOKEN}" would reach Daraja and
  // every callback would then fail the path-token check (silently lost).
  if (callbackUrl.includes('${')) {
    throw new DarajaConfigError('DARAJA_CALLBACK_URL contains an unexpanded ${...}: paste the literal MPESA_CALLBACK_TOKEN value');
  }
  const callbackToken = env.MPESA_CALLBACK_TOKEN?.trim();
  if (!callbackToken) throw new DarajaConfigError('MPESA_CALLBACK_TOKEN must be set (it ends DARAJA_CALLBACK_URL)');
  let callbackPath: string;
  try {
    callbackPath = new URL(callbackUrl).pathname;
  } catch {
    throw new DarajaConfigError('DARAJA_CALLBACK_URL is not a valid URL');
  }
  if (!callbackPath.endsWith(`/api/v1/mpesa/callback/${callbackToken}`)) {
    throw new DarajaConfigError('DARAJA_CALLBACK_URL must end with /api/v1/mpesa/callback/<MPESA_CALLBACK_TOKEN>');
  }
  return {
    baseUrl,
    consumerKey: env.DARAJA_CONSUMER_KEY!.trim(),
    consumerSecret: env.DARAJA_CONSUMER_SECRET!.trim(),
    shortCode,
    passkey: env.DARAJA_PASSKEY!.trim(),
    partyB,
    transactionType,
    callbackUrl,
    transactionDesc: (env.DARAJA_TRANSACTION_DESC?.trim() || 'SalesMesh').slice(0, 13),
    timeoutMs: Math.min(posInt(env.DARAJA_TIMEOUT_MS, 10_000), 60_000),
    oauthTimeoutMs: Math.min(posInt(env.DARAJA_OAUTH_TIMEOUT_MS, 5_000), 30_000),
    totalTimeoutMs: darajaTotalTimeoutMs(env),
  };
}

/** STK Push Password: base64(BusinessShortCode + Passkey + Timestamp), Timestamp in EAT. */
export function stkPassword(shortCode: string, passkey: string, at: Date): { password: string; timestamp: string } {
  const timestamp = formatDarajaTime(at);
  return { password: Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64'), timestamp };
}

export interface StkPushRequest {
  /** Whole shillings. */
  amount: number;
  /** 2547XXXXXXXX / 2541XXXXXXXX. */
  phone: string;
  /** ≤ 12 characters (the agent_code). */
  accountReference: string;
}

export type StkOutcome =
  | { kind: 'ACCEPTED'; checkoutRequestId: string; merchantRequestId: string | null; responseCode: string; customerMessage: string }
  | { kind: 'REJECTED'; code: string; message: string }
  | { kind: 'UNKNOWN'; code: string; message: string };

type Mapped = StkOutcome | { kind: 'TOKEN_INVALID'; code: string };

/**
 * Daraja errorCode → outcome. TOKEN: the push was not processed because the token was
 * invalid/expired (one retry after a refresh). Codes not listed: 4xx → REJECTED, 5xx → UNKNOWN.
 */
export const DARAJA_ERROR_OUTCOMES: Readonly<Record<string, 'REJECTED' | 'UNKNOWN' | 'TOKEN'>> = {
  '400.002.02': 'REJECTED', // Bad Request - Invalid <field>
  '400.002.05': 'REJECTED', // Invalid Request Payload
  '400.003.01': 'TOKEN', // Invalid Access Token
  '400.003.02': 'REJECTED', // Bad Request
  '404.001.01': 'REJECTED', // Resource not found
  '404.001.03': 'TOKEN', // Invalid Access Token
  '404.001.04': 'REJECTED', // Invalid Authentication Header
  '405.001.01': 'REJECTED', // Method not allowed
  '500.001.1001': 'REJECTED', // merchant does not exist / wrong credentials / subscriber busy: definitive
  '500.003.02': 'REJECTED', // System busy (spike arrest): not processed
  '500.003.03': 'REJECTED', // Quota violation: not processed
  '500.003.1001': 'UNKNOWN', // Internal server error: may or may not have been processed
};

/** Connection errors where the request provably never left (safe to call REJECTED). */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const safe = (v: unknown, max = 200): string => String(v ?? '').replace(/\d{9,}/g, '[digits]').slice(0, max);

/** The OAuth token cache (single flight, early refresh) shared by the STK and B2C clients. */
class DarajaAuth<C extends DarajaAuthConfig> {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly configSource: C | (() => C),
    protected readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    protected readonly metrics: GatewayMetrics = defaultMetrics
  ) {}

  protected config(): C {
    return typeof this.configSource === 'function' ? this.configSource() : this.configSource;
  }

  /**
   * Cached OAuth token, refreshed 60 s early; concurrent callers share one fetch. `deadline`
   * (epoch ms) bounds this caller's wait and the fetch it starts.
   */
  async accessToken(forceRefresh = false, deadline = Number.POSITIVE_INFINITY): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    if (!this.inflight) {
      this.inflight = this.fetchTokenWithRetry(deadline).finally(() => {
        this.inflight = null;
      });
    }
    return withinDeadline(this.inflight, deadline, 'OAuth deadline exceeded');
  }

  /** Drops the cached token (e.g. after Daraja reported it invalid). */
  invalidateToken(): void {
    this.token = null;
  }

  private async fetchTokenWithRetry(deadline: number): Promise<string> {
    try {
      return await this.fetchToken(deadline);
    } catch (first) {
      if (deadline - Date.now() <= 0) throw first;
      console.warn('[Daraja] OAuth token fetch failed, retrying once:', (first as Error).message);
      return this.fetchToken(deadline);
    }
  }

  private async fetchToken(deadline: number): Promise<string> {
    const cfg = this.config();
    const budget = Math.min(cfg.oauthTimeoutMs, deadline - Date.now());
    if (budget <= 0) throw new Error('OAuth deadline exceeded');
    const basic = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await this.fetchImpl(`${cfg.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        method: 'GET',
        headers: { Authorization: `Basic ${basic}` },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`OAuth HTTP ${res.status}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('OAuth response is not JSON');
      }
      const body: JsonRecord = isRecord(parsed) ? parsed : {};
      const value = typeof body.access_token === 'string' ? body.access_token : '';
      if (!value) throw new Error('OAuth response has no access_token');
      const expiresIn = Number(body.expires_in);
      const ttlMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3599) * 1000;
      this.token = { value, expiresAt: Date.now() + ttlMs };
      return value;
    } catch (error) {
      throw new Error(controller.signal.aborted ? 'OAuth timeout' : (error as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class DarajaClient extends DarajaAuth<DarajaConfig> {
  constructor(
    configSource: DarajaConfig | (() => DarajaConfig) = () => darajaConfig(),
    fetchImpl?: FetchLike,
    metrics?: GatewayMetrics
  ) {
    super(configSource, fetchImpl, metrics);
  }

  /** Sends one STK Push. Never throws; never retries except after an invalid-token answer. */
  async stkPush(req: StkPushRequest): Promise<StkOutcome> {
    let cfg: DarajaConfig;
    try {
      cfg = this.config();
    } catch (error) {
      return { kind: 'REJECTED', code: 'config', message: (error as Error).message };
    }
    // One overall deadline for everything below (derived waits in config/stk.ts rely on it).
    const deadline = Date.now() + cfg.totalTimeoutMs;
    let token: string;
    try {
      token = await this.accessToken(false, deadline);
    } catch (error) {
      console.error('[Daraja] no OAuth token — STK Push not sent:', (error as Error).message);
      return { kind: 'REJECTED', code: 'oauth_unavailable', message: 'Daraja authentication failed' };
    }

    for (let attempt = 0; ; attempt++) {
      const budget = Math.min(cfg.timeoutMs, deadline - Date.now());
      if (budget <= 0) {
        // Not sent: the customer was not prompted.
        console.error('[Daraja] overall deadline exhausted before the STK Push was sent');
        return { kind: 'REJECTED', code: 'deadline', message: 'Daraja did not answer in time' };
      }
      const mapped = await this.postStkPush(cfg, token, req, budget);
      if (mapped.kind !== 'TOKEN_INVALID') {
        console.info(`[Daraja] STK Push ${mapped.kind}${mapped.kind === 'ACCEPTED' ? '' : ` (${mapped.code})`}`);
        return mapped;
      }
      if (attempt > 0) return { kind: 'REJECTED', code: mapped.code, message: 'Daraja rejected the access token' };
      // The push was not processed: refresh the token and try exactly once more.
      this.invalidateToken();
      try {
        token = await this.accessToken(true, deadline);
      } catch (error) {
        console.error('[Daraja] OAuth refresh failed — STK Push not sent:', (error as Error).message);
        return { kind: 'REJECTED', code: 'oauth_unavailable', message: 'Daraja authentication failed' };
      }
    }
  }

  private async postStkPush(cfg: DarajaConfig, token: string, req: StkPushRequest, timeoutMs: number): Promise<Mapped> {
    const { password, timestamp } = stkPassword(cfg.shortCode, cfg.passkey, new Date());
    const body = {
      BusinessShortCode: Number(cfg.shortCode),
      Password: password,
      Timestamp: timestamp,
      TransactionType: cfg.transactionType,
      Amount: req.amount,
      PartyA: Number(req.phone),
      PartyB: Number(cfg.partyB),
      PhoneNumber: Number(req.phone),
      CallBackURL: cfg.callbackUrl,
      AccountReference: req.accountReference.slice(0, 12),
      TransactionDesc: cfg.transactionDesc.slice(0, 13),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${cfg.baseUrl}/mpesa/stkpush/v1/processrequest`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return { kind: 'UNKNOWN', code: 'timeout', message: 'no answer from Daraja in time' };
        const code = thrownErrorCode(error);
        if (NOT_SENT_CODES.has(code)) return { kind: 'REJECTED', code: `network_${code}`, message: 'Daraja unreachable' };
        return { kind: 'UNKNOWN', code: code ? `network_${code}` : 'network_error', message: 'connection to Daraja lost' };
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        // Headers arrived but the body did not: the request was processed or not — unknown.
        return { kind: 'UNKNOWN', code: controller.signal.aborted ? 'timeout' : 'body_lost', message: 'Daraja response lost' };
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return mapStkResponse(res.status, parsed);
    } finally {
      clearTimeout(timer);
      this.metrics.recordDarajaLatency(Date.now() - started);
    }
  }

  /**
   * STK Push Query for one CheckoutRequestID. Never throws. Bounded by one overall deadline
   * (DARAJA_TOTAL_TIMEOUT_MS); a token-invalid answer is retried once after a refresh (a query
   * never prompts the customer). `unreachable` marks answers that say Daraja itself is down.
   */
  async stkQuery(checkoutRequestId: string): Promise<StkQueryOutcome> {
    let cfg: DarajaConfig;
    try {
      cfg = this.config();
    } catch (error) {
      return { kind: 'UNKNOWN', code: 'config', message: (error as Error).message, unreachable: true };
    }
    const deadline = Date.now() + cfg.totalTimeoutMs;
    let token: string;
    try {
      token = await this.accessToken(false, deadline);
    } catch (error) {
      console.error('[Daraja] no OAuth token, STK Query not sent:', (error as Error).message);
      return { kind: 'UNKNOWN', code: 'oauth_unavailable', message: 'Daraja authentication failed', unreachable: true };
    }
    for (let attempt = 0; ; attempt++) {
      const budget = Math.min(cfg.timeoutMs, deadline - Date.now());
      if (budget <= 0) return { kind: 'UNKNOWN', code: 'deadline', message: 'Daraja did not answer in time', unreachable: true };
      const mapped = await this.postStkQuery(cfg, token, checkoutRequestId, budget);
      if (mapped.kind !== 'TOKEN_INVALID') return mapped;
      // Rejected again after a refresh: a credential / scope fault, not this request's — defer, refund.
      if (attempt > 0) return { kind: 'UNKNOWN', code: mapped.code, message: 'Daraja rejected the access token', unreachable: true };
      this.invalidateToken();
      try {
        token = await this.accessToken(true, deadline);
      } catch (error) {
        console.error('[Daraja] OAuth refresh failed, STK Query not sent:', (error as Error).message);
        return { kind: 'UNKNOWN', code: 'oauth_unavailable', message: 'Daraja authentication failed', unreachable: true };
      }
    }
  }

  private async postStkQuery(cfg: DarajaConfig, token: string, checkoutRequestId: string, timeoutMs: number): Promise<QueryMapped> {
    const { password, timestamp } = stkPassword(cfg.shortCode, cfg.passkey, new Date());
    const body = { BusinessShortCode: Number(cfg.shortCode), Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${cfg.baseUrl}/mpesa/stkpushquery/v1/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return { kind: 'UNKNOWN', code: 'timeout', message: 'no answer from Daraja in time', unreachable: true };
        const code = thrownErrorCode(error);
        return { kind: 'UNKNOWN', code: code ? `network_${code}` : 'network_error', message: 'Daraja unreachable', unreachable: true };
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        return { kind: 'UNKNOWN', code: controller.signal.aborted ? 'timeout' : 'body_lost', message: 'Daraja response lost', unreachable: true };
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return mapStkQueryResponse(res.status, parsed, checkoutRequestId);
    } finally {
      clearTimeout(timer);
      this.metrics.recordDarajaLatency(Date.now() - started);
    }
  }
}

// ── STK Push Query (reconciliation sweep, spec gh-6-recon) ─────────────────

export type StkQueryOutcome =
  /** Paid: ResponseCode "0", ResultCode "0" and the echoed CheckoutRequestID is ours. No receipt. */
  | { kind: 'PAID'; resultCode: '0'; resultDesc: string }
  /** Definitively not paid (cancelled, timed out, wrong PIN, insufficient funds, ...). */
  | { kind: 'FAILED'; resultCode: string; resultDesc: string }
  /** Still being processed, or throttled (`throttled`: does not consume a sweep attempt). */
  | { kind: 'PENDING'; code: string; message: string; throttled?: boolean }
  /** No definitive answer (network, timeout, 5xx, unlisted code, mismatched echo): retry later. */
  | { kind: 'UNKNOWN'; code: string; message: string; unreachable?: boolean };

/** ResultCode (as a string) -> outcome. Codes not listed are retried (UNKNOWN), never FAILED. */
export const STK_QUERY_RESULT_OUTCOMES: Readonly<Record<string, 'PAID' | 'FAILED' | 'RETRY'>> = {
  '0': 'PAID',
  '1': 'FAILED', // insufficient balance
  '1019': 'FAILED', // transaction expired
  '1032': 'FAILED', // request cancelled by the user
  '1037': 'FAILED', // DS timeout: the user cannot be reached
  '2001': 'FAILED', // wrong PIN / invalid initiator information
  '1001': 'RETRY', // subscriber busy: another transaction in progress
  '1025': 'RETRY', // error sending the push request
  '4999': 'RETRY', // transaction still under processing
  '9999': 'RETRY', // error sending the push request
};

/** Query errorCode -> outcome (the errorMessage refines 500.001.1001). Unlisted -> UNKNOWN. */
export const STK_QUERY_ERROR_OUTCOMES: Readonly<Record<string, 'PROCESSING' | 'TOKEN' | 'THROTTLED'>> = {
  '500.001.1001': 'PROCESSING', // "The transaction is being processed"
  '400.003.01': 'TOKEN', // Invalid Access Token
  '404.001.03': 'TOKEN', // Invalid Access Token
  '500.003.02': 'THROTTLED', // System busy (spike arrest)
  '500.003.03': 'THROTTLED', // Quota violation
};

type QueryMapped = StkQueryOutcome | { kind: 'TOKEN_INVALID'; code: string };

/** Maps one STK Push Query HTTP response to an outcome; `ours` is the CheckoutRequestID asked about. */
export function mapStkQueryResponse(status: number, raw: unknown, ours: string): QueryMapped {
  const body: JsonRecord = isRecord(raw) ? raw : {};
  const errorCode = typeof body.errorCode === 'string' ? body.errorCode.trim() : '';
  if (errorCode) {
    const rule = STK_QUERY_ERROR_OUTCOMES[errorCode];
    const message = safe(body.errorMessage) || 'Daraja error';
    if (rule === 'TOKEN') return { kind: 'TOKEN_INVALID', code: errorCode };
    if (rule === 'THROTTLED') return { kind: 'PENDING', code: errorCode, message, throttled: true };
    if (rule === 'PROCESSING' && /being processed/i.test(String(body.errorMessage ?? ''))) {
      return { kind: 'PENDING', code: errorCode, message };
    }
    return { kind: 'UNKNOWN', code: errorCode, message };
  }
  if (status === 401) return { kind: 'TOKEN_INVALID', code: 'http_401' };
  if (status === 429) return { kind: 'PENDING', code: 'http_429', message: 'throttled', throttled: true };
  if (status >= 200 && status < 300 && isRecord(raw)) {
    const responseCode = String(body.ResponseCode ?? '').trim();
    if (responseCode !== '0') return { kind: 'UNKNOWN', code: `response_${responseCode || 'missing'}`.slice(0, 40), message: 'query not accepted' };
    const echoed = typeof body.CheckoutRequestID === 'string' ? body.CheckoutRequestID.trim() : '';
    if (echoed !== ours) return { kind: 'UNKNOWN', code: 'checkout_mismatch', message: 'answer is for another CheckoutRequestID' };
    const resultCode = body.ResultCode === undefined || body.ResultCode === null ? '' : String(body.ResultCode).trim();
    const resultDesc = safe(body.ResultDesc) || '';
    const rule = STK_QUERY_RESULT_OUTCOMES[resultCode];
    if (rule === 'PAID') return { kind: 'PAID', resultCode: '0', resultDesc };
    if (rule === 'FAILED') return { kind: 'FAILED', resultCode, resultDesc };
    if (rule === 'RETRY') return { kind: 'PENDING', code: `result_${resultCode}`, message: resultDesc || 'still processing' };
    return { kind: 'UNKNOWN', code: `result_${resultCode || 'missing'}`.slice(0, 40), message: resultDesc || 'unlisted result code' };
  }
  return { kind: 'UNKNOWN', code: `http_${status}`, message: 'no definitive answer from Daraja' };
}

/** Resolves with `p`, or rejects once `deadline` (epoch ms) passes. */
function withinDeadline<T>(p: Promise<T>, deadline: number, message: string): Promise<T> {
  if (!Number.isFinite(deadline)) return p;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    p.catch(() => undefined);
    return Promise.reject(new Error(message));
  }
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Maps one Daraja STK Push HTTP response (status + parsed JSON or null) to an outcome. */
export function mapStkResponse(status: number, raw: unknown): Mapped {
  const body: JsonRecord = isRecord(raw) ? raw : {};
  const errorCode = typeof body.errorCode === 'string' ? body.errorCode.trim() : '';
  if (errorCode) {
    const rule = DARAJA_ERROR_OUTCOMES[errorCode];
    if (rule === 'TOKEN') return { kind: 'TOKEN_INVALID', code: errorCode };
    const kind = rule ?? (status >= 400 && status < 500 ? 'REJECTED' : 'UNKNOWN');
    return { kind, code: errorCode, message: safe(body.errorMessage) || 'Daraja error' };
  }
  if (status === 401) return { kind: 'TOKEN_INVALID', code: 'http_401' };
  if (status >= 200 && status < 300 && isRecord(raw) && body.ResponseCode !== undefined) {
    const responseCode = String(body.ResponseCode).trim();
    const checkoutRequestId = typeof body.CheckoutRequestID === 'string' ? body.CheckoutRequestID.trim() : '';
    if (responseCode === '0') {
      if (!checkoutRequestId || checkoutRequestId.length > 100) {
        return { kind: 'UNKNOWN', code: 'missing_checkout_request_id', message: 'accepted without a CheckoutRequestID' };
      }
      return {
        kind: 'ACCEPTED',
        checkoutRequestId,
        merchantRequestId: typeof body.MerchantRequestID === 'string' ? body.MerchantRequestID.slice(0, 100) : null,
        responseCode,
        customerMessage: safe(body.CustomerMessage) || 'Success. Request accepted for processing',
      };
    }
    return { kind: 'REJECTED', code: responseCode.slice(0, 40), message: safe(body.ResponseDescription) || 'rejected by Daraja' };
  }
  if (status >= 400 && status < 500) return { kind: 'REJECTED', code: `http_${status}`, message: 'rejected by Daraja' };
  return { kind: 'UNKNOWN', code: `http_${status}`, message: 'no definitive answer from Daraja' };
}

// ── B2C (payout-destination verification, spec gh-11) ──────────────────────

export interface B2cConfig extends DarajaAuthConfig {
  /** The B2C (disbursement) shortcode: PartyA. */
  shortCode: string;
  initiatorName: string;
  /** The initiator password, encrypted offline with Safaricom's certificate. Never logged. */
  securityCredential: string;
  resultUrl: string;
  timeoutUrl: string;
  timeoutMs: number;
  totalTimeoutMs: number;
}

/** An https URL ending in /api/v1/mpesa/<suffix>/<MPESA_CALLBACK_TOKEN>, or a DarajaConfigError. */
function tokenUrl(env: NodeJS.ProcessEnv, name: string, suffix: string): string {
  const url = env[name]!.trim();
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new DarajaConfigError(`${name} must be an https:// URL`);
  if (url.includes('${')) throw new DarajaConfigError(`${name} contains an unexpanded \${...}: paste the literal MPESA_CALLBACK_TOKEN value`);
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new DarajaConfigError(`${name} is not a valid URL`);
  }
  if (!path.endsWith(`/api/v1/mpesa/${suffix}/${env.MPESA_CALLBACK_TOKEN!.trim()}`)) {
    throw new DarajaConfigError(`${name} must end with /api/v1/mpesa/${suffix}/<MPESA_CALLBACK_TOKEN>`);
  }
  return url;
}

/** Reads and validates the B2C settings (required when PAYOUTS_ENABLED=true); throws DarajaConfigError. */
export function b2cConfig(env: NodeJS.ProcessEnv = process.env): B2cConfig {
  const missing = [
    'DARAJA_CONSUMER_KEY',
    'DARAJA_CONSUMER_SECRET',
    'DARAJA_B2C_SHORTCODE',
    'DARAJA_B2C_INITIATOR_NAME',
    'DARAJA_B2C_SECURITY_CREDENTIAL',
    'DARAJA_B2C_RESULT_URL',
    'DARAJA_B2C_TIMEOUT_URL',
    'MPESA_CALLBACK_TOKEN',
  ].filter((k) => !env[k]?.trim());
  if (missing.length) throw new DarajaConfigError(`missing ${missing.join(', ')}`);
  const baseUrl = BASE_URLS[(env.DARAJA_ENVIRONMENT ?? 'sandbox').trim().toLowerCase()];
  if (!baseUrl) throw new DarajaConfigError('DARAJA_ENVIRONMENT must be sandbox or production');
  const shortCode = env.DARAJA_B2C_SHORTCODE!.trim();
  if (!/^\d{5,7}$/.test(shortCode)) throw new DarajaConfigError('DARAJA_B2C_SHORTCODE must be a 5-7 digit number');
  return {
    baseUrl,
    consumerKey: env.DARAJA_CONSUMER_KEY!.trim(),
    consumerSecret: env.DARAJA_CONSUMER_SECRET!.trim(),
    shortCode,
    initiatorName: env.DARAJA_B2C_INITIATOR_NAME!.trim(),
    securityCredential: env.DARAJA_B2C_SECURITY_CREDENTIAL!.trim(),
    resultUrl: tokenUrl(env, 'DARAJA_B2C_RESULT_URL', 'b2c/result'),
    timeoutUrl: tokenUrl(env, 'DARAJA_B2C_TIMEOUT_URL', 'b2c/timeout'),
    timeoutMs: Math.min(posInt(env.DARAJA_TIMEOUT_MS, 10_000), 60_000),
    oauthTimeoutMs: Math.min(posInt(env.DARAJA_OAUTH_TIMEOUT_MS, 5_000), 30_000),
    totalTimeoutMs: darajaTotalTimeoutMs(env),
  };
}

export interface B2cPaymentRequest {
  /** Recorded before the call (the payout_destinations row id); the result is matched on it. */
  originatorConversationId: string;
  /** 2547XXXXXXXX / 2541XXXXXXXX. */
  phone: string;
  /** Whole shillings. */
  amount: number;
  remarks: string;
}

export type B2cOutcome =
  | { kind: 'ACCEPTED'; conversationId: string }
  | { kind: 'REJECTED'; code: string; message: string }
  | { kind: 'UNKNOWN'; code: string; message: string };

type B2cMapped = B2cOutcome | { kind: 'TOKEN_INVALID'; code: string };

/** Maps one synchronous B2C answer (status + parsed JSON or null); same errorCode table as STK. */
export function mapB2cResponse(status: number, raw: unknown): B2cMapped {
  const body: JsonRecord = isRecord(raw) ? raw : {};
  const errorCode = typeof body.errorCode === 'string' ? body.errorCode.trim() : '';
  if (errorCode) {
    const rule = DARAJA_ERROR_OUTCOMES[errorCode];
    if (rule === 'TOKEN') return { kind: 'TOKEN_INVALID', code: errorCode };
    const kind = rule ?? (status >= 400 && status < 500 ? 'REJECTED' : 'UNKNOWN');
    return { kind, code: errorCode, message: safe(body.errorMessage) || 'Daraja error' };
  }
  if (status === 401) return { kind: 'TOKEN_INVALID', code: 'http_401' };
  if (status >= 200 && status < 300 && isRecord(raw) && body.ResponseCode !== undefined) {
    const responseCode = String(body.ResponseCode).trim();
    if (responseCode !== '0') return { kind: 'REJECTED', code: responseCode.slice(0, 20), message: safe(body.ResponseDescription) || 'rejected by Daraja' };
    const conversationId = typeof body.ConversationID === 'string' ? body.ConversationID.trim() : '';
    if (!conversationId || conversationId.length > 100) return { kind: 'UNKNOWN', code: 'missing_conversation_id', message: 'accepted without a ConversationID' };
    return { kind: 'ACCEPTED', conversationId };
  }
  if (status >= 400 && status < 500) return { kind: 'REJECTED', code: `http_${status}`, message: 'rejected by Daraja' };
  return { kind: 'UNKNOWN', code: `http_${status}`, message: 'no definitive answer from Daraja' };
}

export class B2cClient extends DarajaAuth<B2cConfig> {
  constructor(configSource: B2cConfig | (() => B2cConfig) = () => b2cConfig(), fetchImpl?: FetchLike, metrics?: GatewayMetrics) {
    super(configSource, fetchImpl, metrics);
  }

  /**
   * One B2C BusinessPayment. Never throws; never resent blindly (a resend could pay twice). The one
   * exception, as for STK: Daraja reported the token invalid, so the request was not processed.
   */
  async b2cPayment(req: B2cPaymentRequest): Promise<B2cOutcome> {
    let cfg: B2cConfig;
    try {
      cfg = this.config();
    } catch (error) {
      return { kind: 'REJECTED', code: 'config', message: (error as Error).message };
    }
    const deadline = Date.now() + cfg.totalTimeoutMs;
    let token: string;
    try {
      token = await this.accessToken(false, deadline);
    } catch (error) {
      console.error('[Daraja] no OAuth token, B2C not sent:', (error as Error).message);
      return { kind: 'REJECTED', code: 'oauth_unavailable', message: 'Daraja authentication failed' };
    }
    for (let attempt = 0; ; attempt++) {
      const budget = Math.min(cfg.timeoutMs, deadline - Date.now());
      if (budget <= 0) return { kind: 'REJECTED', code: 'deadline', message: 'Daraja did not answer in time' };
      const mapped = await this.postB2c(cfg, token, req, budget);
      if (mapped.kind !== 'TOKEN_INVALID') {
        console.info(`[Daraja] B2C ${mapped.kind}${mapped.kind === 'ACCEPTED' ? '' : ` (${mapped.code})`}`);
        return mapped;
      }
      if (attempt > 0) return { kind: 'REJECTED', code: mapped.code, message: 'Daraja rejected the access token' };
      this.invalidateToken();
      try {
        token = await this.accessToken(true, deadline);
      } catch (error) {
        console.error('[Daraja] OAuth refresh failed, B2C not sent:', (error as Error).message);
        return { kind: 'REJECTED', code: 'oauth_unavailable', message: 'Daraja authentication failed' };
      }
    }
  }

  private async postB2c(cfg: B2cConfig, token: string, req: B2cPaymentRequest, timeoutMs: number): Promise<B2cMapped> {
    const body = {
      OriginatorConversationID: req.originatorConversationId,
      InitiatorName: cfg.initiatorName,
      SecurityCredential: cfg.securityCredential,
      CommandID: 'BusinessPayment',
      Amount: req.amount,
      PartyA: Number(cfg.shortCode),
      PartyB: Number(req.phone),
      Remarks: req.remarks.slice(0, 100),
      QueueTimeOutURL: cfg.timeoutUrl,
      ResultURL: cfg.resultUrl,
      Occasion: '',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${cfg.baseUrl}/mpesa/b2c/v3/paymentrequest`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return { kind: 'UNKNOWN', code: 'timeout', message: 'no answer from Daraja in time' };
        const code = thrownErrorCode(error);
        if (NOT_SENT_CODES.has(code)) return { kind: 'REJECTED', code: `network_${code}`, message: 'Daraja unreachable' };
        return { kind: 'UNKNOWN', code: code ? `network_${code}` : 'network_error', message: 'connection to Daraja lost' };
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        return { kind: 'UNKNOWN', code: controller.signal.aborted ? 'timeout' : 'body_lost', message: 'Daraja response lost' };
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return mapB2cResponse(res.status, parsed);
    } finally {
      clearTimeout(timer);
      this.metrics.recordDarajaLatency(Date.now() - started);
    }
  }
}

export interface B2cResult {
  originatorConversationId: string;
  conversationId: string | null;
  /** Result.ResultCode as a string ("0" = paid). */
  resultCode: string;
  /** ReceiverPartyPublicName without its "2547… - " prefix, or null. Never logged. */
  receiverName: string | null;
}

/** Parses a B2C result callback body ({Result: {...}}); null when it is not one. */
export function parseB2cResult(body: unknown): B2cResult | null {
  const r = field(body, 'Result');
  if (!isRecord(r)) return null;
  const originatorConversationId = typeof r.OriginatorConversationID === 'string' ? r.OriginatorConversationID.trim() : '';
  if (!originatorConversationId || r.ResultCode === undefined || r.ResultCode === null) return null;
  const items = field(r, 'ResultParameters', 'ResultParameter');
  const list: unknown[] = Array.isArray(items) ? items : isRecord(items) ? [items] : [];
  const named = list.find((i) => isRecord(i) && i.Key === 'ReceiverPartyPublicName');
  const raw = isRecord(named) && typeof named.Value === 'string' ? named.Value : '';
  const sep = raw.indexOf(' - ');
  // No " - ": a leading phone ("254712345678 JOHN", "254712345678-JOHN") is still not the name.
  const receiverName = (sep >= 0 ? raw.slice(sep + 3) : (/^\d{9,12}\s*-?\s*(.*)$/.exec(raw.trim())?.[1] ?? raw)).trim() || null;
  return {
    originatorConversationId,
    conversationId: typeof r.ConversationID === 'string' && r.ConversationID.trim() ? r.ConversationID.trim().slice(0, 100) : null,
    resultCode: String(r.ResultCode).trim().slice(0, 20),
    receiverName,
  };
}

export const b2cClient = new B2cClient();

export const darajaClient = new DarajaClient();
