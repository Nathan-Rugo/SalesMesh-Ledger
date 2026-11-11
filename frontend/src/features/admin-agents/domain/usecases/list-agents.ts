import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import type { DirectoryAgent } from '../entities/agent';
import type { AgentsRepository } from '../repositories/agents-repository';

export class ListAgentsUseCase implements UseCase<void, DirectoryAgent[]> {
  constructor(private readonly repo: AgentsRepository) {}

  execute(): Promise<Result<DirectoryAgent[], AppError>> {
    return this.repo.list();
  }
}
