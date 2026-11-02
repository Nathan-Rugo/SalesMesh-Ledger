import type { AppError } from '@/core/domain/app-error';
import { err, type Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import { normaliseKenyanMsisdn } from '@/shared/domain/msisdn';
import { parseStkAmount, type PaymentAttempt, type StkRequest } from '../entities/stk-request';
import type { CollectRepository } from '../repositories/collect-repository';

export interface PaymentForm {
  readonly phone: string;
  readonly amount: string;
}

/** The form as the gateway validates it, or which fields it would refuse. */
export function validatePaymentForm(f: PaymentForm): Result<{ msisdn: string; amount: number }, AppError> {
  const msisdn = normaliseKenyanMsisdn(f.phone);
  const amount = parseStkAmount(f.amount);
  if (msisdn === null || amount === null) return err({ kind: 'invalid_payment_input', phone: msisdn === null, amount: amount === null });
  return { ok: true, value: { msisdn, amount } };
}

/** Sends one attempt; re-checks it so nothing invalid ever reaches the gateway. */
export class RequestPaymentUseCase implements UseCase<PaymentAttempt, StkRequest> {
  constructor(private readonly repo: CollectRepository) {}

  async execute(a: PaymentAttempt): Promise<Result<StkRequest, AppError>> {
    const v = validatePaymentForm({ phone: a.msisdn, amount: String(a.amount) });
    if (!v.ok) return v;
    if (a.idempotencyKey.length === 0) return err({ kind: 'invalid_request' });
    return this.repo.requestPayment({ ...a, msisdn: v.value.msisdn, amount: v.value.amount });
  }
}

export class GetPaymentStatusUseCase implements UseCase<string, StkRequest> {
  constructor(private readonly repo: CollectRepository) {}

  execute(id: string): Promise<Result<StkRequest, AppError>> {
    return this.repo.status(id);
  }
}
