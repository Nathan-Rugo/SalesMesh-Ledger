import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

// `optional`: no late swap of the hero text, so no LCP re-paint or layout shift on a slow first visit.
const plexSans = IBM_Plex_Sans({ subsets: ['latin'], variable: '--font-plex-sans', display: 'optional', weight: ['400', '500', '600', '700'] });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], variable: '--font-plex-mono', display: 'swap', weight: ['400', '500', '700'] });
// Editorial serif for landing headlines only: reads like a statement header, not a template.
const newsreader = Newsreader({ subsets: ['latin'], variable: '--font-newsreader', display: 'optional', weight: ['400', '500', '600'] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: { default: 'SalesMesh — commission you can trace', template: '%s · SalesMesh' },
  description:
    'SalesMesh pays sales agents their commission over M-Pesa, held in escrow until each customer payment settles, with every step on a tamper-evident ledger.',
  applicationName: 'SalesMesh',
  manifest: '/manifest.json',
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }], apple: [{ url: '/icons/maskable-192', sizes: '192x192', type: 'image/png' }] },
  appleWebApp: { capable: true, title: 'SalesMesh', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f3f6f4',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The landing boot script adds `sm-motion` to <html> before hydration.
    <html lang="en-KE" suppressHydrationWarning className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`}>
      <body className="min-h-dvh bg-canvas text-ink">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
