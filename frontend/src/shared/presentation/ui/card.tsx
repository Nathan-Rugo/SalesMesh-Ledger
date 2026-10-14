import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** Surface card: 1 px crisp border, optional spring press when interactive. */
export function Card({ className, interactive = false, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      {...rest}
      className={cn('sm-surface rounded-2xl border border-line bg-surface', interactive && 'press cursor-pointer hover:border-ink-muted', className)}
    />
  );
}
