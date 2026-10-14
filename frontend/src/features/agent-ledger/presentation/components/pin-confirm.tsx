'use client';

import { useRef, useState, type FormEvent } from 'react';
import { errorMessage, pinReasonMessage, type AppError } from '@/core/domain/app-error';
import type { Result } from '@/core/domain/result';
import { FormAlert, formatCountdown, useRetryCountdown } from '@/features/auth/presentation/components/form-feedback';
import { Button } from '@/shared/presentation/ui/button';
import { Field } from '@/shared/presentation/ui/field';
import { PinInput } from '@/shared/presentation/ui/pin-input';

export interface PinConfirmProps<T> {
  id: string;
  submitLabel: string;
  hint?: string;
  disabled?: boolean;
  submit: (pin: string) => Promise<Result<T, AppError>>;
  onDone: (value: T) => void;
  /** Any failure the PIN step doesn't own (refusals, network). */
  onError: (error: AppError) => void;
}

/**
 * PIN entry that spends at most one request at a time: a ref guards re-entry (two taps in the same
 * frame still send one POST) and the button stays disabled while busy. Wrong PIN and throttling are
 * shown here, with the auth copy and countdown; everything else goes to `onError`.
 */
export function PinConfirm<T>({ id, submitLabel, hint, disabled, submit, onDone, onError }: PinConfirmProps<T>) {
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const { waitS, startCountdown } = useRetryCountdown();
  const throttled = waitS > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inflight.current || throttled || disabled) return;
    inflight.current = true;
    setBusy(true);
    setPinError(null);
    setFormError(null);
    const r = await submit(pin);
    inflight.current = false;
    setBusy(false);
    if (r.ok) {
      setPin('');
      onDone(r.value);
      return;
    }
    const error = r.error;
    switch (error.kind) {
      case 'invalid_credentials':
        setPinError('PIN is incorrect.');
        setPin('');
        pinRef.current?.focus();
        break;
      case 'invalid_pin':
        setPinError(pinReasonMessage(error.reason));
        pinRef.current?.focus();
        break;
      case 'throttled':
        if (error.retryAfterS) startCountdown(error.retryAfterS);
        else setFormError(errorMessage({ kind: 'throttled', retryAfterS: null }));
        break;
      default:
        setPin('');
        onError(error);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {throttled ? <FormAlert>Too many attempts. You can try again when the timer ends.</FormAlert> : null}
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      <Field id={id} label="Your PIN" error={pinError} hint={hint}>
        {(aria) => <PinInput ref={pinRef} {...aria} name="pin" value={pin} onValueChange={setPin} autoComplete="current-password" required />}
      </Field>
      <Button type="submit" block loading={busy} disabled={throttled || disabled}>
        {throttled ? (
          <span>
            Try again in <span className="font-mono tabular-nums">{formatCountdown(waitS)}</span>
          </span>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  );
}
