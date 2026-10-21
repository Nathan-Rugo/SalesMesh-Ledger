// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// render-app first: its next/navigation mock must be registered before the pages load.
import { nav, renderApp } from '@/test/render-app';
import { accrualView, bodyOf, fakeFetch, json, ledgerBody, lineView, payoutView, sessionBody } from '@/test/fake-gateway';
import AgentPage from '@/app/(dashboard)/agent/page';
import { DashboardShell } from '@/app/(dashboard)/dashboard-shell';
import { AgentDashboard, PayoutsView } from './ledger-views';

const REFRESH = '/api/v1/auth/refresh';
const GET = '/api/v1/payouts';
const CLAIM = '/api/v1/payouts/claim';
const LINES = '/api/v1/payout-destinations';

type Reply = (init: RequestInit) => Response;
/** A fake gateway whose GET /payouts answer can change between calls. */
function gateway(first: unknown, extra: Record<string, Reply> = {}) {
  const state: { ledger: () => Response } = { ledger: () => json(200, first) };
  const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), [GET]: () => state.ledger(), ...extra });
  return { gw, state };
}

const claimFlow = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^Claim KES/ }));
  fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }));
  fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
};
const send = () => fireEvent.click(screen.getByRole('button', { name: /^Send KES/ }));

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('agent dashboard (I/O matrix)', () => {
  it('first visit, no sales: zero slip and the lifecycle explainer, no claim button', async () => {
    const { gw } = gateway(ledgerBody({ balance: { amount: 0, cents: 0, escrows: 0, payable_now: 0 } }));
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByText('How your commission moves')).toBeInTheDocument();
    expect(screen.getAllByText('KES 0.00').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Claim/ })).not.toBeInTheDocument();
  });

  it('accruals holding: amount, "In escrow" pill, ticking countdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const due = new Date(Date.now() + 2 * 3600_000 + 5 * 60_000).toISOString();
    const { gw } = gateway(ledgerBody({ accruals: [accrualView({ release_due_at: due })], pending_count: 1, pending_cents: 35_000 }));
    renderApp(<AgentDashboard />, gw.fetch);
    const list = within(await screen.findByRole('list'));
    expect(list.getByText('In escrow')).toBeInTheDocument();
    expect(list.getByText('KES 350.00')).toBeInTheDocument();
    expect(list.getByText('2h 05m')).toBeInTheDocument();
    await act(async () => {}); // flush the ticking effect before moving the clock
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(list.getByText('2h 04m')).toBeInTheDocument();
  });

  it('hold matures: the countdown reaching zero refetches; the row moves into the balance from the server', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const due = new Date(Date.now() + 3_000).toISOString();
    const { gw, state } = gateway(
      ledgerBody({ balance: { amount: 0, cents: 0, payable_now: 0 }, accruals: [accrualView({ release_due_at: due })], pending_count: 1, pending_cents: 35_000 })
    );
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByText('In escrow')).toBeInTheDocument();
    state.ledger = () => json(200, ledgerBody({ balance: { amount: 350, cents: 35_000, payable_now: 350 } }));
    const before = gw.count(GET);
    await act(async () => {}); // flush the ticking effect before moving the clock
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText('Clearing…')).toBeInTheDocument(); // never flipped locally
    expect(gw.count(GET)).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });
    await waitFor(() => expect(gw.count(GET)).toBe(before + 1));
    expect(await screen.findByRole('button', { name: 'Claim KES 350.00' })).toBeEnabled();
    expect(screen.queryByRole('list')).not.toBeInTheDocument(); // the timeline is gone
  });

  it('quarantined: pill and short reason, no countdown', async () => {
    const { gw } = gateway(ledgerBody({ accruals: [accrualView({ status: 'QUARANTINED', quarantine_reason: 'security_hold' })] }));
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByText('Quarantined')).toBeInTheDocument();
    expect(screen.getByText(/security check/)).toBeInTheDocument();
    expect(screen.queryByText(/Clears in/)).not.toBeInTheDocument();
  });

  it('claim OK: disclosure, then PIN, then one POST; the open payout shows as SENT and the balance is 0', async () => {
    const { gw, state } = gateway(ledgerBody(), { [CLAIM]: () => json(202, { payout: payoutView() }) });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    expect(screen.queryByText('Fuliza notice v1')).not.toBeInTheDocument();
    state.ledger = () => json(200, ledgerBody({ balance: { amount: 0, cents: 23, payable_now: 0 }, payouts: [payoutView()] }));
    send();
    expect(await screen.findByText(/Payout sent to m-pesa/i)).toBeInTheDocument();
    expect(gw.count(CLAIM)).toBe(1);
    expect(bodyOf(gw.calls.find((c) => c.url === CLAIM)!.init)).toEqual({ pin: '4826', disclosure_version: '1' });
    expect(screen.getByText(/A payout is on its way/)).toBeInTheDocument();
  });

  it('shows the Fuliza disclosure before the PIN step', async () => {
    const { gw } = gateway(ledgerBody());
    renderApp(<AgentDashboard />, gw.fetch);
    fireEvent.click(await screen.findByRole('button', { name: /^Claim KES/ }));
    expect(screen.getByText('Fuliza notice v1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
  });

  it.each([
    ['below_minimum', /below the payout minimum/],
    ['no_active_destination', /Verify your M-Pesa line first/],
    ['destination_changing', /being changed/],
    ['above_maximum', /above the payout maximum/],
  ])('claim refused 409 %s: inline next step, no retry loop', async (code, text) => {
    const { gw } = gateway(ledgerBody(), { [CLAIM]: () => json(409, { error: code }) });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    send();
    expect(await screen.findByText(text)).toBeInTheDocument();
    await act(async () => {});
    expect(gw.count(CLAIM)).toBe(1);
  });

  it('409 payout_in_progress shows the open payout instead of an error', async () => {
    const { gw, state } = gateway(ledgerBody(), { [CLAIM]: () => json(409, { error: 'payout_in_progress' }) });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    state.ledger = () => json(200, ledgerBody({ payouts: [payoutView({ status: 'UNKNOWN' })] }));
    send();
    expect(await screen.findByText(/Payout checking with m-pesa/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disclosure changed: the new text is shown and must be accepted again', async () => {
    const { gw, state } = gateway(ledgerBody(), { [CLAIM]: () => json(409, { error: 'disclosure_changed', disclosure: { version: '2', text: 'Fuliza notice v2' } }) });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    state.ledger = () => json(200, ledgerBody({ disclosure: { version: '2', text: 'Fuliza notice v2' } }));
    send();
    expect(await screen.findByText('Fuliza notice v2')).toBeInTheDocument();
    expect(screen.getByText(/notice has changed/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
  });

  it('wrong PIN: field error, PIN cleared; throttled: countdown on the button', async () => {
    let n = 0;
    const { gw } = gateway(ledgerBody(), {
      [CLAIM]: () => (++n === 1 ? json(401, { error: 'invalid_credentials' }) : json(429, { error: 'too_many_attempts' }, { 'Retry-After': '90' })),
    });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    send();
    expect(await screen.findByText('PIN is incorrect.')).toBeInTheDocument();
    expect((screen.getByLabelText('Your PIN') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    send();
    expect(await screen.findByRole('button', { name: /try again in 1:30/i })).toBeDisabled();
    expect(gw.count(REFRESH)).toBe(0); // a wrong PIN never refreshes and retries
  });

  it('503 temporarily_unavailable: "Not sent, nothing deducted"; 502 payout_failed: balance back', async () => {
    let n = 0;
    const { gw } = gateway(ledgerBody(), {
      [CLAIM]: () => (++n === 1 ? json(503, { error: 'temporarily_unavailable' }) : json(502, { error: 'payout_failed', payout: payoutView({ status: 'FAILED' }) })),
    });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    send();
    expect(await screen.findByText(/Not sent, nothing deducted/)).toBeInTheDocument();
    await claimFlow();
    send();
    expect(await screen.findByText(/did not accept the payout/)).toBeInTheDocument();
  });

  it('409 balance_under_review: nothing sent, claim again for the rest', async () => {
    const { gw } = gateway(ledgerBody(), { [CLAIM]: () => json(409, { error: 'balance_under_review', payout: payoutView({ status: 'FAILED' }) }) });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    send();
    expect(await screen.findByText(/Part of your balance is under review/)).toBeInTheDocument();
  });

  it('double tap: two taps in the same moment send exactly one POST', async () => {
    let release: (r: Response) => void = () => undefined;
    const { gw } = gateway(ledgerBody(), { [CLAIM]: () => new Promise<Response>((r) => (release = r)) as unknown as Response });
    renderApp(<AgentDashboard />, gw.fetch);
    await claimFlow();
    const form = screen.getByRole('button', { name: /^Send KES/ }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await act(async () => {});
    expect(gw.count(CLAIM)).toBe(1);
    await act(async () => release(json(202, { payout: payoutView() })));
    expect(gw.count(CLAIM)).toBe(1);
  });

  it('offline: last data with a stale banner, claim disabled; refetches on online', async () => {
    const { gw, state } = gateway(ledgerBody());
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByRole('button', { name: /^Claim KES/ })).toBeEnabled();
    state.ledger = () => {
      throw new TypeError('Failed to fetch');
    };
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText(/Showing your last update/)).toBeInTheDocument();
    expect(screen.getAllByText('KES 1,235.23').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Claim KES/ })).toBeDisabled();
    state.ledger = () => json(200, ledgerBody());
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(screen.queryByText(/Showing your last update/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Claim KES/ })).toBeEnabled();
  });

  it('polls every 15 s while visible and pauses while hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { gw } = gateway(ledgerBody());
    renderApp(<AgentDashboard />, gw.fetch);
    await screen.findByRole('button', { name: /^Claim KES/ });
    const base = gw.count(GET);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(gw.count(GET)).toBe(base + 1));
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    expect(gw.count(GET)).toBe(base + 1);
    hidden.mockReturnValue('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(gw.count(GET)).toBe(base + 2));
    hidden.mockRestore();
  });

  it('a failed poll (429, 503) keeps the last balance with the stale banner', async () => {
    const { gw, state } = gateway(ledgerBody());
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByRole('button', { name: /^Claim KES/ })).toBeEnabled();
    state.ledger = () => json(429, { error: 'rate_limited' }, { 'Retry-After': '30' });
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText(/Showing your last update/)).toBeInTheDocument();
    expect(screen.getAllByText('KES 1,235.23').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Claim KES/ })).toBeDisabled();
    state.ledger = () => json(503, { error: 'temporarily_unavailable' });
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(gw.count(GET)).toBe(3));
    expect(screen.getByText(/Showing your last update/)).toBeInTheDocument();
  });

  it('no data and GET 503 temporarily_unavailable: the unreachable copy, not the claim "not sent" copy', async () => {
    const g = gateway(null);
    g.state.ledger = () => json(503, { error: 'temporarily_unavailable' });
    renderApp(<AgentDashboard />, g.gw.fetch);
    expect(await screen.findByText(/Can.t reach SalesMesh/)).toBeInTheDocument();
    expect(screen.queryByText(/Not sent, nothing deducted/)).not.toBeInTheDocument();
  });

  it('carry-only or below-minimum balance: the disabled claim button and the minimum, not a hidden claim area', async () => {
    const { gw } = gateway(ledgerBody({ balance: { amount: 9, cents: 999, payable_now: 9 } }));
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByRole('button', { name: 'Claim KES 9.00' })).toBeDisabled();
    expect(screen.getByText(/Payouts start at KES 10.00/)).toBeInTheDocument();
  });

  it('carry after a claim (cents > 0, payable 0): the claim area still explains the minimum', async () => {
    const { gw } = gateway(ledgerBody({ balance: { amount: 0, cents: 23, payable_now: 0 } }));
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByRole('button', { name: 'Claim KES 0.00' })).toBeDisabled();
    expect(screen.getByText(/Payouts start at KES 10.00/)).toBeInTheDocument();
  });

  it('more held than listed: "and N more held"', async () => {
    const { gw } = gateway(ledgerBody({ accruals: [accrualView()], pending_count: 3, pending_cents: 105_000 }));
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByText(/and 2 more held/)).toBeInTheDocument();
  });

  it('payouts_disabled 503: paused message with retry', async () => {
    const g = gateway(null);
    g.state.ledger = () => json(503, { error: 'payouts_disabled' });
    renderApp(<AgentDashboard />, g.gw.fetch);
    expect(await screen.findByText('Payouts are paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('malformed body: error with retry, never a crash', async () => {
    const { gw } = gateway({ balance: 'lots' });
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByText("Your ledger didn't load")).toBeInTheDocument();
  });

  it('session expires mid-poll: refresh fails → sign-in redirect, no balance left on screen', async () => {
    nav.pathname = '/agent';
    let refreshes = 0;
    const state: { ledger: () => Response } = { ledger: () => json(200, ledgerBody()) };
    const gw = fakeFetch({
      [REFRESH]: () => (++refreshes === 1 ? json(200, sessionBody()) : json(401, { error: 'invalid_refresh_token' })),
      [GET]: () => state.ledger(),
    });
    renderApp(
      <DashboardShell>
        <AgentPage />
      </DashboardShell>,
      gw.fetch
    );
    expect(await screen.findByRole('button', { name: /^Claim KES/ })).toBeInTheDocument();
    state.ledger = () => json(401, { error: 'unauthorized' });
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?next=%2Fagent'));
    expect(screen.queryByText('KES 1,235.23')).not.toBeInTheDocument();
  });
});

