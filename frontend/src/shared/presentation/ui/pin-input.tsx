'use client';

import { useState, type InputHTMLAttributes, type Ref } from 'react';
import { cn } from './cn';

export interface PinInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'maxLength'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Boxes drawn; PINs are 4–6 digits so the default fits the longest. */
  length?: number;
  ref?: Ref<HTMLInputElement>;
}

/**
 * Segmented PIN entry backed by ONE real input, so paste, password managers, SMS one-time-code
 * autofill and screen readers all work; the boxes are presentation only. Digits are masked.
 */
export function PinInput({ value, onValueChange, length = 6, autoComplete = 'one-time-code', className, onFocus, onBlur, ref, ...rest }: PinInputProps) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, length - 1);
  const invalid = Boolean(rest['aria-invalid']);
  return (
    <div className={cn('relative w-full max-w-[22rem]', className)}>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }} aria-hidden>
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={cn(
              'flex h-14 items-center justify-center rounded-xl border bg-surface transition-[border-color,box-shadow] duration-150',
              invalid ? 'border-danger' : focused && i === active ? 'border-ring' : 'border-field-edge',
              focused && i === active && 'shadow-[0_0_0_3px_color-mix(in_srgb,var(--sm-ring)_28%,transparent)]'
            )}
          >
            {i < value.length ? <span className="size-3 animate-roll-in rounded-full bg-ink" /> : null}
          </span>
        ))}
      </div>
      <input
        ref={ref}
        {...rest}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        maxLength={length}
        value={value}
        onChange={(e) => onValueChange(e.target.value.replace(/\D/g, '').slice(0, length))}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
      />
    </div>
  );
}
