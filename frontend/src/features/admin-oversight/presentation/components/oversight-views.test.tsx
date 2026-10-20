// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
// render-app first: its next/navigation mock must be registered before the pages load.
import { nav, renderApp } from '@/test/render-app';
import { bodyOf, fakeFetch, frozenEscrowView, json, queueBody, sessionBody, unresolvedPayoutView } from '@/test/fake-gateway';
import { OversightSummary, RiskQueueView } from './oversight-views';

const REFRESH = '/api/v1/auth/refresh';
const GET = '/api/v1/admin/frozen-payouts';
const RELEASE = '/api/v1/admin/escrows/e-1/release';
const KEEP = '/api/v1/admin/escrows/e-1/keep';
const RESOLVE = '/api/v1/admin/payouts/p-9/resolve';
const NOTE = 'Checked the till slip with the outlet manager.';

type Reply = (init: RequestInit) => Response;
/** A fake gateway whose queue answer can change between calls. */
function gateway(first: unknown, extra: Record<string, Reply> = {}) {
  const state: { queue: () => Response } = { queue: () => json(200, first) };
  const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody({ role: 'MERCHANT_ADMIN' })), [GET]: () => state.queue(), ...extra });
  return { gw, state };
}

const card = async (name = 'Wanjiru Kamau') => within((await screen.findAllByText(name))[0]!.closest('li')!);
/** Opens an action, writes the note and the PIN, and submits. */
async function decide(action: RegExp, note = NOTE, pin = '4826') {
  fireEvent.click(await screen.findByRole('button', { name: action }));
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: note } });
  fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: pin } });
}
const confirm = () => fireEvent.click(screen.getByRole('button', { name: /^Confirm:/ }));

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
});

