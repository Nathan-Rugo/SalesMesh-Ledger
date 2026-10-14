import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import type { Session } from '../entities/session';
import type { AuthRepository } from '../repositories/auth-repository';

export class RefreshSessionUseCase implements UseCase<void, Session> {
  constructor(private readonly repo: AuthRepository) {}

  execute(): Promise<Result<Session, AppError>> {
    return this.repo.refresh();
  }
}
