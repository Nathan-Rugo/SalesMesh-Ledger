'use client';

import { useRef, useState, type FormEvent } from 'react';
import { errorMessage, pinReasonMessage, type AppError } from '@/core/domain/app-error';
import { Button } from '@/shared/presentation/ui/button';
import { Field } from '@/shared/presentation/ui/field';
import { PinInput } from '@/shared/presentation/ui/pin-input';
import { useSession } from '../state/session-provider';
import { FormAlert, UnreachableBanner, formatCountdown, useRetryCountdown } from './form-feedback';

type FieldName = 'current_pin' | 'new_pin' | 'confirm_pin';

/**
 * Voluntary PIN change for a signed-in user. On success the gateway ends every other session and
 * hands this one a fresh family, which the repository adopts: no re-login here.
 */
export function ChangePinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { changePin } = useSession();
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const { waitS, startCountdown } = useRetryCountdown();
  const throttled = waitS > 0;

  const fieldError = (name: FieldName, message: string) => {
    setErrors({ [name]: message });
    ({ current_pin: currentRef, new_pin: newRef, confirm_pin: confirmRef })[name].current?.focus();
  };

  function fail(e: AppError) {
    if (e.kind === 'invalid_pin') fieldError(e.field === 'pin' ? 'new_pin' : e.field, pinReasonMessage(e.reason));
    else if (e.kind === 'invalid_credentials') {
      setCurrentPin('');
      fieldError('current_pin', 'Current PIN is incorrect.');
    } else if (e.kind === 'throttled') {
      // Retry-After: 0 (or missing) gives nothing to count down: show the generic message.
      if (e.retryAfterS) startCountdown(e.retryAfterS);
      else setFormError(errorMessage({ kind: 'throttled', retryAfterS: null }));
    } else if (e.kind === 'unavailable') setUnreachable(true);
    else setFormError(errorMessage(e));
  }

  async function submit(ev?: FormEvent) {
    ev?.preventDefault();
    if (busy || throttled) return;
    setErrors({});
    setFormError(null);
    setBusy(true);
    const r = await changePin({ currentPin, newPin, confirmPin });
    setBusy(false);
    setUnreachable(false);
    if (r.ok) onDone();
    else fail(r.error);
  }

  return (
    <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-5" aria-label="Change PIN">
      {unreachable ? <UnreachableBanner onRetry={() => void submit()} busy={busy} /> : null}
      {throttled ? <FormAlert>Too many attempts. You can try again when the timer ends.</FormAlert> : null}
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      <Field id="current_pin" label="Current PIN" error={errors.current_pin}>
        {(aria) => <PinInput ref={currentRef} {...aria} value={currentPin} onValueChange={setCurrentPin} autoComplete="current-password" required />}
      </Field>
      <Field id="new_pin" label="New PIN" error={errors.new_pin} hint="4 to 6 digits. No repeats like 1111, runs like 1234 or common PINs.">
        {(aria) => <PinInput ref={newRef} {...aria} value={newPin} onValueChange={setNewPin} autoComplete="new-password" required />}
      </Field>
      <Field id="confirm_pin" label="Confirm new PIN" error={errors.confirm_pin}>
        {(aria) => <PinInput ref={confirmRef} {...aria} value={confirmPin} onValueChange={setConfirmPin} autoComplete="new-password" required />}
      </Field>
      <p className="text-sm text-ink-muted">Changing your PIN signs you out on your other devices.</p>
      <div className="flex gap-3">
        <Button type="submit" loading={busy} disabled={throttled}>
          {throttled ? (
            <span>
              Try again in <span className="font-mono tabular-nums">{formatCountdown(waitS)}</span>
            </span>
          ) : (
            'Change PIN'
          )}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
