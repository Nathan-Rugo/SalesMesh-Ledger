import type { AppError } from '@/core/domain/app-error';
import { err, type Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import { pinPolicyViolation } from '@/shared/domain/pin-policy';
import type { Session } from '../entities/session';
import type { AuthRepository } from '../repositories/auth-repository';

export interface ChangePinInput {
  readonly currentPin: string;
  readonly newPin: string;
  readonly confirmPin: string;
}

/** Validates exactly as the gateway does (plus confirmation) before spending a throttled attempt. */
export class ChangePinUseCase implements UseCase<ChangePinInput, Session> {
  constructor(private readonly repo: AuthRepository) {}

  async execute({ currentPin, newPin, confirmPin }: ChangePinInput): Promise<Result<Session, AppError>> {
    if (currentPin.length === 0) return err({ kind: 'invalid_pin', reason: 'current_pin_missing', field: 'current_pin' });
    const violation = pinPolicyViolation(newPin);
    if (violation) return err({ kind: 'invalid_pin', reason: violation, field: 'new_pin' });
    if (newPin === currentPin) return err({ kind: 'invalid_pin', reason: 'pin_unchanged', field: 'new_pin' });
    if (confirmPin !== newPin) return err({ kind: 'invalid_pin', reason: 'pin_mismatch', field: 'confirm_pin' });
    return this.repo.changePin(currentPin, newPin);
  }
}
