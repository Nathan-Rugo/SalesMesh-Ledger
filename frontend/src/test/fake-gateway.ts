import { vi } from 'vitest';

/** Builds a JSON Response the way the gateway sends them. */
export function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  if (body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A syntactically valid (unsigned) JWT-shaped token. */
export const token = (n: number | string) => `h.${n}.s`;

export const sessionBody = (opts: { role?: string; pinChangeRequired?: boolean; tok?: string } = {}) => ({
  access_token: opts.tok ?? token(1),
  token_type: 'Bearer',
  expires_in: 900,
  pin_change_required: opts.pinChangeRequired ?? false,
  user: { user_id: 'u-1', role: opts.role ?? 'SALES_AGENT' },
});

type Handler = (init: RequestInit & { url: string }) => Response | Promise<Response>;

/** fetch double routed by path; records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) throw new TypeError(`no route for ${url}`);
    return handler({ ...init, url });
  });
  return { fetch: fn as unknown as typeof fetch, calls, count: (url: string) => calls.filter((c) => c.url === url).length };
}

export const bodyOf = (init: RequestInit): unknown => JSON.parse(String(init.body));
export const authHeader = (init: RequestInit): string | undefined => (init.headers as Record<string, string>).Authorization;

/** A payout `view` as GET /api/v1/payouts and POST /claim send it (payout.controller.ts). */
export const payoutView = (o: Record<string, unknown> = {}) => ({
  payout_id: 'p-1',
  status: 'SENT',
  amount: 1235,
  msisdn: '2547******78',
  receipt: null,
  failure_reason: null,
  disclosure_version: '1',
  consent_hash: 'c'.repeat(64),
  created_at: '2026-10-14T08:00:00.000Z',
  resolved_at: null,
  ...o,
});

/** An accrual row of GET /api/v1/payouts (gh-13). */
export const accrualView = (o: Record<string, unknown> = {}) => ({
  escrow_id: 'e-1',
  amount_cents: 35_000,
  status: 'HELD',
  release_due_at: new Date(Date.now() + 3600_000).toISOString(),
  quarantine_reason: null,
  ...o,
});

/** GET /api/v1/payouts body; `balance` fields merge into the default balance. */
export const ledgerBody = (o: { balance?: Record<string, unknown> } & Record<string, unknown> = {}) => {
  const { balance, ...rest } = o;
  return {
    balance: { amount: 1235, cents: 123_523, escrows: 2, carry_cents: 0, payable_now: 1235, min_amount: 10, max_amount: 150_000, ...balance },
    destination: '2547******78',
    destination_changing: false,
    disclosure: { version: '1', text: 'Fuliza notice v1' },
    payouts: [],
    accruals: [],
    pending_count: 0,
    pending_cents: 0,
    remitted: [],
    ...rest,
  };
};

/** A payout-destination `view` (payout_destination.controller.ts). */
export const lineView = (o: Record<string, unknown> = {}) => ({
  destination_id: 'd-1',
  type: 'PERSONAL_MPESA',
  msisdn: '2547******78',
  status: 'PENDING_VERIFICATION',
  reject_reason: null,
  verified_at: null,
  cooling_off_until: null,
  created_at: '2026-10-14T08:00:00.000Z',
  ...o,
});
