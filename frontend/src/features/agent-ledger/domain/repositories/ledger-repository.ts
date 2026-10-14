import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { LedgerSnapshot, Payout, PayoutLine } from '../entities/ledger';

export interface LedgerRepository {
  /** Single-flight: concurrent callers share one GET /api/v1/payouts. */
  snapshot(): Promise<Result<LedgerSnapshot, AppError>>;
  /** Claims the whole balance; resolves to the payout the gateway opened. */
  claim(pin: string, disclosureVersion: string): Promise<Result<Payout, AppError>>;
  payoutLines(): Promise<Result<readonly PayoutLine[], AppError>>;
  /** Registers the login phone as the payout line (a verification B2C is sent). */
  verifyPayoutLine(pin: string): Promise<Result<PayoutLine, AppError>>;
}
