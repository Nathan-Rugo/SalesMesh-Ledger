import type { AppError, PinErrorReason } from '../domain/app-error';
import { err, ok, type Result } from '../domain/result';

/** Supplies the in-memory access token and a single-flight refresh (implemented by the auth feature). */
export interface AccessTokenSource {
  currentAccessToken(): string | null;
  /** Concurrent callers share one `/refresh`; resolves to the new token or why there is none. */
  refreshAccessToken(): Promise<Result<string, AppError>>;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly data: T;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Attach `Authorization: Bearer`. Defaults to true. */
  readonly auth?: boolean;
  readonly signal?: AbortSignal;
}

export type HttpErrorListener = (error: AppError, path: string) => void;

const AUTH_PREFIX = '/api/v1/auth/';

/**
 * /auth/pin is a Bearer route: a 401 that is NOT invalid_credentials means the access token was
 * rejected by the auth middleware before any PIN check (no lockout attempt spent), so it may refresh.
 */
const isExpiredTokenOnPin = (path: string, body: unknown): boolean =>
  path === '/api/v1/auth/pin' && errorCode(body) !== 'invalid_credentials';

const PIN_REASONS: readonly PinErrorReason[] = ['pin_format', 'pin_repeated', 'pin_sequence', 'pin_common', 'pin_unchanged', 'current_pin_missing'];

/**
 * Auth-aware fetch. A 401 from a Bearer route (anything outside /api/v1/auth/*) triggers one shared
 * refresh and one retry; other /auth/* 401s are never retried, because each retry would count
 * toward the gateway's login lockout (the one exception is an expired token on /auth/pin). Never throws: every failure is an `AppError`.
 */
export class HttpClient {
  private tokens: AccessTokenSource | null = null;
  private readonly listeners = new Set<HttpErrorListener>();

  constructor(private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  setTokenSource(tokens: AccessTokenSource): void {
    this.tokens = tokens;
  }

  /** Errors from non-auth routes are also published here (pin_change_required, forbidden, …). */
  onError(listener: HttpErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<Result<HttpResponse<T>, AppError>> {
    const isAuthRoute = path.startsWith(AUTH_PREFIX);
    const useBearer = opts.auth ?? true;

    let res = await this.send(path, opts, useBearer ? this.tokens?.currentAccessToken() ?? null : null);
    if (res.ok && res.value.status === 401 && useBearer && this.tokens && (!isAuthRoute || isExpiredTokenOnPin(path, res.value.body))) {
      const refreshed = await this.tokens.refreshAccessToken();
      if (!refreshed.ok) return this.fail(path, isAuthRoute, refreshed.error);
      res = await this.send(path, opts, refreshed.value);
    }
    if (!res.ok) return this.fail(path, isAuthRoute, res.error);

    const { status, headers, body } = res.value;
    if (status >= 200 && status < 300) return ok({ status, data: body as T });
    return this.fail(path, isAuthRoute, toAppError(status, body, headers.get('Retry-After')));
  }

  private fail(path: string, isAuthRoute: boolean, error: AppError): Result<never, AppError> {
    if (!isAuthRoute) for (const l of this.listeners) l(error, path);
    return err(error);
  }

  private async send(
    path: string,
    opts: RequestOptions,
    token: string | null
  ): Promise<Result<{ status: number; headers: Headers; body: unknown }, AppError>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(path, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: opts.signal,
      });
    } catch {
      return err({ kind: 'unavailable' });
    }
    let body: unknown = null;
    if ((response.headers.get('Content-Type') ?? '').includes('application/json')) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
    return ok({ status: response.status, headers: response.headers, body });
  }
}

const errorCode = (body: unknown): string | undefined =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : undefined;

/** Retry-After as delta-seconds (what the gateway sends), or null. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\s*\d{1,6}\s*$/.test(value)) return null;
  return parseInt(value, 10);
}

/** Maps a gateway error response onto the app's error vocabulary. */
export function toAppError(status: number, body: unknown, retryAfter: string | null = null): AppError {
  const code = errorCode(body);
  switch (status) {
    case 400: {
      if (code !== 'invalid_pin') return { kind: 'invalid_request' };
      const b = body as { reason?: unknown; field?: unknown };
      const reason = PIN_REASONS.find((r) => r === b.reason) ?? 'pin_format';
      return { kind: 'invalid_pin', reason, field: b.field === 'current_pin' ? 'current_pin' : 'new_pin' };
    }
    case 401:
      return code === 'invalid_credentials' ? { kind: 'invalid_credentials' } : { kind: 'unauthenticated' };
    case 403:
      if (code === 'origin_not_allowed') return { kind: 'origin_not_allowed' };
      if (code === 'pin_change_required') return { kind: 'pin_change_required' };
      return { kind: 'forbidden' };
    case 429:
      return { kind: 'throttled', retryAfterS: parseRetryAfter(retryAfter) };
    default:
      // 5xx includes the Next rewrite's own failure when the gateway is down.
      return status >= 500 ? { kind: 'unavailable' } : { kind: 'unexpected', status };
  }
}
