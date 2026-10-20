import { errorCode, type HttpClient } from '@/core/data/http-client';
import { isOverrideRefusal, type AppError } from '@/core/domain/app-error';
import { err, ok, type Result } from '@/core/domain/result';
import type { OverrideTarget, OversightQueue } from '../../domain/entities/oversight';
import { toOversightQueue } from '../models/oversight-dto';

const ADMIN = '/api/v1/admin';
/** Refusals carry their reason in the body; the datasource reads it raw. */
const REFUSAL_STATUSES = [400, 404, 409] as const;

/** Raw calls to /api/v1/admin (Bearer, MERCHANT_ADMIN, through the container's HttpClient). */
export class GatewayOversightDataSource {
  constructor(private readonly http: HttpClient) {}

  async queue(): Promise<Result<OversightQueue, AppError>> {
    const r = await this.http.request(`${ADMIN}/frozen-payouts`);
    if (!r.ok) return r;
    const q = toOversightQueue(r.value.data);
    return q ? ok(q) : err({ kind: 'unexpected', status: r.value.status });
  }

  async override(target: OverrideTarget, pin: string, note: string): Promise<Result<void, AppError>> {
    const id = encodeURIComponent(target.id);
    const [path, body] =
      target.kind === 'escrow'
        ? [`${ADMIN}/escrows/${id}/${target.action}`, { pin, note }]
        : [`${ADMIN}/payouts/${id}/resolve`, target.outcome === 'paid' ? { pin, note, outcome: 'paid', receipt: target.receipt } : { pin, note, outcome: 'failed' }];
    const r = await this.http.request(path, { method: 'POST', body, accept: REFUSAL_STATUSES });
    if (!r.ok) return r;
    const { status, data } = r.value;
    if (status < 300) return ok(undefined);
    const code = errorCode(data);
    if (isOverrideRefusal(code)) return err({ kind: 'override_refused', code });
    return err(status === 400 ? { kind: 'invalid_request' } : { kind: 'unexpected', status });
  }
}
