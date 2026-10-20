import type { AppError } from '@/core/domain/app-error';
import { err, type Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import { validNote, validReceipt, type OverrideTarget, type OversightQueue } from '../entities/oversight';
import type { OversightRepository } from '../repositories/oversight-repository';

export class GetQueueUseCase implements UseCase<void, OversightQueue> {
  constructor(private readonly repo: OversightRepository) {}

  execute(): Promise<Result<OversightQueue, AppError>> {
    return this.repo.queue();
  }
}

export interface OverrideInput {
  readonly target: OverrideTarget;
  readonly pin: string;
  readonly note: string;
}

/** Refuses a short/long note, a bad receipt or an empty PIN before spending a throttled PIN attempt. */
export class OverrideUseCase implements UseCase<OverrideInput, void> {
  constructor(private readonly repo: OversightRepository) {}

  async execute({ target, pin, note }: OverrideInput): Promise<Result<void, AppError>> {
    const n = validNote(note);
    if (!n) return err({ kind: 'override_refused', code: 'invalid_note' });
    let t = target;
    if (t.kind === 'payout' && t.outcome === 'paid') {
      const receipt = validReceipt(t.receipt);
      if (!receipt) return err({ kind: 'invalid_request' });
      t = { ...t, receipt };
    }
    if (pin.length === 0) return err({ kind: 'invalid_pin', reason: 'pin_format', field: 'pin' });
    return this.repo.override(t, pin, n);
  }
}
