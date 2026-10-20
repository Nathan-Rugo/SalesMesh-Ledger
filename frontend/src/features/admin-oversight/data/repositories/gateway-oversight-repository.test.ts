import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/core/domain/result';
import type { OversightQueue } from '../../domain/entities/oversight';
import type { GatewayOversightDataSource } from '../datasources/gateway-oversight-datasource';
import { GatewayOversightRepository } from './gateway-oversight-repository';

const q = (n: number) => ({ totals: { escrows: n, payouts: 0 } }) as unknown as OversightQueue;

describe('GatewayOversightRepository single-flight', () => {
  it('a GET that finishes after an override and a newer GET does not clear the newer one', async () => {
    const pending: Array<(v: unknown) => void> = [];
    const ds = {
      queue: vi.fn(() => new Promise((r) => pending.push(r))),
      override: vi.fn(async () => ok(undefined)),
    } as unknown as GatewayOversightDataSource;
    const repo = new GatewayOversightRepository(ds);

    const old = repo.queue();
    await repo.override({ kind: 'escrow', id: 'e-1', action: 'keep' }, '4826', 'A proper reason');
    const fresh = repo.queue(); // starts afresh after the override
    expect(ds.queue).toHaveBeenCalledTimes(2);
    pending[0]!(ok(q(1)));
    await old;
    expect(repo.queue()).toBe(fresh); // still shared
    expect(ds.queue).toHaveBeenCalledTimes(2);
    pending[1]!(ok(q(0)));
    expect(await fresh).toEqual(ok(q(0)));
  });
});
