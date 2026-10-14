import type { AppError } from '@/core/domain/app-error';
import { err, type Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import type { Payout } from '../entities/ledger';
import type { LedgerRepository } from '../repositories/ledger-repository';

export interface ClaimPayoutInput {
  readonly pin: string;
  /** The disclosure version the agent accepted, or null when not accepted. */
  readonly acceptedDisclosure: string | null;
}

/** Refuses an empty PIN or an unaccepted disclosure before spending a throttled PIN attempt. */
export class ClaimPayoutUseCase implements UseCase<ClaimPayoutInput, Payout> {
  constructor(private readonly repo: LedgerRepository) {}

  async execute({ pin, acceptedDisclosure }: ClaimPayoutInput): Promise<Result<Payout, AppError>> {
    if (!acceptedDisclosure) return err({ kind: 'invalid_request' });
    if (pin.length === 0) return err({ kind: 'invalid_pin', reason: 'pin_format', field: 'pin' });
    return this.repo.claim(pin, acceptedDisclosure);
  }
}
