// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminNav } from '@/features/admin-oversight/presentation/admin-nav';
import { agentNav } from '@/features/agent-ledger/presentation/agent-nav';
import { fakeFetch, json, sessionBody } from '@/test/fake-gateway';
import { nav, renderApp } from '@/test/render-app';
import AdminAccountPage from './admin/account/page';
import AdminAgentsPage from './admin/agents/page';
import AdminPage from './admin/page';
import AdminQueuePage from './admin/queue/page';
import AgentAccountPage from './agent/account/page';
import AgentPage from './agent/page';
import AgentCollectPage from './agent/collect/page';
import AgentPayoutsPage from './agent/payouts/page';
import { DashboardShell } from './dashboard-shell';

const PAGES: Record<string, { Page: ComponentType; heading: string }> = {
  '/agent': { Page: AgentPage, heading: 'Your ledger' },
  '/agent/collect': { Page: AgentCollectPage, heading: 'Request payment' },
  '/agent/payouts': { Page: AgentPayoutsPage, heading: 'Payouts' },
  '/agent/account': { Page: AgentAccountPage, heading: 'Account' },
  '/admin': { Page: AdminPage, heading: 'Oversight' },
  '/admin/queue': { Page: AdminQueuePage, heading: 'Risk queue' },
  '/admin/agents': { Page: AdminAgentsPage, heading: 'Agents' },
  '/admin/account': { Page: AdminAccountPage, heading: 'Account' },
};

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
});

const cases = [
  ...agentNav.map((item) => ({ role: 'SALES_AGENT', item })),
  ...adminNav.map((item) => ({ role: 'MERCHANT_ADMIN', item })),
];

describe('every nav item renders its page under its role guard', () => {
  it('maps every nav href to a page, and the mobile tab bar fits (items + Sign out <= 5)', () => {
    expect(Object.keys(PAGES).sort()).toEqual(cases.map((c) => c.item.href).sort());
    expect(agentNav.length + 1).toBeLessThanOrEqual(5);
    expect(adminNav.length + 1).toBeLessThanOrEqual(5);
  });

  it.each(cases)('$role $item.href', async ({ role, item }) => {
    nav.pathname = item.href;
    const { Page, heading } = PAGES[item.href]!;
    const gw = fakeFetch({ '/api/v1/auth/refresh': () => json(200, sessionBody({ role })) });
    renderApp(
      <DashboardShell>
        <Page />
      </DashboardShell>,
      gw.fetch
    );
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    // Exactly this item is current in each nav (rail + tab bar); the role home isn't lit on sub-pages.
    for (const n of screen.getAllByRole('navigation', { name: 'Main' })) {
      const current = within(n)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current.map((a) => a.getAttribute('href'))).toEqual([item.href]);
    }
  });
});
