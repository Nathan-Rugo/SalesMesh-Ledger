import { cn } from './cn';

/** Mark: two settlement rails joined by a mesh node. Wordmark optional. */
export function Logo({ className, wordmark = true }: { className?: string; wordmark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 text-ink', className)}>
      <svg viewBox="0 0 32 32" width={30} height={30} aria-hidden>
        <rect width="32" height="32" rx="9" fill="#075985" />
        <path d="M8 11h16M8 21h16" stroke="#E0F2FE" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M12 11l8 10" stroke="#00A859" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="20" cy="21" r="2.6" fill="#00A859" stroke="#075985" strokeWidth="1.2" />
      </svg>
      {wordmark ? <span className="text-[17px] font-bold tracking-[-0.02em]">SalesMesh</span> : <span className="sr-only">SalesMesh</span>}
    </span>
  );
}
