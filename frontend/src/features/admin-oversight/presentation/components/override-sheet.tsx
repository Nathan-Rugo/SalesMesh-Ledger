'use client';

import { useEffect, useRef, useState } from 'react';
import { errorMessage, type AppError } from '@/core/domain/app-error';
import { PinConfirm } from '@/features/agent-ledger/presentation/components/pin-confirm';
import { FormAlert } from '@/features/auth/presentation/components/form-feedback';
import { useSession } from '@/features/auth/presentation/state/session-provider';
import { Button } from '@/shared/presentation/ui/button';
import { Field } from '@/shared/presentation/ui/field';
import { ReceiptRule } from '@/shared/presentation/ui/receipt';
import { useToast } from '@/shared/presentation/ui/toast';
import { NOTE_MAX, NOTE_MIN, validNote, validReceipt, type OverrideTarget } from '../../domain/entities/oversight';

type Choice = { kind: 'escrow'; action: 'release' | 'keep' } | { kind: 'payout'; outcome: 'paid' | 'failed' };

const CHOICES: Record<'escrow' | 'payout', { choice: Choice; label: string; hint: string; done: string }[]> = {
  escrow: [
    {
      choice: { kind: 'escrow', action: 'release' },
      label: 'Release',
      hint: 'Returns it to the normal claim path. Nothing is paid from here; the agent claims as usual.',
      done: 'Released. It is back on the normal claim path.',
    },
    { choice: { kind: 'escrow', action: 'keep' }, label: 'Keep held', hint: 'Stays frozen and is marked as reviewed.', done: 'Kept held and marked as reviewed.' },
  ],
  payout: [
    {
      choice: { kind: 'payout', outcome: 'paid' },
      label: 'Mark paid',
      hint: 'Only with the M-Pesa receipt from the org portal or statement.',
      done: 'Marked paid. The agent was told by SMS.',
    },
    {
      choice: { kind: 'payout', outcome: 'failed' },
      label: 'Mark failed',
      hint: 'M-Pesa shows it never went out: the agent can claim the amount again.',
      done: 'Marked failed. The agent can claim again.',
    },
  ],
};

/** Refusals that mean the item moved on: refetch and say so, no form error. */
const MOVED_ON = ['already_decided', 'security_hold', 'not_unresolved', 'not_found'];

const inputClass =
  'w-full rounded-xl border border-field-edge bg-surface px-4 py-3 text-[15px] text-ink placeholder:text-ink-muted aria-invalid:border-danger';

/**
 * Admin override of one queue item: choose the action, write the reason (10–280 characters) and
 * confirm with the PIN. One request at a time (PinConfirm); a 409 refetches and toasts the new state.
 */
export function OverrideSheet({ kind, id, offline, onChanged }: { kind: 'escrow' | 'payout'; id: string; offline: boolean; onChanged: () => Promise<void> }) {
  const { container } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState<(typeof CHOICES)['escrow'][number] | null>(null);
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const base = `ovr-${kind}-${id}`;
  const receiptRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);

  function close() {
    setOpen(null);
    setMessage(null);
    setNote('');
    setReceipt('');
    setNoteError(null);
    setReceiptError(null);
  }

  const paid = open?.choice.kind === 'payout' && open.choice.outcome === 'paid';
  // Opening unmounts the focused action button and closing unmounts the form: move focus with them.
  useEffect(() => {
    if (open) (paid ? receiptRef : noteRef).current?.focus();
    else if (wasOpen.current) document.getElementById(`${base}-action`)?.focus(); // Button takes no ref
    wasOpen.current = open !== null;
  }, [open, paid, base]);

  const ready = validNote(note) !== null && (!paid || validReceipt(receipt) !== null);

  function target(): OverrideTarget {
    const c = open!.choice;
    if (c.kind === 'escrow') return { kind: 'escrow', id, action: c.action };
    return c.outcome === 'paid' ? { kind: 'payout', id, outcome: 'paid', receipt } : { kind: 'payout', id, outcome: 'failed' };
  }

  function onError(e: AppError) {
    if (e.kind === 'override_refused' && e.code === 'invalid_note') return setNoteError(errorMessage(e));
    if (e.kind === 'invalid_request' && paid) return setReceiptError('Enter the M-Pesa receipt code, 8 to 20 letters and digits.');
    if (e.kind === 'override_refused' && MOVED_ON.includes(e.code)) {
      close();
      toast(errorMessage(e));
      void onChanged();
      return;
    }
    setMessage(errorMessage(e));
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {message ? <FormAlert>{message}</FormAlert> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          {CHOICES[kind].map((c, i) => (
            <Button
              key={c.label}
              id={i === 0 ? `${base}-action` : undefined}
              variant={i === 0 ? 'primary' : 'secondary'}
              block
              disabled={offline}
              onClick={() => {
                setMessage(null);
                setOpen(c);
              }}
            >
              {c.label}
            </Button>
          ))}
        </div>
        {offline ? <p className="text-sm text-ink-muted">Decisions need a connection.</p> : null}
      </div>
    );
  }

  return (
    <section aria-label={`${open.label}: confirm`} className="flex flex-col gap-4">
      <ReceiptRule className="my-0" />
      <p className="text-[15px] text-ink">
        <span className="font-semibold">{open.label}.</span> {open.hint}
      </p>
      {message ? <FormAlert>{message}</FormAlert> : null}
      {paid ? (
        <Field id={`${base}-receipt`} label="M-Pesa receipt" error={receiptError}>
          {(aria) => (
            <input
              {...aria}
              ref={receiptRef}
              className={`${inputClass} font-mono uppercase tabular-nums`}
              value={receipt}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              placeholder="SGH12ABC34"
              onChange={(e) => {
                setReceipt(e.target.value);
                setReceiptError(null);
              }}
            />
          )}
        </Field>
      ) : null}
      <Field
        id={`${base}-note`}
        label="Reason (kept in the audit log)"
        error={noteError}
        hint={`${note.trim().length}/${NOTE_MAX} characters, at least ${NOTE_MIN}.`}
      >
        {(aria) => (
          <textarea
            {...aria}
            ref={noteRef}
            className={inputClass}
            rows={3}
            maxLength={NOTE_MAX + 20}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteError(null);
            }}
          />
        )}
      </Field>
      <PinConfirm
        id={`${base}-pin`}
        submitLabel={`Confirm: ${open.label.toLowerCase()}`}
        disabled={!ready || offline}
        submit={(pin) => container.override.execute({ target: target(), pin, note })}
        onDone={() => {
          const done = open.done;
          close();
          toast(done);
          void onChanged();
        }}
        onError={onError}
      />
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
    </section>
  );
}
