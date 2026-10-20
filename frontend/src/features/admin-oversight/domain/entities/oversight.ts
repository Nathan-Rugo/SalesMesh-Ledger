/** One feature's signed SHAP attribution for the model run that froze an escrow (log-odds units). */
export interface ShapContribution {
  /** ml-engine feature name, e.g. `velocity_v_i`. */
  readonly feature: string;
  /** Pushes the raw model score up (+) or down (-); uncalibrated log-odds, comparable only to each other. */
  readonly attribution: number;
  /** The feature's value for this payment. */
  readonly value: number;
}

/** The latest verification event behind a quarantine. */
export interface RiskRun {
  readonly decision: string;
  readonly isoScore: number | null;
  readonly xgbProb: number | null;
  readonly modelVersion: string;
  /** null: no explanation was recorded (frozen before it was stored, fail-safe, or a security hold). */
  readonly shap: readonly ShapContribution[] | null;
}

/** A QUARANTINED escrow waiting for an admin. */
export interface FrozenItem {
  readonly id: string;
  readonly agentCode: string | null;
  readonly agentName: string;
  readonly amountCents: number;
  readonly reason: string | null;
  /** Read-only: needs an investigation, not an override. */
  readonly securityHold: boolean;
  readonly receipt: string;
  readonly frozenAt: number;
  /** An admin chose "Keep held" in this freeze. */
  readonly reviewedAt: number | null;
  readonly overdue: boolean;
  readonly risk: RiskRun | null;
}

/** A payout M-Pesa never confirmed, waiting for an admin to settle it from evidence. */
export interface UnresolvedPayout {
  readonly id: string;
  readonly agentCode: string | null;
  readonly agentName: string;
  readonly amountCents: number;
  /** Masked, as the gateway sends it. */
  readonly msisdn: string;
  readonly unresolvedAt: number | null;
  readonly overdue: boolean;
}

export interface OversightQueue {
  readonly slaHours: { readonly escrow: number; readonly payout: number };
  /** Overdue first, then oldest first (server order); capped. */
  readonly escrows: readonly FrozenItem[];
  readonly payouts: readonly UnresolvedPayout[];
  /** Uncapped counts. */
  readonly totals: { readonly escrows: number; readonly payouts: number };
  readonly overdue: { readonly escrows: number; readonly payouts: number };
}

export type OverrideTarget =
  | { readonly kind: 'escrow'; readonly id: string; readonly action: 'release' | 'keep' }
  | { readonly kind: 'payout'; readonly id: string; readonly outcome: 'paid'; readonly receipt: string }
  | { readonly kind: 'payout'; readonly id: string; readonly outcome: 'failed' };

export const NOTE_MIN = 10;
export const NOTE_MAX = 280;
const RECEIPT_RE = /^[A-Z0-9]{8,20}$/;

/** The mandatory reason note, trimmed, or null when shorter than 10 or longer than 280 characters. */
export function validNote(note: string): string | null {
  const t = note.trim();
  return t.length >= NOTE_MIN && t.length <= NOTE_MAX ? t : null;
}

/** An M-Pesa receipt code, normalised (trimmed, upper-case), or null. */
export function validReceipt(receipt: string): string | null {
  const r = receipt.trim().toUpperCase();
  return RECEIPT_RE.test(r) ? r : null;
}

export interface FeatureCopy {
  /** Plain-language name. */
  readonly label: string;
  readonly format: (v: number) => string;
}

const num = (digits: number) => (v: number) => v.toLocaleString('en-KE', { maximumFractionDigits: digits });

/** ml-engine's 6 behavioural features, in words an admin uses. */
export const FEATURES: Readonly<Record<string, FeatureCopy>> = {
  velocity_v_i: { label: 'Sales pace (payments per hour)', format: (v) => `${num(1)(v)}/h` },
  split_ratio_r_s: { label: 'Share of split payments just under a limit', format: (v) => `${Math.round(v * 100)}%` },
  entropy_gaps: { label: 'Irregular timing between payments', format: (v) => `${num(2)(v)} bits` },
  agent_zscore: { label: "Amount vs. this agent's usual (std. devs)", format: (v) => `${v >= 0 ? '+' : ''}${num(1)(v)}` },
  amount_to_median_ratio: { label: "Amount vs. this agent's typical sale", format: (v) => `${num(1)(v)}×` },
  recipient_reuse_count: { label: 'Repeat payments from the same customer (24 h)', format: (v) => num(0)(v) },
};

/** A feature's copy; an unknown (newer) feature keeps its raw name. */
export const featureCopy = (feature: string): FeatureCopy => FEATURES[feature] ?? { label: feature, format: num(3) };

export interface WaterfallStep {
  readonly c: ShapContribution;
  /** Running total before / after this step (log-odds, from 0). */
  readonly from: number;
  readonly to: number;
}

/**
 * Cumulative steps in the server's order (largest |attribution| first), plus the axis extent
 * [min, max] covering 0 and every running total, so bars can be drawn as relative widths.
 */
export function waterfall(shap: readonly ShapContribution[]): { steps: WaterfallStep[]; min: number; max: number } {
  let at = 0;
  let min = 0;
  let max = 0;
  const steps = shap.map((c) => {
    const step = { c, from: at, to: at + c.attribution };
    at = step.to;
    min = Math.min(min, at);
    max = Math.max(max, at);
    return step;
  });
  return { steps, min, max };
}

/** "45 min", "5 h", "3 d 4 h": how long an item has waited. */
export function formatAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
