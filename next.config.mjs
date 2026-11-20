/**
 * Static security headers (identical for every visitor, so they are safe on
 * ISR/CDN-cached responses).
 *
 * The document Content-Security-Policy is set per request by src/middleware.ts
 * (src/lib/security/csp.ts), report-only by default (CSP_MODE). frame-ancestors
 * is ignored in report-only policies, so anti-framing is always enforced here
 * with a frame-ancestors-only CSP + X-Frame-Options; under CSP_MODE=enforce the
 * middleware's full policy (same frame-ancestors) replaces this header.
 *
 * AALAM_FRAME_ANCESTORS (read at build time) allows specific https origins to
 * frame the site. X-Frame-Options can only express SAMEORIGIN/DENY, so it is
 * omitted then; CSP frame-ancestors, which modern browsers prefer, applies.
 * Validation mirrors normalizeFrameAncestors() in src/lib/security/csp.ts
 * (kept in sync by tests/security-headers.test.cjs). See docs/security.md.
 */
const isProduction = process.env.NODE_ENV === 'production';
const ANCESTOR_SOURCE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

export function normalizeFrameAncestors(raw) {
  const tokens = (raw || '').trim().split(/\s+/).filter(Boolean);
  const valid = tokens.filter((token) => token === "'self'" || token === "'none'" || ANCESTOR_SOURCE.test(token));
  if (!valid.length) return "'self'";
  return valid.includes("'none'") ? "'none'" : valid.join(' ');
}

const frameAncestors = normalizeFrameAncestors(process.env.AALAM_FRAME_ANCESTORS);
const frameOptions = frameAncestors === "'self'" ? 'SAMEORIGIN' : frameAncestors === "'none'" ? 'DENY' : null;

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  // Other sites may not embed our responses (scripts, JSON, images) via
  // no-cors requests. Shareable assets are relaxed below.
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors}` },
  ...(frameOptions ? [{ key: 'X-Frame-Options', value: frameOptions }] : []),
  ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

/** API responses are data, never documents: nothing may load or frame them. */
const apiHeaders = [{ key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; sandbox" }];

/** Social preview image and icon are fetched cross-site by design. */
const shareableAssetHeaders = [{ key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  poweredByHeader: false,
  productionBrowserSourceMaps: process.env.PERF_SOURCEMAPS === '1',
  allowedDevOrigins: ['*.e2b.app', '*.e2b.dev', 'localhost', '127.0.0.1'],
  // `npm run lint` runs ESLint over the whole repo as its own step (and its own
  // CI job step), so the build does not need to repeat it. Next also cannot
  // introspect a flat config to confirm @next/next is loaded and warns on every
  // build even though the plugin is registered in eslint.config.mjs.
  eslint: { ignoreDuringBuilds: true },
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'image.tmdb.org' },
      { protocol: 'https', hostname: 'images.pexels.com' },
    ],
  },
  async headers() {
    // Later entries override earlier ones for the same header key.
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', headers: apiHeaders },
      { source: '/social-image', headers: shareableAssetHeaders },
      { source: '/icon.svg', headers: shareableAssetHeaders },
      { source: '/icons/:file*', headers: shareableAssetHeaders },
      // The service worker script must always be revalidated so fixes and the
      // NEXT_PUBLIC_SW_DISABLED kill switch reach visitors promptly.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, max-age=0, must-revalidate' }] },
      // The offline fallback is a utility page, never a search result.
      { source: '/offline.html', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ];
  },
  async redirects() {
    return [
      // The manifest moved to the typed route src/app/manifest.ts. HTML cached
      // by a CDN before the move (up to 6 h for title pages) still links here.
      { source: '/manifest.json', destination: '/manifest.webmanifest', permanent: true },
    ];
  },
  async rewrites() {
    return [
      // Public title-sitemap URLs listed in /sitemap.xml (see src/server/seo).
      { source: '/sitemap-:kind(movies|series)-:shard(\\d{1,4}).xml', destination: '/sitemaps/:kind/:shard' },
    ];
  },
};

export default nextConfig;
