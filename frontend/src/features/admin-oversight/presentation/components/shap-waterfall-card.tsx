import { cn } from '@/shared/presentation/ui/cn';
import { Icon } from '@/shared/presentation/ui/icon';
import { featureCopy, waterfall, type FrozenItem } from '../../domain/entities/oversight';

export const REASONS: Record<string, string> = {
  security_hold: 'Security check on the payment (changed, reversed or not on the statement).',
  fail_safe: 'The risk check was unavailable, so it was held to be safe.',
  model_decision: 'The risk model flagged it for review.',
  trust_below_threshold: "The agent's trust score is below the freeze line.",
  trust_input_invalid: 'The payment details were incomplete for the trust score.',
};
export const reasonText = (r: string | null): string => (r && REASONS[r]) || 'Held for review.';

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;

/**
 * Why the model froze this escrow: each feature's SHAP attribution for the run that froze it, as a
 * waterfall (running total from 0, largest first). Plain CSS bars, relative widths; the
 * signed log-odds value and "up / down" are in text too, never colour alone. Model attribution only.
 */
export function SHAPWaterfallCard({ item }: { item: FrozenItem }) {
  if (item.securityHold) {
    return (
      <div role="note" className="flex items-start gap-3 rounded-xl border border-escrow-quarantined-border bg-escrow-quarantined-bg p-3 text-escrow-quarantined-ink">
        <Icon name="shield" className="mt-px size-5 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-semibold">Needs investigation</p>
          <p className="text-sm">{REASONS.security_hold} It can&rsquo;t be released from here: it clears only when the investigation does.</p>
        </div>
      </div>
    );
  }
  const shap = item.risk?.shap;
  if (!shap) {
    return (
      <div role="note" className="flex flex-col gap-1 rounded-xl border border-dashed border-line-strong p-3">
        <p className="text-[15px] font-semibold text-ink">No model explanation recorded</p>
        <p className="text-sm text-ink-muted">{reasonText(item.reason)}</p>
      </div>
    );
  }
  const { steps, min, max } = waterfall(shap);
  const extent = max - min || 1;
  const pos = (x: number) => ((x - min) / extent) * 100;
  return (
    <figure className="flex flex-col gap-3" aria-labelledby={`shap-${item.id}`}>
      <figcaption id={`shap-${item.id}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold text-ink">What pushed the risk score</span>
        <span className="font-mono text-[13px] text-ink-muted tabular-nums">
          {item.risk?.xgbProb != null ? `score ${item.risk.xgbProb.toFixed(2)} · ` : ''}model {item.risk?.modelVersion}
        </span>
      </figcaption>
      <ol className="flex flex-col gap-3">
        {steps.map(({ c, from, to }) => {
          const copy = featureCopy(c.feature);
          const up = c.attribution >= 0;
          return (
            <li key={c.feature} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-ink">
                  {copy.label} <span className="font-mono text-ink-muted tabular-nums">{copy.format(c.value)}</span>
                </span>
                <span className={cn('font-mono font-semibold whitespace-nowrap tabular-nums', up ? 'text-escrow-quarantined-ink' : 'text-escrow-clear-ink')}>
                  {signed(c.attribution)}
                  <span className="sr-only">{up ? ', pushed the score up' : ', pushed the score down'}</span>
                </span>
              </div>
              <div aria-hidden className="relative h-2.5 rounded-full bg-inset">
                <span className="absolute inset-y-[-3px] w-px bg-ink-muted" style={{ left: `${pos(0)}%` }} />
                <span
                  className={cn('absolute inset-y-0 rounded-full', up ? 'bg-escrow-quarantined' : 'bg-escrow-clear')}
                  style={{ left: `${pos(Math.min(from, to))}%`, width: `${Math.max(1, (Math.abs(c.attribution) / extent) * 100)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-[13px] text-ink-muted">
        Red pushed the score up (toward a hold), green pushed it down. Values in log-odds; bars are relative to each other.
        This is the model&rsquo;s attribution for the run that froze it, not proof of fraud.
      </p>
    </figure>
  );
}
