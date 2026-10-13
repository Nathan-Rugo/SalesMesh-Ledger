import { ImageResponse } from 'next/og';

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
  // Maskable icons fill the canvas and keep the mark inside the 80 % safe zone.
  const mark = Math.round(v.px * (v.maskable ? 0.56 : 0.72));
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: v.maskable ? '#075985' : 'transparent',
        }}
      >
        <div
          style={{
            width: v.maskable ? mark : v.px,
            height: v.maskable ? mark : v.px,
            borderRadius: v.maskable ? 0 : v.px * 0.28,
            background: '#075985',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width={mark} height={mark} viewBox="0 0 32 32">
            <path d="M8 11h16M8 21h16" stroke="#E0F2FE" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M12 11l8 10" stroke="#00A859" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="20" cy="21" r="2.6" fill="#00A859" stroke="#075985" strokeWidth="1.2" />
          </svg>
        </div>
      </div>
    ),
    { width: v.px, height: v.px, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }
  );
}
