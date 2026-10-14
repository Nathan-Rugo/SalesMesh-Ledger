/** A use-case outcome: errors are values, never thrown across layers. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const mapResult = <T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> => (r.ok ? ok(f(r.value)) : r);