describe('payout line card', () => {
  const noLine = ledgerBody({ destination: null });

  it('no line: PIN → 202 PENDING_VERIFICATION', async () => {
    let lines: unknown[] = [];
    const { gw } = gateway(noLine, {
      [LINES]: (i) => {
        if (i.method !== 'POST') return json(200, { destinations: lines, events: [] });
        lines = [lineView()];
        return json(202, { destination: lineView() });
      },
    });
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByRole('button', { name: /^Claim KES/ })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify my M-Pesa line' }));
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify my line' }));
    expect(await screen.findByText(/Verification sent to/)).toBeInTheDocument();
    expect(bodyOf(gw.calls.find((c) => c.url === LINES && c.init.method === 'POST')!.init)).toEqual({ pin: '4826' });
  });

  it.each([
    [409, 'already_active', /already verified/],
    [409, 'destination_pending', /already in progress/],
    [409, 'phone_not_payable', /can.t receive M-Pesa payouts/],
    [502, 'verification_failed', /refused the verification payment/],
  ])('refusal %i %s is explained', async (status, code, text) => {
    const { gw } = gateway(noLine, {
      [LINES]: (i) => (i.method === 'POST' ? json(status, { error: code }) : json(200, { destinations: [], events: [] })),
    });
    renderApp(<AgentDashboard />, gw.fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify my M-Pesa line' }));
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify my line' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('lines reload with each ledger refresh: a pending check that expires stops saying "Verification sent"', async () => {
    let lines = [lineView()];
    const { gw } = gateway(noLine, { [LINES]: () => json(200, { destinations: lines, events: [] }) });
    renderApp(<AgentDashboard />, gw.fetch);
    expect(await screen.findByText(/Verification sent to/)).toBeInTheDocument();
    lines = [lineView({ status: 'EXPIRED' })];
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText(/last check didn.t go through/)).toBeInTheDocument();
    expect(screen.queryByText(/Verification sent to/)).not.toBeInTheDocument();
  });

  it('COOLING_OFF shows when the new line takes over', async () => {
    const { gw } = gateway(ledgerBody({ destination_changing: true }), {
      [LINES]: () => json(200, { destinations: [lineView({ status: 'COOLING_OFF', cooling_off_until: '2026-10-16T09:00:00.000Z' })], events: [] }),
    });
    renderApp(<AgentDashboard />, gw.fetch);
    const until = await screen.findByText((_, el) => el?.tagName === 'TIME' && el.getAttribute('datetime') === '2026-10-16T09:00:00.000Z');
    expect(until).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Claim KES/ })).toBeDisabled();
  });
});

