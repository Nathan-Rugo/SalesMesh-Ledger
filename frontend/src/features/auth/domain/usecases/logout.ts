import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import type { AuthRepository } from '../repositories/auth-repository';

export class LogoutUseCase implements UseCase<void, void> {
  constructor(private readonly repo: AuthRepository) {}

  execute(): Promise<Result<void, AppError>> {
    return this.repo.logout();
  }
}
