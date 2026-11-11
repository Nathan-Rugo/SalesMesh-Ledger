// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { bodyOf, fakeFetch, json, sessionBody, token } from '@/test/fake-gateway';
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
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Change', 'Sign out']);
  });

  describe('change PIN', () => {
    const PIN = '/api/v1/auth/pin';
    const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Change PIN' }));

    async function open(pin: (() => Response) | null) {
      nav.pathname = '/agent/account';
      const gw = fakeFetch({ '/api/v1/auth/refresh': () => json(200, sessionBody()), ...(pin ? { [PIN]: pin } : {}) });
      renderApp(
        <RoleGuard role="SALES_AGENT" fallback={null}>
          <AccountPanel />
        </RoleGuard>,
        gw.fetch
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
      return gw;
    }
    const fill = (cur = '583920', next = '4829', conf = next) => {
      type('Current PIN', cur);
      type('New PIN', next);
      type('Confirm new PIN', conf);
      submit();
    };

    it.each([
      ['empty current PIN', ['', '4829'], 'Enter your current PIN.', 'Current PIN'],
      ['bad format', ['583920', '12'], 'Use 4 to 6 digits.', 'New PIN'],
      ['repeated digits', ['583920', '1111'], "Don't repeat one digit, like 1111.", 'New PIN'],
      ['run', ['583920', '1234'], "Don't use a run, like 1234 or 9876.", 'New PIN'],
      ['common PIN', ['583920', '1212'], 'That PIN is too common. Pick another.', 'New PIN'],
      ['unchanged', ['4829', '4829'], 'Your new PIN must be different from the current one.', 'New PIN'],
      ['mismatch', ['583920', '4829', '4828'], "The PINs don't match.", 'Confirm new PIN'],
    ] as const)('client validation (%s) never reaches the gateway', async (_n, args, message, field) => {
      const gw = await open(null);
      fill(...([...args] as [string, string, string?]));
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText(field)).toHaveAttribute('aria-invalid', 'true');
      expect(gw.count(PIN)).toBe(0);
    });

    it('success sends the body, adopts the new session, closes the form and announces it', async () => {
      const gw = await open(() => json(200, sessionBody({ tok: token('fresh') })));
      fill();
      expect(await screen.findByText('PIN changed. Other devices were signed out.')).toBeInTheDocument();
      expect(bodyOf(gw.calls.find((c) => c.url === PIN)!.init)).toEqual({ current_pin: '583920', new_pin: '4829' });
      expect(screen.queryByLabelText('New PIN')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    });

    it('wrong current PIN: field error, current field cleared, no retry', async () => {
      const gw = await open(() => json(401, { error: 'invalid_credentials' }));
      fill();
      expect(await screen.findByText('Current PIN is incorrect.')).toBeInTheDocument();
      expect(screen.getByLabelText('Current PIN')).toHaveValue('');
      expect(gw.count(PIN)).toBe(1);
    });

    it('gateway invalid_pin maps to its field', async () => {
      await open(() => json(400, { error: 'invalid_pin', reason: 'pin_common', field: 'new_pin' }));
      fill();
      expect(await screen.findByText('That PIN is too common. Pick another.')).toBeInTheDocument();
      expect(screen.getByLabelText('New PIN')).toHaveAttribute('aria-invalid', 'true');
    });

    it('rate limit with Retry-After: countdown, submit disabled', async () => {
      await open(() => json(429, { error: 'too_many_attempts' }, { 'Retry-After': '90' }));
      fill();
      expect(await screen.findByText('Too many attempts. You can try again when the timer ends.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Try again in/ })).toBeDisabled();
    });

    it('rate limit without Retry-After: generic message', async () => {
      await open(() => json(429, { error: 'too_many_attempts' }));
      fill();
      expect(await screen.findByText('Too many attempts. Wait a few minutes, then try again.')).toBeInTheDocument();
    });

    it('gateway down: unreachable banner keeps what was typed', async () => {
      await open(() => json(503, { error: 'temporarily_unavailable' }));
      fill();
      expect(await screen.findByText('Can’t reach SalesMesh')).toBeInTheDocument();
      expect(screen.getByLabelText('New PIN')).toHaveValue('4829');
    });

    it('cancel closes the form without a request', async () => {
      const gw = await open(null);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('New PIN')).not.toBeInTheDocument();
      expect(gw.count(PIN)).toBe(0);
    });
  });
});
