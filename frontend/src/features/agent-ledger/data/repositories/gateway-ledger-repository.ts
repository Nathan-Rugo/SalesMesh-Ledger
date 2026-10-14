import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { LedgerSnapshot, Payout, PayoutLine } from '../../domain/entities/ledger';
import type { LedgerRepository } from '../../domain/repositories/ledger-repository';
import type { GatewayLedgerDataSource } from '../datasources/gateway-ledger-datasource';

/** Nothing is cached: balances and payouts live only in the caller's memory, never in storage. */
export class GatewayLedgerRepository implements LedgerRepository {
  private inflight: Promise<Result<LedgerSnapshot, AppError>> | null = null;

  constructor(private readonly ds: GatewayLedgerDataSource) {}

  snapshot(): Promise<Result<LedgerSnapshot, AppError>> {
    this.inflight ??= this.ds.snapshot().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  claim(pin: string, disclosureVersion: string): Promise<Result<Payout, AppError>> {
    return this.ds.claim(pin, disclosureVersion).finally(() => this.forget());
  }

  payoutLines(): Promise<Result<readonly PayoutLine[], AppError>> {
    return this.ds.payoutLines();
  }

  verifyPayoutLine(pin: string): Promise<Result<PayoutLine, AppError>> {
    return this.ds.verifyPayoutLine(pin).finally(() => this.forget());
  }

  /** A GET that started before a POST may carry the pre-POST balance: the next snapshot() starts afresh. */
  private forget(): void {
    this.inflight = null;
  }
}
