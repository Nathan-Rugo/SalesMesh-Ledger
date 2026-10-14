// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeFetch, json, sessionBody } from '@/test/fake-gateway';
import { nav, renderApp } from '@/test/render-app';
import { AccountPanel } from './account-panel';
import { RoleGuard } from './role-guard';

const ID = '7c1e2d4a-9b3f-4e21-8a6d-0f5c3b9e1a77';

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
});

describe('AccountPanel', () => {
  it.each([
    ['SALES_AGENT', '/agent/account', 'Sales agent'],
    ['MERCHANT_ADMIN', '/admin/account', 'Merchant admin'],
  ] as const)('%s: role label, account id masked to its last 4', async (role, path, label) => {
    nav.pathname = path;
    const body = { ...sessionBody({ role }), user: { user_id: ID, role } };
    const gw = fakeFetch({ '/api/v1/auth/refresh': () => json(200, body) });
    renderApp(
      <RoleGuard role={role} fallback={null}>
        <AccountPanel />
      </RoleGuard>,
      gw.fetch
    );
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText('••••1a77')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ID);
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Sign out']);
  });
});
