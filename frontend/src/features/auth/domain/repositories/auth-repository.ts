import type { AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import type { Session } from '../entities/session';

export interface AuthRepository {
  /** `phone` is a normalised MSISDN (2547XXXXXXXX). */
  login(phone: string, pin: string): Promise<Result<Session, AppError>>;
  /** Single-flight: concurrent calls share one gateway `/refresh`. */
  refresh(): Promise<Result<Session, AppError>>;
  logout(): Promise<Result<void, AppError>>;
  changePin(currentPin: string, newPin: string): Promise<Result<Session, AppError>>;
  current(): Session | null;
  /** Drops the in-memory session without calling the gateway (another tab signed out). */
  clear(): void;
  /** Notified on every session change; returns an unsubscribe function. */
  subscribe(listener: (session: Session | null) => void): () => void;
  /** True when this browser has signed in before and a refresh is worth trying. */
  hasSessionHint(): boolean;
}
