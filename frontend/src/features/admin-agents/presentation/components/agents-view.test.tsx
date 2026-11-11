// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
// render-app first: its next/navigation mock must be registered before the pages load.
import { nav, renderApp } from '@/test/render-app';
import { agentView, fakeFetch, json, sessionBody } from '@/test/fake-gateway';
import { AgentsView } from './agents-view';

const REFRESH = '/api/v1/auth/refresh';
const GET = '/api/v1/admin/agents';
const gateway = (reply: () => Response) => fakeFetch({ [REFRESH]: () => json(200, sessionBody({ role: 'MERCHANT_ADMIN' })), [GET]: reply });

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
});

describe('agents directory', () => {
  it('lists agents: code, masked numbers, activation, disabled, payout summary', async () => {
    const gw = gateway(() =>
      json(200, {
        agents: [
          agentView(),
          agentView({ agent_code: 'AG043', full_name: 'Otieno Odhiambo', msisdn: '2547******11', activated: false, disabled: true, payout: null }),
        ],
      })
    );
    renderApp(<AgentsView />, gw.fetch);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const a = within(rows[0]!);
    expect(a.getByText('AG042')).toBeInTheDocument();
    expect(a.getByText('Activated')).toBeInTheDocument();
    expect(a.getByText(/Payout 2547\*{6}78 \(Active\)/)).toBeInTheDocument();
    const b = within(rows[1]!);
    expect(b.getByText('Not activated')).toBeInTheDocument();
    expect(b.getByText('Disabled')).toBeInTheDocument();
    expect(b.getByText(/No payout number yet/)).toBeInTheDocument();
  });

  it('no agents: the empty state', async () => {
    renderApp(<AgentsView />, gateway(() => json(200, { agents: [] })).fetch);
    expect(await screen.findByText('Your agents will be listed here')).toBeInTheDocument();
  });

  it('error: message, and Try again re-fetches', async () => {
    let fail = true;
    const gw = gateway(() => (fail ? json(503, { error: 'temporarily_unavailable' }) : json(200, { agents: [agentView()] })));
    renderApp(<AgentsView />, gw.fetch);
    expect(await screen.findByText("The agents didn't load")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('AG042')).toBeInTheDocument();
  });

  it('shows a loading status first', async () => {
    renderApp(<AgentsView />, gateway(() => json(200, { agents: [] })).fetch);
    expect(screen.getByRole('status', { name: 'Loading agents' })).toBeInTheDocument();
    await screen.findByText('Your agents will be listed here');
  });
});
