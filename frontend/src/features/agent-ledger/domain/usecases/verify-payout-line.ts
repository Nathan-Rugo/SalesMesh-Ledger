import type { AppError } from '@/core/domain/app-error';
import { err, type Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import type { PayoutLine } from '../entities/ledger';
import type { LedgerRepository } from '../repositories/ledger-repository';

export class GetPayoutLinesUseCase implements UseCase<void, readonly PayoutLine[]> {
  constructor(private readonly repo: LedgerRepository) {}

  execute(): Promise<Result<readonly PayoutLine[], AppError>> {
    return this.repo.payoutLines();
  }
}

/** Verifies the login phone as the payout line; an empty PIN never reaches the gateway. */
export class VerifyPayoutLineUseCase implements UseCase<{ readonly pin: string }, PayoutLine> {
  constructor(private readonly repo: LedgerRepository) {}

  async execute({ pin }: { readonly pin: string }): Promise<Result<PayoutLine, AppError>> {
    if (pin.length === 0) return err({ kind: 'invalid_pin', reason: 'pin_format', field: 'pin' });
    return this.repo.verifyPayoutLine(pin);
  }
}
