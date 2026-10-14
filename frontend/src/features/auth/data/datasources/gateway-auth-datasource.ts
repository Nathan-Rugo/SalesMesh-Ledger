import type { AppError } from '@/core/domain/app-error';
import { err, ok, type Result } from '@/core/domain/result';
import type { HttpClient } from '@/core/data/http-client';
import type { Session } from '../../domain/entities/session';
import { toSession } from '../models/session-dto';

/** Raw calls to the gateway's /api/v1/auth routes (same-origin, proxied by the Next rewrite). */
export class GatewayAuthDataSource {
  constructor(private readonly http: HttpClient) {}

  login(phone: string, pin: string): Promise<Result<Session, AppError>> {
    return this.session('/api/v1/auth/login', { phone, pin }, false);
  }

  refresh(): Promise<Result<Session, AppError>> {
    return this.session('/api/v1/auth/refresh', undefined, false);
  }

  /** Bearer route; an /auth/* 401 here (wrong current PIN) is never retried. */
  changePin(currentPin: string, newPin: string): Promise<Result<Session, AppError>> {
    return this.session('/api/v1/auth/pin', { current_pin: currentPin, new_pin: newPin }, true);
  }

  async logout(): Promise<Result<void, AppError>> {
    const r = await this.http.request('/api/v1/auth/logout', { method: 'POST', auth: false });
    return r.ok ? ok(undefined) : r;
  }

  private async session(path: string, body: unknown, auth: boolean): Promise<Result<Session, AppError>> {
    const r = await this.http.request(path, { method: 'POST', body, auth });
    if (!r.ok) return r;
    const session = toSession(r.value.data);
    return session ? ok(session) : err({ kind: 'unexpected', status: r.value.status });
  }
}
