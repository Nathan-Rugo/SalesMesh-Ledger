import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

/** Gateway origin the same-origin `/api/v1/*` rewrite proxies to (resolved at build time). */
const gatewayUrl = (process.env.GATEWAY_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

/** Written by scripts/stamp-sw.mjs (prebuild) so the Next build ID and the SW cache name agree. */
const stampedBuildId = (() => {
  try {
    return readFileSync('.build-id', 'utf8').trim() || null;
  } catch {
    return null;
  }
})();

// Static CSP (no nonce) so every public page stays statically rendered.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws:' : ''}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  generateBuildId: async () => stampedBuildId,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${gatewayUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Production only: HSTS on localhost http would pin the dev origin to https.
          ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        ],
      },
    ];
  },
};

export default nextConfig;
