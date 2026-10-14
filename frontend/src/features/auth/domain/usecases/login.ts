import type { AppError } from '@/core/domain/app-error';
import { err, type Result } from '@/core/domain/result';
import type { UseCase } from '@/core/domain/use-case';
import { normaliseKenyanMsisdn } from '@/shared/domain/msisdn';
import { isPinShaped } from '@/shared/domain/pin-policy';
import type { Session } from '../entities/session';
import type { AuthRepository } from '../repositories/auth-repository';

export interface LoginInput {
  readonly phone: string;
  readonly pin: string;
}

export class LoginUseCase implements UseCase<LoginInput, Session> {
  constructor(private readonly repo: AuthRepository) {}

  async execute({ phone, pin }: LoginInput): Promise<Result<Session, AppError>> {
    const msisdn = normaliseKenyanMsisdn(phone);
    if (!msisdn) return err({ kind: 'invalid_phone' });
    if (!isPinShaped(pin)) return err({ kind: 'invalid_pin', reason: 'pin_format', field: 'pin' });
    return this.repo.login(msisdn, pin);
  }
}
