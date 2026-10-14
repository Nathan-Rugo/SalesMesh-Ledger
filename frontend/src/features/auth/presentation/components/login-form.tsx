'use client';

import { useRef, useState, type FormEvent } from 'react';
import { errorMessage, pinReasonMessage } from '@/core/domain/app-error';
import { Button } from '@/shared/presentation/ui/button';
import { Field } from '@/shared/presentation/ui/field';
import { PhoneInput } from '@/shared/presentation/ui/phone-input';
import { PinInput } from '@/shared/presentation/ui/pin-input';
import { useSession } from '../state/session-provider';
import { FormAlert, UnreachableBanner, formatCountdown, useRetryCountdown } from './form-feedback';

/** Phone + PIN sign-in. Navigation after success is owned by the page (it follows the session). */
export function LoginForm() {
  const { login } = useSession();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const { waitS, startCountdown } = useRetryCountdown();
  const throttled = waitS > 0;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || throttled) return;
    setPhoneError(null);
    setPinError(null);
    setFormError(null);
    setBusy(true);
    const r = await login({ phone, pin });
    setBusy(false);
    setUnreachable(false);
    if (r.ok) return;
    const error = r.error;
    switch (error.kind) {
      case 'invalid_phone':
        setPhoneError(errorMessage(error));
        phoneRef.current?.focus();
        break;
      case 'invalid_pin':
        setPinError(pinReasonMessage(error.reason));
        pinRef.current?.focus();
        break;
      case 'invalid_credentials':
        // Same message whichever of the two was wrong: no account enumeration.
        setPinError('Phone or PIN is incorrect.');
        setPin('');
        pinRef.current?.focus();
        break;
      case 'throttled':
        // Retry-After: 0 (or missing) gives nothing to count down: show the generic message.
        if (error.retryAfterS) startCountdown(error.retryAfterS);
        else setFormError(errorMessage({ kind: 'throttled', retryAfterS: null }));
        break;
      case 'unavailable':
        setUnreachable(true);
        break;
      default:
        setFormError(errorMessage(error));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {unreachable ? <UnreachableBanner onRetry={() => void submit()} busy={busy} /> : null}
      {throttled ? <FormAlert>Too many attempts. You can try again when the timer ends.</FormAlert> : null}
      {formError ? <FormAlert>{formError}</FormAlert> : null}

      <Field id="phone" label="Phone number" error={phoneError} hint="The number your merchant registered you with.">
        {(aria) => <PhoneInput ref={phoneRef} {...aria} name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} required />}
      </Field>

      <Field id="pin" label="PIN" error={pinError}>
        {(aria) => <PinInput ref={pinRef} {...aria} name="pin" value={pin} onValueChange={setPin} autoComplete="current-password" required />}
      </Field>

      <Button type="submit" block loading={busy} disabled={throttled}>
        {throttled ? (
          <span>
            Try again in <span className="font-mono tabular-nums">{formatCountdown(waitS)}</span>
          </span>
        ) : (
          'Sign in'
        )}
      </Button>
    </form>
  );
}
