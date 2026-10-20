import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { OverrideTarget, OversightQueue } from '../entities/oversight';

export interface OversightRepository {
  /** Single-flight: concurrent callers share one GET /api/v1/admin/frozen-payouts. */
  queue(): Promise<Result<OversightQueue, AppError>>;
  /** Release / keep an escrow, or resolve a payout; never moves money. `note` is already validated. */
  override(target: OverrideTarget, pin: string, note: string): Promise<Result<void, AppError>>;
}
