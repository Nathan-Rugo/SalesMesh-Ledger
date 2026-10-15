import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from './cn';

/** Kenyan mobile number: phone keypad, browser autofill, mono tabular digits. */
export function PhoneInput({ className, ref, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      maxLength={20}
      spellCheck={false}
      placeholder="0712 345 678"
      {...rest}
      className={cn(
        'min-h-13 w-full rounded-xl border border-field-edge bg-surface px-4 font-mono text-lg tracking-tight tabular-nums text-ink',
        'placeholder:text-ink-muted aria-invalid:border-danger',
        className
      )}
    />
  );
}
