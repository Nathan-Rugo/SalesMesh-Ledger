import { errorCode, type HttpClient } from '@/core/data/http-client';
import { isStkRefusal, type AppError } from '@/core/domain/app-error';
import { err, ok, type Result } from '@/core/domain/result';
import type { PaymentAttempt, StkRequest } from '../../domain/entities/stk-request';
import { toStkRequest } from '../models/stk-dto';

const STK = '/api/v1/payments/stk';
/** 409 (duplicate / key in flight / not provisioned), 502 REJECTED and 503 carry their reason in the body. */
const ACCEPT = [409, 502, 503] as const;

/** Raw calls to /api/v1/payments/stk (Bearer, through the container's HttpClient). */
export class GatewayCollectDataSource {
  constructor(private readonly http: HttpClient) {}

  async requestPayment(a: PaymentAttempt): Promise<Result<StkRequest, AppError>> {
    const body = { phone: a.msisdn, amount: a.amount, ...(a.confirmDuplicate ? { confirm_duplicate: true } : {}) };
    const r = await this.http.request(STK, { method: 'POST', body, headers: { 'Idempotency-Key': a.idempotencyKey }, accept: ACCEPT });
    if (!r.ok) return r;
    const { status, data } = r.value;
    // 502 with a request body is a definitive REJECTED request; a bare 502 is the rewrite's own failure.
    if (status < 300 || status === 502) {
      const value = toStkRequest(data);
      if (value) return ok(value);
      if (status < 300) return err({ kind: 'unexpected', status });
    }
    const code = errorCode(data);
    if (isStkRefusal(code)) return err({ kind: 'stk_refused', code });
    return err(status >= 500 ? { kind: 'unavailable' } : { kind: 'unexpected', status });
  }

  async status(id: string): Promise<Result<StkRequest, AppError>> {
    const r = await this.http.request(`${STK}/${encodeURIComponent(id)}`);
    if (!r.ok) return r;
    const value = toStkRequest(r.value.data);
    return value ? ok(value) : err({ kind: 'unexpected', status: r.value.status });
  }
}
