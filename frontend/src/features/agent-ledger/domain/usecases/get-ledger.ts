import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import type { LedgerSnapshot } from '../entities/ledger';
import type { LedgerRepository } from '../repositories/ledger-repository';

export class GetLedgerUseCase implements UseCase<void, LedgerSnapshot> {
  constructor(private readonly repo: LedgerRepository) {}

  execute(): Promise<Result<LedgerSnapshot, AppError>> {
    return this.repo.snapshot();
  }
}
