'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { errorMessage, pinReasonMessage, type AppError } from '@/core/domain/app-error';
import { Button } from '@/shared/presentation/ui/button';
import { Field } from '@/shared/presentation/ui/field';
import { PhoneInput } from '@/shared/presentation/ui/phone-input';
import { PinInput } from '@/shared/presentation/ui/pin-input';
import { useToast } from '@/shared/presentation/ui/toast';
import { homePathFor } from '../../domain/entities/session';
import { useSession } from '../state/session-provider';
import { FormAlert, UnreachableBanner, formatCountdown, useRetryCountdown } from './form-feedback';

type FieldName = 'phone' | 'pin' | 'current_pin' | 'new_pin' | 'confirm_pin';

/**
 * Account activation. Signed out: phone + merchant-issued one-time PIN (a normal login), then set
 * your own PIN. Signed in (forced change or voluntary): current PIN + new PIN + confirm.
 */
export function ActivateForm() {
  const { status, session, login, changePin } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [oneTimePin, setOneTimePin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  /** One-time PIN already proven in the verify step, so the set step doesn't ask for it again. */
  const [verifiedPin, setVerifiedPin] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const { waitS, startCountdown } = useRetryCountdown();
  const throttled = waitS > 0;
  const step = status === 'authenticated' && session ? 'set' : 'verify';
  const askCurrent = step === 'set' && verifiedPin === null;
  /** Signed in with the merchant's one-time PIN (e.g. at /login): the "current" PIN is that one. */
  const forced = session?.pinChangeRequired === true;

  const fieldError = (name: FieldName, message: string) => {
    setErrors({ [name]: message });
    const ref = { phone: phoneRef, pin: pinRef, current_pin: currentRef, new_pin: newRef, confirm_pin: confirmRef }[name];
    ref.current?.focus();
  };

  /** Shared handling for throttling, outages and anything without a field. */
  const common = (e: AppError) => {
    if (e.kind === 'throttled') {
      // Retry-After: 0 (or missing) gives nothing to count down: show the generic message.
      if (e.retryAfterS) startCountdown(e.retryAfterS);
      else setFormError(errorMessage({ kind: 'throttled', retryAfterS: null }));
    } else if (e.kind === 'unavailable') setUnreachable(true);
    else setFormError(errorMessage(e));
  };

  async function verify() {
    const r = await login({ phone, pin: oneTimePin });
    setUnreachable(false);
    if (r.ok) {
      if (r.value.pinChangeRequired) {
        setVerifiedPin(oneTimePin);
      } else {
        toast('Your account is already active.');
        router.replace(homePathFor(r.value.user.role));
      }
      return;
    }
    const error = r.error;
    if (error.kind === 'invalid_phone') fieldError('phone', errorMessage(error));
    else if (error.kind === 'invalid_pin') fieldError('pin', pinReasonMessage(error.reason));
    else if (error.kind === 'invalid_credentials') {
      setOneTimePin('');
      fieldError('pin', 'PIN incorrect or expired — ask your merchant for a new one.');
    } else common(error);
  }

  async function setOwnPin() {
    const r = await changePin({ currentPin: verifiedPin ?? currentPin, newPin, confirmPin });
    setUnreachable(false);
    if (r.ok) {
      toast('PIN set. You’re signed in.');
      router.replace(homePathFor(r.value.user.role));
      return;
    }
    const error = r.error;
    if (error.kind === 'invalid_pin') {
      if (error.field === 'current_pin' && !askCurrent) setFormError(pinReasonMessage(error.reason));
      else fieldError(error.field === 'pin' ? 'new_pin' : error.field, pinReasonMessage(error.reason));
    } else if (error.kind === 'invalid_credentials') {
      if (askCurrent) {
        setCurrentPin('');
        fieldError('current_pin', forced ? 'PIN incorrect or expired — ask your merchant for a new one.' : 'Current PIN is incorrect.');
      } else setFormError('PIN incorrect or expired — ask your merchant for a new one.');
    } else common(error);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || throttled) return;
    setErrors({});
    setFormError(null);
    setBusy(true);
    if (step === 'verify') await verify();
    else await setOwnPin();
    setBusy(false);
  }

  if (status === 'resolving') {
    return <div className="h-72 animate-pulse rounded-2xl bg-inset" role="status" aria-label="Loading" />;
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {unreachable ? <UnreachableBanner onRetry={() => void submit()} busy={busy} /> : null}
      {throttled ? <FormAlert>Too many attempts. You can try again when the timer ends.</FormAlert> : null}
      {formError ? <FormAlert>{formError}</FormAlert> : null}

      {step === 'verify' ? (
        <>
          <Field id="phone" label="Phone number" error={errors.phone} hint="The number your merchant registered you with.">
            {(aria) => <PhoneInput ref={phoneRef} {...aria} name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} required />}
          </Field>
          <Field id="pin" label="One-time PIN" error={errors.pin} hint="Your merchant gave you this 6-digit PIN. It expires after 72 hours.">
            {(aria) => (
              <PinInput ref={pinRef} {...aria} name="one-time-pin" value={oneTimePin} onValueChange={setOneTimePin} autoComplete="one-time-code" required />
            )}
          </Field>
        </>
      ) : (
        <>
          {askCurrent ? (
            <Field
              id="current_pin"
              label={forced ? 'One-time PIN' : 'Current PIN'}
              hint={forced ? 'The 6-digit PIN your merchant gave you.' : undefined}
              error={errors.current_pin}
            >
              {(aria) => <PinInput ref={currentRef} {...aria} value={currentPin} onValueChange={setCurrentPin} autoComplete="current-password" required />}
            </Field>
          ) : null}
          <Field id="new_pin" label="New PIN" error={errors.new_pin} hint="4 to 6 digits. No repeats like 1111, runs like 1234 or common PINs.">
            {(aria) => <PinInput ref={newRef} {...aria} value={newPin} onValueChange={setNewPin} autoComplete="new-password" required />}
          </Field>
          <Field id="confirm_pin" label="Confirm new PIN" error={errors.confirm_pin}>
            {(aria) => <PinInput ref={confirmRef} {...aria} value={confirmPin} onValueChange={setConfirmPin} autoComplete="new-password" required />}
          </Field>
        </>
      )}

      <Button type="submit" block loading={busy} disabled={throttled}>
        {throttled ? (
          <span>
            Try again in <span className="font-mono tabular-nums">{formatCountdown(waitS)}</span>
          </span>
        ) : step === 'verify' ? (
          'Continue'
        ) : (
          'Set PIN'
        )}
      </Button>
    </form>
  );
}
