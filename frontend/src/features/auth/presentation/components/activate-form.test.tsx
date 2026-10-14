// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { bodyOf, fakeFetch, json, sessionBody, token } from '@/test/fake-gateway';
import { nav, renderApp } from '@/test/render-app';
import { ActivateForm } from './activate-form';

const LOGIN = '/api/v1/auth/login';
const REFRESH = '/api/v1/auth/refresh';
const PIN = '/api/v1/auth/pin';

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
});

describe('ActivateForm (matrix)', () => {
  it('activation: phone + one-time PIN, then new PIN + confirm only (no current PIN step)', async () => {
    const gw = fakeFetch({
      [LOGIN]: () => json(200, sessionBody({ pinChangeRequired: true, tok: token('otp') })),
      [PIN]: () => json(200, sessionBody({ tok: token('own') })),
    });
    renderApp(<ActivateForm />, gw.fetch);
    type('Phone number', '0712 345 678');
    type('One-time PIN', '583920');
    click('Continue');

    await screen.findByLabelText('New PIN');
    expect(screen.queryByLabelText('Current PIN')).not.toBeInTheDocument();
    type('New PIN', '4829');
    type('Confirm new PIN', '4829');
    click('Set PIN');

    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/agent'));
    const pinCall = gw.calls.find((c) => c.url === PIN)!;
    expect(bodyOf(pinCall.init)).toEqual({ current_pin: '583920', new_pin: '4829' });
    expect((pinCall.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token('otp')}`);
  });

  it('wrong or expired one-time PIN: merchant message, not retried', async () => {
    const gw = fakeFetch({ [LOGIN]: () => json(401, { error: 'invalid_credentials' }) });
    renderApp(<ActivateForm />, gw.fetch);
    type('Phone number', '0712345678');
    type('One-time PIN', '583920');
    click('Continue');
    expect(await screen.findByText('PIN incorrect or expired — ask your merchant for a new one.')).toBeInTheDocument();
    expect(gw.count(LOGIN)).toBe(1);
  });

  it('signed in (voluntary change): asks current PIN + new + confirm, and maps gateway invalid_pin to its field', async () => {
    window.localStorage.setItem('salesmesh.session-hint', '1');
    const gw = fakeFetch({
      [REFRESH]: () => json(200, sessionBody()),
      [PIN]: () => json(400, { error: 'invalid_pin', reason: 'current_pin_missing', field: 'current_pin' }),
    });
    renderApp(<ActivateForm />, gw.fetch);
    await screen.findByLabelText('Current PIN');
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
    type('Current PIN', '583920');
    type('New PIN', '4829');
    type('Confirm new PIN', '4829');
    click('Set PIN');
    expect(await screen.findByText('Enter your current PIN.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current PIN')).toHaveAttribute('aria-invalid', 'true');
  });

  it('forced change after /login: the current-PIN field is labelled as the merchant one-time PIN', async () => {
    window.localStorage.setItem('salesmesh.session-hint', '1');
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody({ pinChangeRequired: true })) });
    renderApp(<ActivateForm />, gw.fetch);
    expect(await screen.findByLabelText('One-time PIN')).toBeInTheDocument();
    expect(screen.getByText('The 6-digit PIN your merchant gave you.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Current PIN')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
  });

  it('client policy mirrors the gateway: weak PIN refused before any request', async () => {
    window.localStorage.setItem('salesmesh.session-hint', '1');
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody({ pinChangeRequired: true })) });
    renderApp(<ActivateForm />, gw.fetch);
    await screen.findByLabelText('One-time PIN');
    type('One-time PIN', '583920');
    type('New PIN', '1234');
    type('Confirm new PIN', '1234');
    click('Set PIN');
    expect(await screen.findByText("Don't use a run, like 1234 or 9876.")).toBeInTheDocument();
    expect(gw.count(PIN)).toBe(0);
  });

  it.each([
    [() => json(429, { error: 'too_many_attempts' }, { 'Retry-After': '90' }), /try again in 1:[23]\d/i],
    [() => json(503, { error: 'temporarily_unavailable' }), 'Can’t reach SalesMesh'],
  ] as const)('/pin throttled or down is handled as on login (%#)', async (reply, expected) => {
    window.localStorage.setItem('salesmesh.session-hint', '1');
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody({ pinChangeRequired: true })), [PIN]: reply });
    renderApp(<ActivateForm />, gw.fetch);
    await screen.findByLabelText('One-time PIN');
    type('One-time PIN', '583920');
    type('New PIN', '4829');
    type('Confirm new PIN', '4829');
    click('Set PIN');
    if (typeof expected === 'string') expect(await screen.findByText(expected)).toBeInTheDocument();
    else expect(await screen.findByRole('button', { name: expected })).toBeDisabled();
    expect(gw.count(PIN)).toBe(1);
    expect((screen.getByLabelText('New PIN') as HTMLInputElement).value).toBe('4829');
  });

  it('PIN change broadcasts sign-out to other tabs', async () => {
    window.localStorage.setItem('salesmesh.session-hint', '1');
    const gw = fakeFetch({ [REFRESH]: () => json(200, sessionBody()), [PIN]: () => json(200, sessionBody()) });
    const other = new BroadcastChannel('salesmesh-auth');
    const received = new Promise((resolve) => (other.onmessage = (e) => resolve(e.data)));
    renderApp(<ActivateForm />, gw.fetch);
    await screen.findByLabelText('Current PIN');
    type('Current PIN', '583920');
    type('New PIN', '4829');
    type('Confirm new PIN', '4829');
    click('Set PIN');
    expect(await received).toEqual({ type: 'signed_out' });
    other.close();
  });
});
