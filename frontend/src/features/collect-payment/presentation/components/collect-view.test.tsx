// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// render-app first: its next/navigation mock must be registered before the view loads.
import { nav, renderApp } from '@/test/render-app';
import { bodyOf, fakeFetch, json, sessionBody, stkView } from '@/test/fake-gateway';
import { CollectView } from './collect-view';

const REFRESH = '/api/v1/auth/refresh';
const STK = '/api/v1/payments/stk';
const STATUS = `${STK}/s-1`;

type Reply = (init: RequestInit) => Response | Promise<Response>;
const keyOf = (init: RequestInit) => (init.headers as Record<string, string>)['Idempotency-Key'];

/** A fake gateway whose POST and GET status answers can change between calls. */
function gateway(post: Reply, status: Reply = () => json(200, stkView())) {
  const state = { post, status };
  const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), [STK]: (i) => state.post(i), [STATUS]: (i) => state.status(i) });
  return { gw, state, posts: () => gw.calls.filter((c) => c.url === STK).map((c) => c.init) };
}

async function start(g: ReturnType<typeof gateway>) {
  renderApp(<CollectView />, g.gw.fetch);
  await screen.findByLabelText("Customer's phone");
}

function fill(phone: string, amount: string) {
  fireEvent.change(screen.getByLabelText("Customer's phone"), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: 'Send payment prompt' }));
}

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const setVisibility = (v: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('request payment (I/O matrix)', () => {
  it('happy path: one POST with a key → waiting → polls → Paid with the receipt and the seal; polling stops', async () => {
    const g = gateway(() => json(201, stkView()));
    await start(g);
    fill('0792 189 991', '1');
    expect(await screen.findByRole('heading', { name: /Check the customer.s phone/ })).toBeInTheDocument();
    const [post] = g.posts();
    expect(g.posts()).toHaveLength(1);
    expect(bodyOf(post!)).toEqual({ phone: '254792189991', amount: 1 });
    expect(keyOf(post!)).toMatch(/^stk-[0-9a-f]{32}$/);
    expect(screen.getByText('0792 ••• 991')).toBeInTheDocument();
    expect(screen.queryByText('254792189991')).not.toBeInTheDocument();

    await tick(3_000);
    expect(g.gw.count(STATUS)).toBe(1);
    g.state.status = () => json(200, stkView({ paid: true, receipt: 'UAB1C2D3E4' }));
    await tick(3_000);
    expect(await screen.findByRole('heading', { name: 'Paid' })).toBeInTheDocument();
    expect(screen.getByText('UAB1C2D3E4')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cleared · on the ledger' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See it in your ledger' })).toHaveAttribute('href', '/agent');
    const polls = g.gw.count(STATUS);
    await tick(9_000);
    expect(g.gw.count(STATUS)).toBe(polls);
  });

  it('customer cancels (1032 on a poll): "Customer cancelled", polling stops, Try again prefills a fresh request', async () => {
    const g = gateway(() => json(201, stkView()));
    await start(g);
    fill('0792189991', '250');
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    g.state.status = () => json(200, stkView({ status: 'FAILED', result_code: '1032' }));
    await tick(3_000);
    expect(await screen.findByText('Customer cancelled the prompt.')).toBeInTheDocument();
    const polls = g.gw.count(STATUS);
    await tick(9_000);
    expect(g.gw.count(STATUS)).toBe(polls);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByLabelText("Customer's phone")).toHaveValue('0792 189 991');
    expect(screen.getByLabelText('Amount (KES)')).toHaveValue('250');
    fireEvent.click(screen.getByRole('button', { name: 'Send payment prompt' }));
    await waitFor(() => expect(g.posts()).toHaveLength(2));
    expect(keyOf(g.posts()[1]!)).not.toBe(keyOf(g.posts()[0]!));
  });

  it('a FAILED reply to the POST itself shows the reason and never polls', async () => {
    const g = gateway(() => json(201, stkView({ status: 'FAILED', result_code: '1' })));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByText("The customer's M-Pesa balance is too low.")).toBeInTheDocument();
    await tick(6_000);
    expect(g.gw.count(STATUS)).toBe(0);
  });

  it('same sale twice within 60 s: 409 → "Prompt again?" → resend with confirm_duplicate and a new key', async () => {
    const g = gateway(() => json(409, { error: 'possible_duplicate' }));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByRole('heading', { name: 'Prompt again?' })).toBeInTheDocument();
    g.state.post = () => json(201, stkView());
    fireEvent.click(screen.getByRole('button', { name: 'Send another prompt' }));
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    const [first, second] = g.posts();
    expect(bodyOf(first!)).toEqual({ phone: '254712345678', amount: 100 });
    expect(bodyOf(second!)).toEqual({ phone: '254712345678', amount: 100, confirm_duplicate: true });
    expect(keyOf(second!)).not.toBe(keyOf(first!));
  });

  it('cancelling the duplicate sheet sends nothing more', async () => {
    const g = gateway(() => json(409, { error: 'possible_duplicate' }));
    await start(g);
    fill('0712345678', '100');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Send payment prompt' })).toBeInTheDocument();
    expect(screen.getByLabelText("Customer's phone")).toHaveValue('0712 345 678');
    expect(screen.getByLabelText('Amount (KES)')).toHaveValue('100');
    expect(g.posts()).toHaveLength(1);
  });

  it('network drop after submit: "Can\'t reach SalesMesh" + Retry resends with the SAME key (no second prompt)', async () => {
    const g = gateway(() => {
      throw new TypeError('Failed to fetch');
    });
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByText('Can’t reach SalesMesh')).toBeInTheDocument();
    expect(screen.getByLabelText("Customer's phone")).toHaveValue('0712345678');
    g.state.post = () => json(201, stkView());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    const [first, second] = g.posts();
    expect(keyOf(second!)).toBe(keyOf(first!));
  });

  it('rate limited: 429 Retry-After → "Try again in N s" and the button stays disabled until it runs out', async () => {
    const g = gateway(() => json(429, { error: 'rate_limited' }, { 'Retry-After': '30' }));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByText('Too many requests. Try again in 30 s.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Try again in/ });
    expect(button).toBeDisabled();
    await tick(31_000);
    expect(screen.getByRole('button', { name: 'Send payment prompt' })).toBeEnabled();
  });

  it('STK disabled (503 stk_disabled): switched-off copy; Daraja down (bare 503): unreachable banner', async () => {
    const g = gateway(() => json(503, { error: 'stk_disabled' }));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByText(/Payment requests are switched off for now/)).toBeInTheDocument();
    g.state.post = () => json(503, { error: 'temporarily_unavailable' });
    fireEvent.click(screen.getByRole('button', { name: 'Send payment prompt' }));
    expect(await screen.findByText('Can’t reach SalesMesh')).toBeInTheDocument();
  });

  it('502 REJECTED: "No prompt was sent" and no polling', async () => {
    const g = gateway(() => json(502, stkView({ status: 'REJECTED', error: 'stk_rejected' })));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByRole('heading', { name: 'No prompt was sent' })).toBeInTheDocument();
    await tick(6_000);
    expect(g.gw.count(STATUS)).toBe(0);
  });

  it.each([
    ['0612345678', '100', true, false],
    ['0712345678', '0', false, true],
    ['0712345678', '1.5', false, true],
    ['0712345678', '250001', false, true],
  ])('bad input %s / %s: inline field errors, no request sent', async (phone, amount, phoneBad, amountBad) => {
    const g = gateway(() => json(201, stkView()));
    await start(g);
    fill(phone, amount);
    expect(screen.getByLabelText("Customer's phone").getAttribute('aria-invalid')).toBe(phoneBad ? 'true' : null);
    expect(screen.getByLabelText('Amount (KES)').getAttribute('aria-invalid')).toBe(amountBad ? 'true' : null);
    expect(g.posts()).toHaveLength(0);
  });

  it('polling pauses while the page is hidden, resumes on return, and stops at 3 min with "Still waiting"', async () => {
    const g = gateway(() => json(201, stkView()));
    await start(g);
    fill('0712345678', '100');
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    setVisibility('hidden');
    await tick(9_000);
    expect(g.gw.count(STATUS)).toBe(0);
    setVisibility('visible');
    await tick(0);
    expect(g.gw.count(STATUS)).toBe(1);
    await tick(3 * 60_000);
    expect(await screen.findByRole('heading', { name: 'Still waiting' })).toBeInTheDocument();
    const polls = g.gw.count(STATUS);
    await tick(9_000);
    expect(g.gw.count(STATUS)).toBe(polls);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await tick(3_000);
    expect(g.gw.count(STATUS)).toBe(polls + 1);
  });

  it('a 202 UNKNOWN reply keeps polling and tells the agent not to resend', async () => {
    const g = gateway(() => json(202, stkView({ status: 'UNKNOWN' })), () => json(200, stkView({ status: 'PENDING' })));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByText(/Do not resend/)).toBeInTheDocument();
    await tick(6_000);
    expect(g.gw.count(STATUS)).toBe(2);
    expect(screen.queryByRole('button', { name: 'New request' })).not.toBeInTheDocument();
  });
  it('409 idempotency_in_progress: resubmitting the same sale reuses the SAME key (never a second prompt)', async () => {
    const g = gateway(() => json(409, { error: 'idempotency_in_progress' }, { 'Retry-After': '5' }));
    await start(g);
    fill('0712345678', '100');
    expect(await screen.findByText(/it will not prompt twice/)).toBeInTheDocument();
    g.state.post = () => json(201, stkView());
    fireEvent.click(screen.getByRole('button', { name: 'Send payment prompt' }));
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    const [first, second] = g.posts();
    expect(keyOf(second!)).toBe(keyOf(first!));
  });

  it('hidden past the 3-minute window: on return it looks once more and shows Paid, not "Still waiting"', async () => {
    const g = gateway(() => json(201, stkView()));
    await start(g);
    fill('0712345678', '100');
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    setVisibility('hidden');
    await tick(4 * 60_000);
    expect(g.gw.count(STATUS)).toBe(0);
    g.state.status = () => json(200, stkView({ paid: true, receipt: 'UAB1C2D3E4' }));
    setVisibility('visible');
    expect(await screen.findByRole('heading', { name: 'Paid' })).toBeInTheDocument();
    expect(screen.queryByText('Still waiting')).not.toBeInTheDocument();
  });

  it('a 404 on status (request gone) stops polling instead of retrying for 3 minutes', async () => {
    const g = gateway(() => json(201, stkView()), () => json(404, { error: 'not_found' }));
    await start(g);
    fill('0712345678', '100');
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    await tick(3_000);
    expect(await screen.findByRole('heading', { name: 'Still waiting' })).toBeInTheDocument();
    await tick(9_000);
    expect(g.gw.count(STATUS)).toBe(1);
  });

  it('EXPIRED on a poll: "check with the customer", polling stops', async () => {
    const g = gateway(() => json(201, stkView()), () => json(200, stkView({ status: 'EXPIRED' })));
    await start(g);
    fill('0712345678', '100');
    await screen.findByRole('heading', { name: /Check the customer.s phone/ });
    await tick(3_000);
    expect(await screen.findByRole('heading', { name: 'No answer from M-Pesa' })).toBeInTheDocument();
    await tick(9_000);
    expect(g.gw.count(STATUS)).toBe(1);
  });
});
