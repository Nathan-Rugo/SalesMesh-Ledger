import { escrowLabel, escrowTone, type EscrowStatus, type EscrowTone } from '@/shared/domain/escrow-status';
import { cn } from './cn';

// Literal class strings so Tailwind's scanner emits them. Dot = Design_Inspo token text colour;
// label = the AAA ink of the same hue (the token text colours are 3.5–4.5:1 on their backgrounds).
const TONES: Record<EscrowTone, { pill: string; dot: string }> = {
  clear: { pill: 'bg-escrow-clear-bg border-escrow-clear-border text-escrow-clear-ink', dot: 'bg-escrow-clear' },
  hold: { pill: 'bg-escrow-hold-bg border-escrow-hold-border text-escrow-hold-ink', dot: 'bg-escrow-hold' },
  quarantined: { pill: 'bg-escrow-quarantined-bg border-escrow-quarantined-border text-escrow-quarantined-ink', dot: 'bg-escrow-quarantined' },
  canary: { pill: 'bg-escrow-canary-bg border-escrow-canary-border text-escrow-canary-ink', dot: 'bg-escrow-canary' },
  remitted: { pill: 'bg-escrow-remitted-bg border-escrow-remitted-border text-escrow-remitted-ink', dot: 'bg-escrow-remitted' },
};

/** Escrow lifecycle pill: colour plus a text label, never colour alone. */
export function StatusPill({ status, className }: { status: EscrowStatus; className?: string }) {
  const tone = TONES[escrowTone(status)];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap', tone.pill, className)}>
      <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
      {escrowLabel(status)}
    </span>
  );
}
