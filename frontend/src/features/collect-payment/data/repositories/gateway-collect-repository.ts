import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { PaymentAttempt, StkRequest } from '../../domain/entities/stk-request';
import type { CollectRepository } from '../../domain/repositories/collect-repository';
import type { GatewayCollectDataSource } from '../datasources/gateway-collect-datasource';

/** Nothing is cached or stored: the customer's phone lives only in the caller's memory. */
export class GatewayCollectRepository implements CollectRepository {
  constructor(private readonly ds: GatewayCollectDataSource) {}

  requestPayment(attempt: PaymentAttempt): Promise<Result<StkRequest, AppError>> {
    return this.ds.requestPayment(attempt);
  }

  status(id: string): Promise<Result<StkRequest, AppError>> {
    return this.ds.status(id);
  }
}
