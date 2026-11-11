import type { HttpClient } from '@/core/data/http-client';
import type { AppError } from '@/core/domain/app-error';
import { err, ok, type Result } from '@/core/domain/result';
import type { DirectoryAgent } from '../../domain/entities/agent';
import { toAgents } from '../models/agents-dto';

/** Raw call to GET /api/v1/admin/agents (Bearer, MERCHANT_ADMIN). */
export class GatewayAgentsDataSource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Result<DirectoryAgent[], AppError>> {
    const r = await this.http.request('/api/v1/admin/agents');
    if (!r.ok) return r;
    const agents = toAgents(r.value.data);
    return agents ? ok(agents) : err({ kind: 'unexpected', status: r.value.status });
  }
}
