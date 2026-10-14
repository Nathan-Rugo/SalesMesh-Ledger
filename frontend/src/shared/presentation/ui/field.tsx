import type { ReactNode } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FieldProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (control: FieldControlProps) => ReactNode;
}

/** Visible label, hint and inline error, wired to the control through ids. */
export function Field({ id, label, hint, error, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[15px] font-semibold text-ink">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
