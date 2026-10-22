import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { PaymentAttempt, StkRequest } from '../entities/stk-request';

export interface CollectRepository {
  /** POST /api/v1/payments/stk. A 502 REJECTED is a request (status REJECTED), not an error. */
  requestPayment(attempt: PaymentAttempt): Promise<Result<StkRequest, AppError>>;
  /** GET /api/v1/payments/stk/:id (the agent's own requests only). */
  status(id: string): Promise<Result<StkRequest, AppError>>;
}
