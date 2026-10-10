/**
 * @file unknown.ts
 * @description Safe reading of untrusted values (Daraja bodies, stored JSONB payloads, thrown
 * errors) typed as `unknown` instead of `any`: navigation never throws and never invents a type.
 */

export type JsonRecord = Record<string, unknown>;

/** A plain object (not null, not an array). */
export const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v.a.b.c` when every step is an object, else undefined. */
export function field(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The error's own `code` (pg SQLSTATE, Node errno), or '' when it has none. */
export function ownErrorCode(e: unknown): string {
  const c = field(e, 'code');
  return c === undefined || c === null ? '' : String(c);
}

/** `cause.code` (undici/fetch network errors) falling back to the error's own `code`, or ''. */
export function errorCode(e: unknown): string {
  const c = field(e, 'cause', 'code') ?? field(e, 'code');
  return c === undefined || c === null ? '' : String(c);
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
