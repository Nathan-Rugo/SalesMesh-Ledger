import type { AppError } from './app-error';
import type { Result } from './result';

/** One application action. Implementations never throw; failures come back as `AppError`. */
export interface UseCase<Input, Output> {
  execute(input: Input): Promise<Result<Output, AppError>>;
}
