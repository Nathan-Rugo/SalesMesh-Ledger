import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { DirectoryAgent } from '../entities/agent';

export interface AgentsRepository {
  /** GET /api/v1/admin/agents. Nothing is cached. */
  list(): Promise<Result<DirectoryAgent[], AppError>>;
}
