export const ROLES = ['SALES_AGENT', 'MERCHANT_ADMIN'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** A signed-in session. The access token lives in memory only. */
export interface Session {
  readonly accessToken: string;
  /** Epoch ms at which the access token expires. */
  readonly expiresAt: number;
  readonly pinChangeRequired: boolean;
  readonly user: { readonly id: string; readonly role: Role };
}

export const homePathFor = (role: Role): '/agent' | '/admin' => (role === 'MERCHANT_ADMIN' ? '/admin' : '/agent');

/** Which role a protected path belongs to, or null for paths any signed-in user may open. */
export function roleForPath(path: string): Role | null {
  if (path === '/admin' || path.startsWith('/admin/')) return 'MERCHANT_ADMIN';
  if (path === '/agent' || path.startsWith('/agent/')) return 'SALES_AGENT';
  return null;
}

/** A `next=` value we may navigate to: a same-origin path ("/x"), never "//host" or "/\host". */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512 || raw[0] !== '/') return null;
  // Backslashes anywhere, and control characters, are refused: browsers treat "/\host" as "//host".
  if (raw[1] === '/' || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  return raw;
}

/** Where a session goes after sign-in or reload: forced PIN change first, then `next` if the role may open it. */
export function destinationFor(session: Session, next: string | null | undefined): string {
  if (session.pinChangeRequired) return '/register';
  const safe = safeNextPath(next);
  if (safe) {
    const owner = roleForPath(safe.split(/[?#]/)[0]!);
    if (owner === session.user.role) return safe;
  }
  return homePathFor(session.user.role);
}
