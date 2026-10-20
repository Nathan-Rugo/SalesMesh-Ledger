import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { OverrideTarget, OversightQueue } from '../../domain/entities/oversight';
import type { OversightRepository } from '../../domain/repositories/oversight-repository';
import type { GatewayOversightDataSource } from '../datasources/gateway-oversight-datasource';

/** Nothing is cached: the queue lives only in the caller's memory, never in storage. */
export class GatewayOversightRepository implements OversightRepository {
  private inflight: Promise<Result<OversightQueue, AppError>> | null = null;

  constructor(private readonly ds: GatewayOversightDataSource) {}

  queue(): Promise<Result<OversightQueue, AppError>> {
    if (this.inflight) return this.inflight;
    const p = this.ds.queue().finally(() => {
      if (this.inflight === p) this.inflight = null; // override() may have started a newer GET since
    });
    this.inflight = p;
    return p;
  }

  override(target: OverrideTarget, pin: string, note: string): Promise<Result<void, AppError>> {
    // A GET that started before the POST may carry the pre-override queue: the next queue() starts afresh.
    return this.ds.override(target, pin, note).finally(() => {
      this.inflight = null;
    });
  }
}