describe('payout history', () => {
  it('PAID carries the Cleared seal and the M-Pesa receipt code; FAILED says nothing was deducted', async () => {
    const { gw } = gateway(
      ledgerBody({
        payouts: [
          payoutView({ payout_id: 'p-2', status: 'PAID', receipt: 'TJK1ABC2DE', resolved_at: '2026-10-14T08:01:00.000Z' }),
          payoutView({ payout_id: 'p-1', status: 'FAILED', failure_reason: 'b2c_2001', resolved_at: '2026-10-13T08:01:00.000Z' }),
        ],
      })
    );
    renderApp(<PayoutsView />, gw.fetch);
    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]!).getByRole('img', { name: /Cleared/ })).toBeInTheDocument();
    expect(within(items[0]!).getByText('TJK1ABC2DE')).toBeInTheDocument();
    expect(within(items[1]!).queryByRole('img', { name: /Cleared/ })).not.toBeInTheDocument();
    expect(within(items[1]!).getByText(/Nothing was deducted/)).toBeInTheDocument();
  });

  it('no payouts: the empty receipt', async () => {
    const { gw } = gateway(ledgerBody());
    renderApp(<PayoutsView />, gw.fetch);
    expect(await screen.findByText('Your payouts will show here')).toBeInTheDocument();
  });
});
