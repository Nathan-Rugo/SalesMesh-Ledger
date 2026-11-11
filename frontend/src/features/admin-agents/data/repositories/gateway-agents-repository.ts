import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { DirectoryAgent } from '../../domain/entities/agent';
import type { AgentsRepository } from '../../domain/repositories/agents-repository';
import type { GatewayAgentsDataSource } from '../datasources/gateway-agents-datasource';

export class GatewayAgentsRepository implements AgentsRepository {
  constructor(private readonly ds: GatewayAgentsDataSource) {}

  list(): Promise<Result<DirectoryAgent[], AppError>> {
    return this.ds.list();
  }
}