describe('risk queue (I/O matrix)', () => {
  it('empty queue: the existing empty states, nothing to decide', async () => {
    const { gw } = gateway(queueBody());
    renderApp(<RiskQueueView />, gw.fetch);
    expect(await screen.findByText('Held payouts will queue here')).toBeInTheDocument();
    renderApp(<OversightSummary />, gw.fetch);
    expect(await screen.findByText('No payouts need review')).toBeInTheDocument();
  });

  it('model-quarantined escrow: agent, amount, reason, frozen age, overdue pill, and the waterfall in plain language', async () => {
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView()] }));
    renderApp(<RiskQueueView />, gw.fetch);
    const row = await card();
    expect(row.getByText('AG042')).toBeInTheDocument();
    expect(row.getByText('KES 425.50')).toBeInTheDocument();
    expect(row.getByText('The risk model flagged it for review.')).toBeInTheDocument();
    expect(row.getByText('3 d 8 h ago')).toBeInTheDocument();
    expect(row.getByText('Overdue')).toBeInTheDocument();
    expect(row.getByText('Quarantined')).toBeInTheDocument();
    const fig = within(row.getByRole('figure'));
    expect(fig.getByText('Sales pace (payments per hour)')).toBeInTheDocument();
    expect(fig.getByText('+1.40')).toBeInTheDocument();
    expect(fig.getByText('−0.30')).toBeInTheDocument();
    expect(fig.getByText(', pushed the score down')).toBeInTheDocument();
    expect(fig.getByText(/not proof of fraud/)).toBeInTheDocument();
    expect(fig.getByText(/log-odds/)).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Release' })).toBeEnabled();
    expect(row.getByRole('button', { name: 'Keep held' })).toBeEnabled();
  });

  it('no SHAP stored (pre-010 or fail-safe): "No model explanation recorded" with the reason', async () => {
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView({ quarantine_reason: 'fail_safe', risk: null })] }));
    renderApp(<RiskQueueView />, gw.fetch);
    const row = await card();
    expect(row.getByText('No model explanation recorded')).toBeInTheDocument();
    expect(row.getAllByText('The risk check was unavailable, so it was held to be safe.').length).toBeGreaterThan(0);
    expect(row.queryByRole('figure')).not.toBeInTheDocument();
  });

  it('security hold: "Needs investigation", no override buttons', async () => {
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView({ security_hold: true, quarantine_reason: 'security_hold', risk: { ...frozenEscrowView().risk, shap: null } })] }));
    renderApp(<RiskQueueView />, gw.fetch);
    const row = await card();
    expect(row.getByText('Needs investigation')).toBeInTheDocument();
    expect(row.queryByRole('button')).not.toBeInTheDocument();
  });

  it('release: note and PIN → one POST; the escrow leaves the queue on refetch', async () => {
    let posted: unknown = null;
    const { gw, state } = gateway(queueBody({ escrows: [frozenEscrowView()] }), {
      [RELEASE]: (init) => {
        posted = bodyOf(init);
        state.queue = () => json(200, queueBody());
        return json(200, { escrow: { escrow_id: 'e-1', status: 'HELD' } });
      },
    });
    renderApp(<RiskQueueView />, gw.fetch);
    await decide(/^Release$/);
    confirm();
    expect(await screen.findByText('Released. It is back on the normal claim path.')).toBeInTheDocument();
    expect(posted).toEqual({ pin: '4826', note: NOTE });
    expect(await screen.findByText('Held payouts will queue here')).toBeInTheDocument();
    expect(gw.count(RELEASE)).toBe(1);
  });

  it('focus follows the sheet: into the reason (or the receipt for Mark paid) on open, back to the first action on Cancel', async () => {
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView()], payouts: [unresolvedPayoutView({ agent_name: 'Otieno' })] }));
    renderApp(<RiskQueueView />, gw.fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep held' }));
    await waitFor(() => expect(screen.getByLabelText(/^Reason/)).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Release' })).toHaveFocus());
    fireEvent.click((await card('Otieno')).getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(screen.getByLabelText('M-Pesa receipt')).toHaveFocus());
  });

  it('an error shown in the sheet is cleared by Cancel', async () => {
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView()] }), { [RELEASE]: () => json(409, { error: 'conflict_of_some_kind' }) });
    renderApp(<RiskQueueView />, gw.fetch);
    await decide(/^Release$/);
    confirm();
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Something went wrong. Try again.')).not.toBeInTheDocument();
  });

  it('confirm stays disabled until the note has 10–280 characters', async () => {
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView()] }));
    renderApp(<RiskQueueView />, gw.fetch);
    await decide(/^Release$/, 'too short');
    expect(screen.getByRole('button', { name: /^Confirm:/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: NOTE } });
    expect(screen.getByRole('button', { name: /^Confirm:/ })).toBeEnabled();
    expect(gw.count(RELEASE)).toBe(0);
  });

  it('keep held: stays queued with "Reviewed by an admin", overdue cleared', async () => {
    const reviewedAt = new Date(Date.now() - 5 * 60_000 - 1_000).toISOString(); // before the mount-time clock
    const { gw, state } = gateway(queueBody({ escrows: [frozenEscrowView()] }), {
      [KEEP]: () => {
        state.queue = () => json(200, queueBody({ escrows: [frozenEscrowView({ overdue: false, reviewed_at: reviewedAt })] }));
        return json(200, { escrow: { escrow_id: 'e-1', status: 'QUARANTINED' } });
      },
    });
    renderApp(<RiskQueueView />, gw.fetch);
    await decide(/^Keep held$/);
    confirm();
    expect(await screen.findByText('Kept held and marked as reviewed.')).toBeInTheDocument();
    const row = await card();
    await waitFor(() => expect(row.getByText(/Reviewed by an admin/)).toHaveTextContent('Reviewed by an admin 5 min ago; kept held.'));
    expect(row.queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('changed meanwhile: 409 already_decided → toast, refetch, the row is gone', async () => {
    const { gw, state } = gateway(queueBody({ escrows: [frozenEscrowView()] }), {
      [RELEASE]: () => {
        state.queue = () => json(200, queueBody());
        return json(409, { error: 'already_decided' });
      },
    });
    renderApp(<RiskQueueView />, gw.fetch);
    await decide(/^Release$/);
    confirm();
    expect(await screen.findByText(/cleared on its own/)).toBeInTheDocument();
    expect(await screen.findByText('Held payouts will queue here')).toBeInTheDocument();
  });

  it('wrong PIN: field error; throttled: countdown on the button', async () => {
    let n = 0;
    const { gw } = gateway(queueBody({ escrows: [frozenEscrowView()] }), {
      [RELEASE]: () => (++n === 1 ? json(401, { error: 'invalid_credentials' }) : json(429, { error: 'too_many_attempts' }, { 'Retry-After': '90' })),
    });
    renderApp(<RiskQueueView />, gw.fetch);
    await decide(/^Release$/);
    const refreshes = gw.count(REFRESH);
    confirm();
    expect(await screen.findByText('PIN is incorrect.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    fireEvent.click(screen.getByRole('button', { name: /^Confirm:/ }));
    expect(await screen.findByRole('button', { name: /try again in 1:30/i })).toBeDisabled();
    expect(gw.count(REFRESH)).toBe(refreshes); // a wrong PIN never refreshes and retries
  });

  it('unresolved payout: masked number; resolve paid with the receipt; 409 not_unresolved refetches', async () => {
    let posted: unknown = null;
    let n = 0;
    const { gw, state } = gateway(queueBody({ payouts: [unresolvedPayoutView()] }), {
      [RESOLVE]: (init) => {
        posted = bodyOf(init);
        if (++n === 1) return json(200, { payout: { payout_id: 'p-9', status: 'PAID' } });
        state.queue = () => json(200, queueBody());
        return json(409, { error: 'not_unresolved', status: 'PAID' });
      },
    });
    renderApp(<RiskQueueView />, gw.fetch);
    const row = await card();
    expect(row.getByText('2547******78')).toBeInTheDocument();
    expect(row.getByText('KES 1,500.00')).toBeInTheDocument();
    fireEvent.click(row.getByRole('button', { name: 'Mark paid' }));
    fireEvent.change(screen.getByLabelText('M-Pesa receipt'), { target: { value: 'sgh12abc34' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: NOTE } });
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    confirm();
    expect(await screen.findByText('Marked paid. The agent was told by SMS.')).toBeInTheDocument();
    expect(posted).toEqual({ pin: '4826', note: NOTE, outcome: 'paid', receipt: 'SGH12ABC34' });

    fireEvent.click((await card()).getByRole('button', { name: 'Mark failed' }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: NOTE } });
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4826' } });
    confirm();
    expect(await screen.findByText(/already resolved/)).toBeInTheDocument();
    expect(posted).toEqual({ pin: '4826', note: NOTE, outcome: 'failed' });
    expect(await screen.findByText('Held payouts will queue here')).toBeInTheDocument();
  });

  it('over 200 items: "Showing 200 of N"', async () => {
    const escrows = Array.from({ length: 200 }, (_, i) => frozenEscrowView({ escrow_id: `e-${i}`, risk: null }));
    const { gw } = gateway(queueBody({ escrows, totals: { escrows: 260, payouts: 0 } }));
    renderApp(<RiskQueueView />, gw.fetch);
    expect(await screen.findByText(/Showing 200 of 260/)).toBeInTheDocument();
  });

  it('offline: the last queue with a stale banner, decisions disabled', async () => {
    const { gw, state } = gateway(queueBody({ escrows: [frozenEscrowView()] }));
    renderApp(<RiskQueueView />, gw.fetch);
    expect(await screen.findByRole('button', { name: 'Release' })).toBeEnabled();
    state.queue = () => {
      throw new TypeError('Failed to fetch');
    };
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText(/Showing the last update/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release' })).toBeDisabled();
  });

  it('malformed body: error with retry, never a crash', async () => {
    const { gw } = gateway({ nope: true });
    renderApp(<RiskQueueView />, gw.fetch);
    expect(await screen.findByText("The queue didn't load")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('/admin summary', () => {
  it('queue totals and overdue counts, linking to the queue', async () => {
    const { gw } = gateway(
      queueBody({
        escrows: [frozenEscrowView(), frozenEscrowView({ escrow_id: 'e-2', overdue: false })],
        payouts: [unresolvedPayoutView({ overdue: false })],
      })
    );
    renderApp(<OversightSummary />, gw.fetch);
    expect(await screen.findByText('Waiting for a decision')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Frozen commission').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Overdue (over 72 h)').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Overdue (over 24 h)').nextSibling).toHaveTextContent('0');
    expect(screen.getByRole('link', { name: 'Open the risk queue' })).toHaveAttribute('href', '/admin/queue');
  });
});
