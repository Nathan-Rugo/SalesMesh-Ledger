import { cn } from './cn';

/** App-icon squircle (superellipse n=5, docs/brand/logo/app-icon.svg), 256 grid. */
export const SQUIRCLE =
  'M256.0 128.0L256.0 164.6L255.8 176.2L255.6 184.7L255.2 191.5L254.8 197.4L254.2 202.5L253.6 207.2L252.9 211.3L252.0 215.2L251.1 218.7L250.0 222.0L248.8 225.0L247.6 227.8L246.2 230.5L244.7 233.0L243.1 235.3L241.3 237.4L239.4 239.4L237.4 241.3L235.3 243.1L233.0 244.7L230.5 246.2L227.8 247.6L225.0 248.8L222.0 250.0L218.7 251.1L215.2 252.0L211.3 252.9L207.2 253.6L202.5 254.2L197.4 254.8L191.5 255.2L184.7 255.6L176.2 255.8L164.6 256.0L128.0 256.0L91.4 256.0L79.8 255.8L71.3 255.6L64.5 255.2L58.6 254.8L53.5 254.2L48.8 253.6L44.7 252.9L40.8 252.0L37.3 251.1L34.0 250.0L31.0 248.8L28.2 247.6L25.5 246.2L23.0 244.7L20.7 243.1L18.6 241.3L16.6 239.4L14.7 237.4L12.9 235.3L11.3 233.0L9.8 230.5L8.4 227.8L7.2 225.0L6.0 222.0L4.9 218.7L4.0 215.2L3.1 211.3L2.4 207.2L1.8 202.5L1.2 197.4L0.8 191.5L0.4 184.7L0.2 176.2L0.0 164.6L0.0 128.0L0.0 91.4L0.2 79.8L0.4 71.3L0.8 64.5L1.2 58.6L1.8 53.5L2.4 48.8L3.1 44.7L4.0 40.8L4.9 37.3L6.0 34.0L7.2 31.0L8.4 28.2L9.8 25.5L11.3 23.0L12.9 20.7L14.7 18.6L16.6 16.6L18.6 14.7L20.7 12.9L23.0 11.3L25.5 9.8L28.2 8.4L31.0 7.2L34.0 6.0L37.3 4.9L40.8 4.0L44.7 3.1L48.8 2.4L53.5 1.8L58.6 1.2L64.5 0.8L71.3 0.4L79.8 0.2L91.4 0.0L128.0 0.0L164.6 0.0L176.2 0.2L184.7 0.4L191.5 0.8L197.4 1.2L202.5 1.8L207.2 2.4L211.3 3.1L215.2 4.0L218.7 4.9L222.0 6.0L225.0 7.2L227.8 8.4L230.5 9.8L233.0 11.3L235.3 12.9L237.4 14.7L239.4 16.6L241.3 18.6L243.1 20.7L244.7 23.0L246.2 25.5L247.6 28.2L248.8 31.0L250.0 34.0L251.1 37.3L252.0 40.8L252.9 44.7L253.6 48.8L254.2 53.5L254.8 58.6L255.2 64.5L255.6 71.3L255.8 79.8L256.0 91.4Z';

/** The Cleared M split so the tick (its middle stroke) can carry its own colour. */
export const MARK_STEMS = 'M52 212V124M204 52v160';
export const MARK_TICK = 'M52 124l52 52L204 52';

/** Places the 256-grid Cleared M at 62 % of the tile, optically centred (the M sits 4 units low). */
export const MARK_ON_TILE = 'translate(128 128) scale(0.62) translate(-128 -132)';

/** Logo: the Cleared M on a squircle. Colours come from --sm-logo-* so the agent shell shows the
 *  receipt tile (paper, ink stems, M-Pesa green tick) and the admin shell the night-ink tile. Wordmark optional. */
export function Logo({ className, wordmark = true }: { className?: string; wordmark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 text-ink', className)}>
      <svg viewBox="-3 -3 262 262" width={30} height={30} aria-hidden className="shrink-0">
        <path d={SQUIRCLE} style={{ fill: 'var(--sm-logo-tile)', stroke: 'var(--sm-logo-edge)' }} strokeWidth="6" />
        <g transform={MARK_ON_TILE} fill="none" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round">
          <path d={MARK_STEMS} style={{ stroke: 'var(--sm-logo-stem)' }} />
          <path d={MARK_TICK} style={{ stroke: 'var(--sm-logo-tick)' }} />
        </g>
      </svg>
      {wordmark ? <span className="text-[18px] font-bold tracking-[-0.03em]">SalesMesh</span> : <span className="sr-only">SalesMesh</span>}
    </span>
  );
}
