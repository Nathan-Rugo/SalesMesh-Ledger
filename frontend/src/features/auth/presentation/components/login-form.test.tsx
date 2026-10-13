// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, fakeFetch, json, sessionBody } from '@/test/fake-gateway';
import { nav, renderApp } from '@/test/render-app';
import { SessionRedirect } from './session-redirect';
import { LoginForm } from './login-form';

const LOGIN = '/api/v1/auth/login';

function fill(phone: string, pin: string) {
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText('PIN'), { target: { value: pin } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: /sign in|try again/i }));

const page = (
  <>
    <SessionRedirect />
    <LoginForm />
  </>
);

beforeEach(() => {
  window.localStorage.clear();
  nav.replace.mockReset();
  window.history.replaceState(null, '', '/login');
});
afterEach(() => vi.useRealTimers());

describe('LoginForm (matrix)', () => {
  it('login ok: posts the normalised phone and routes by role', async () => {
    const gw = fakeFetch({ [LOGIN]: () => json(200, sessionBody({ role: 'MERCHANT_ADMIN' })) });
    renderApp(page, gw.fetch);
    fill('0712 345 678', '4829');
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/admin'));
    expect(bodyOf(gw.calls[0]!.init)).toEqual({ phone: '254712345678', pin: '4829' });
  });

  it('ignores an unsafe next=', async () => {
    window.history.replaceState(null, '', '/login?next=%2F%2Fevil.example');
    const gw = fakeFetch({ [LOGIN]: () => json(200, sessionBody()) });
    renderApp(page, gw.fetch);
    fill('0712345678', '4829');
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/agent'));
  });

  it('forced PIN change: routes to /register only', async () => {
    const gw = fakeFetch({ [LOGIN]: () => json(200, sessionBody({ pinChangeRequired: true })) });
    renderApp(page, gw.fetch);
    fill('0712345678', '4829');
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/register'));
  });

  it('bad credentials: inline message, PIN cleared, PIN focused', async () => {
    const gw = fakeFetch({ [LOGIN]: () => json(401, { error: 'invalid_credentials' }) });
    renderApp(<LoginForm />, gw.fetch);
    fill('0712345678', '4829');
    submit();
    expect(await screen.findByText('Phone or PIN is incorrect.')).toBeInTheDocument();
    const pin = screen.getByLabelText('PIN') as HTMLInputElement;
    expect(pin.value).toBe('');
    expect(document.activeElement).toBe(pin);
    expect(gw.calls).toHaveLength(1);
  });

  it('client validation blocks a non-Kenyan number without a request', async () => {
    const gw = fakeFetch({});
    renderApp(<LoginForm />, gw.fetch);
    fill('0812 345 678', '4829');
    submit();
    expect(await screen.findByText(/Safaricom or Airtel/)).toBeInTheDocument();
    expect(gw.calls).toHaveLength(0);
  });

  it('throttled with Retry-After: live countdown, submit disabled until 0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const gw = fakeFetch({ [LOGIN]: () => json(429, { error: 'too_many_attempts' }, { 'Retry-After': '90' }) });
    renderApp(<LoginForm />, gw.fetch);
    fill('0712345678', '4829');
    submit();
    const button = await screen.findByRole('button', { name: /try again in 1:30/i });
    expect(button).toBeDisabled();
    await act(async () => {}); // flush the countdown effect before moving the clock
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole('button', { name: /try again in 1:00/i })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it.each([[{}], [{ 'Retry-After': '0' }]])('throttled with Retry-After %j: generic retry text, submit stays enabled', async (headers) => {
    const gw = fakeFetch({ [LOGIN]: () => json(429, { error: 'too_many_attempts' }, headers) });
    renderApp(<LoginForm />, gw.fetch);
    fill('0712345678', '4829');
    submit();
    expect(await screen.findByText(/Wait a few minutes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('gateway down (network, then 503): banner with retry, form state kept', async () => {
    let attempt = 0;
    const gw = fakeFetch({
      [LOGIN]: () => {
        attempt++;
        if (attempt === 1) throw new TypeError('Failed to fetch');
        if (attempt === 2) return json(503, { error: 'temporarily_unavailable' });
        return json(200, sessionBody());
      },
    });
    renderApp(<LoginForm />, gw.fetch);
    fill('0712345678', '4829');
    submit();
    expect(await screen.findByText('Can’t reach SalesMesh')).toBeInTheDocument();
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('0712345678');
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('4829');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempt).toBe(2));
    expect(await screen.findByText('Can’t reach SalesMesh')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Can’t reach SalesMesh')).not.toBeInTheDocument());
  });
});
