import { errorCode, type HttpClient } from '@/core/data/http-client';
import { isPayoutRefusal, type AppError } from '@/core/domain/app-error';
import { err, ok, type Result } from '@/core/domain/result';
import type { LedgerSnapshot, Payout, PayoutLine } from '../../domain/entities/ledger';
import { toClaimedPayout, toLedgerSnapshot, toPayoutLines, toRegisteredLine } from '../models/ledger-dto';

const PAYOUTS = '/api/v1/payouts';
const LINES = '/api/v1/payout-destinations';
/** Refusals carry their reason in the body; the datasource reads it raw. */
const REFUSAL_STATUSES = [409, 502, 503] as const;

/** A 409 / 502 / 503 body → its payout refusal; a bare 5xx (the rewrite's own) is `unavailable`. */
function refusal(status: number, body: unknown): AppError {
  const code = errorCode(body);
  if (isPayoutRefusal(code)) return { kind: 'payout_refused', code };
  return status >= 500 ? { kind: 'unavailable' } : { kind: 'unexpected', status };
}

/** Raw calls to /api/v1/payouts and /api/v1/payout-destinations (Bearer, through the container's HttpClient). */
export class GatewayLedgerDataSource {
  constructor(private readonly http: HttpClient) {}

  snapshot(): Promise<Result<LedgerSnapshot, AppError>> {
    return this.call(PAYOUTS, undefined, toLedgerSnapshot);
  }

  claim(pin: string, disclosureVersion: string): Promise<Result<Payout, AppError>> {
    return this.call(`${PAYOUTS}/claim`, { pin, disclosure_version: disclosureVersion }, toClaimedPayout);
  }

  payoutLines(): Promise<Result<PayoutLine[], AppError>> {
    return this.call(LINES, undefined, toPayoutLines);
  }

  verifyPayoutLine(pin: string): Promise<Result<PayoutLine, AppError>> {
    return this.call(LINES, { pin }, toRegisteredLine);
  }

  private async call<T>(path: string, body: unknown, map: (b: unknown) => T | null): Promise<Result<T, AppError>> {
    const r = await this.http.request(path, body === undefined ? { accept: REFUSAL_STATUSES } : { method: 'POST', body, accept: REFUSAL_STATUSES });
    if (!r.ok) return r;
    const { status, data } = r.value;
    if (status >= 300) return err(refusal(status, data));
    const value = map(data);
    return value === null ? err({ kind: 'unexpected', status }) : ok(value);
  }
}
