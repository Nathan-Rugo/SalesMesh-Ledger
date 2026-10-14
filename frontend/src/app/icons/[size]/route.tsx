import { ImageResponse } from 'next/og';
import { MARK_ON_TILE, MARK_STEMS, MARK_TICK, SQUIRCLE } from '@/shared/presentation/ui/logo';

// Launcher tile B "Night ink": dark squircle, pale stems, M-Pesa green tick.
const INK = '#0A1F16';

// Built once per size at build time; any other size is a 404.
export const dynamic = 'force-static';
export const dynamicParams = false;

const VARIANTS = {
  '192': { px: 192, maskable: false },
  '512': { px: 512, maskable: false },
  'maskable-192': { px: 192, maskable: true },
  'maskable-512': { px: 512, maskable: true },
} as const;
type Variant = keyof typeof VARIANTS;

export function generateStaticParams(): Array<{ size: Variant }> {
  return (Object.keys(VARIANTS) as Variant[]).map((size) => ({ size }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  const v = VARIANTS[size as Variant];
  if (!v) return new Response('Not found', { status: 404 });
  // "any": the Night-ink squircle. Maskable: the same M on a full-bleed ink canvas; at 62 % its
  // farthest stroke corner is 0.33 of the size from centre, inside the 0.40 safe-zone radius.
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: v.maskable ? INK : 'transparent' }}>
        <svg width={v.px} height={v.px} viewBox="0 0 256 256">
          {v.maskable ? null : <path d={SQUIRCLE} fill={INK} />}
          <g transform={MARK_ON_TILE} fill="none" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round">
            <path d={MARK_STEMS} stroke="#E4EEE7" />
            <path d={MARK_TICK} stroke="#00A859" />
          </g>
        </svg>
      </div>
    ),
    { width: v.px, height: v.px, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }
  );
}
