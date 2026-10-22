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

/** A frozen escrow row of GET /api/v1/admin/frozen-payouts (admin.controller.ts, gh-14). */
export const frozenEscrowView = (o: Record<string, unknown> = {}) => ({
  escrow_id: 'e-1',
  agent_code: 'AG042',
  agent_name: 'Wanjiru Kamau',
  amount: 425.5,
  quarantine_reason: 'model_decision',
  security_hold: false,
  ufaa_frozen: false,
  receipt: 'SGH12ABC34',
  frozen_at: new Date(Date.now() - 80 * 3600_000).toISOString(),
  escalated_at: null,
  reviewed_at: null,
  overdue: true,
  risk: {
    decision: 'QUARANTINE',
    iso_score: 0.71,
    xgb_prob: 0.93,
    model_version: 'v1.0.0',
    shap: [
      { feature: 'velocity_v_i', attribution: 1.4, value: 12 },
      { feature: 'split_ratio_r_s', attribution: 0.6, value: 0.5 },
      { feature: 'recipient_reuse_count', attribution: -0.3, value: 0 },
    ],
    units: 'xgboost_log_odds_margin_uncalibrated',
  },
  ...o,
});

/** An UNRESOLVED payout row of GET /api/v1/admin/frozen-payouts. */
export const unresolvedPayoutView = (o: Record<string, unknown> = {}) => ({
  payout_id: 'p-9',
  agent_code: 'AG042',
  agent_name: 'Wanjiru Kamau',
  amount: 1500,
  msisdn: '2547******78',
  unresolved_at: new Date(Date.now() - 30 * 3600_000).toISOString(),
  escalated_at: null,
  overdue: true,
  ...o,
});

/** GET /api/v1/admin/frozen-payouts body; totals / overdue default to the lists' sizes. */
export const queueBody = (o: { escrows?: unknown[]; payouts?: unknown[] } & Record<string, unknown> = {}) => {
  const escrows = o.escrows ?? [];
  const payouts = o.payouts ?? [];
  const overdue = (xs: unknown[]) => xs.filter((x) => (x as { overdue?: boolean }).overdue).length;
  return {
    sla: { escrow_hours: 72, payout_hours: 24 },
    totals: { escrows: escrows.length, payouts: payouts.length },
    overdue: { escrows: overdue(escrows), payouts: overdue(payouts) },
    total_available: escrows.length + payouts.length,
    ...o,
    escrows,
    payouts,
  };
};

/** An STK request body as POST /api/v1/payments/stk and GET .../stk/:id send it (payments.controller.ts). */
export const stkView = (o: Record<string, unknown> = {}) => ({
  stk_request_id: 's-1',
  status: 'ACCEPTED',
  checkout_request_id: 'ws_CO_1',
  result_code: null,
  customer_message: 'Success. Request accepted for processing',
  paid: false,
  receipt: null,
  ...o,
});
