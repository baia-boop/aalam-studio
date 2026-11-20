import { NextResponse, type NextRequest } from 'next/server';
import { isTrackingParam } from '@/lib/seo-url';
import {
  CATALOGUE_VARIANT_PREFIX,
  encodeCatalogueVariant,
  isCatalogueSection,
} from '@/lib/catalogue-variant';
import {
  CSP_REPORT_PATH,
  buildCsp,
  cspProfileForPath,
  generateNonce,
  normalizeFrameAncestors,
  parseExtraSources,
  readCspMode,
  reportingEndpointsHeader,
} from '@/lib/security/csp';

/**
 * Site-wide campaign-parameter consolidation.
 *
 * Tracking parameters (utm_*, fbclid, gclid, …) never change page identity.
 * When any of them appear in an incoming request URL we issue a permanent
 * 308 redirect to the same path with those parameters stripped, so every
 * duplicate campaign variant collapses onto exactly one canonical URL before
 * a page is ever rendered (and before it can be indexed).
 *
 * Pages whose only surviving query differences are semantic filters
 * (e.g. /movies?genre=Action) keep their own self-canonical URLs and are not
 * redirected beyond the tracking-param removal performed here.
 */
export function middleware(request: NextRequest): NextResponse {
  const url = request.nextUrl;

  // Next 15.5 can send two identical Location headers on a cold ISR title
  // redirect. Some clients join them and follow the joined path. Recover only
  // an exact pair of generated, same-origin title paths before rendering.
  const repeatedTitle = /^(\/title\/(?:movie|tv)\/[1-9]\d{0,15}(?:-[a-z0-9-]{1,64})?)(?:,|%2[Cc])%20\1$/.exec(url.pathname);
  let canonicalized = Boolean(repeatedTitle);
  if (repeatedTitle) url.pathname = repeatedTitle[1];
  for (const key of Array.from(url.searchParams.keys())) {
    if (isTrackingParam(key)) {
      url.searchParams.delete(key);
      canonicalized = true;
    }
  }
  if (canonicalized) return NextResponse.redirect(url, 308);

  const csp = documentCsp(url.pathname);
  // Strict pages are rendered per request: hand Next the nonce through the
  // request CSP header so it stamps its own <script> tags (app-render reads
  // content-security-policy, then content-security-policy-report-only).
  const requestHeaders = csp.requestHeader ? new Headers(request.headers) : undefined;
  if (requestHeaders && csp.requestHeader) {
    // A client-supplied CSP request header must not shadow ours.
    requestHeaders.delete('content-security-policy');
    requestHeaders.delete('content-security-policy-report-only');
    requestHeaders.set(csp.requestHeader[0], csp.requestHeader[1]);
  }
  const init = requestHeaders ? { request: { headers: requestHeaders } } : undefined;

  const response = (url.search && rewriteCatalogueVariant(request, init)) || NextResponse.next(init);
  for (const [name, value] of csp.responseHeaders) response.headers.set(name, value);
  return response;
}

// --- Content-Security-Policy ------------------------------------------------

interface DocumentCsp {
  responseHeaders: Array<[string, string]>;
  requestHeader?: [string, string];
}

const cspMode = readCspMode(process.env.CSP_MODE);
const reportingApi = process.env.CSP_REPORTING_API === '1';
const isDev = process.env.NODE_ENV !== 'production';
// Read at build time by next.config.mjs too: set it for the build.
const frameAncestors = normalizeFrameAncestors(process.env.AALAM_FRAME_ANCESTORS);
const cspBase = {
  dev: isDev,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  frameAncestors,
  upgradeInsecureRequests: cspMode === 'enforce' && !isDev,
  reportUri: CSP_REPORT_PATH,
  reportTo: reportingApi,
  extra: {
    img: parseExtraSources(process.env.CSP_EXTRA_IMG_SRC),
    connect: parseExtraSources(process.env.CSP_EXTRA_CONNECT_SRC),
    frame: parseExtraSources(process.env.CSP_EXTRA_FRAME_SRC),
    media: parseExtraSources(process.env.CSP_EXTRA_MEDIA_SRC),
  },
};
// Identical for every visitor, so it is safe on ISR/CDN-cached HTML.
const cacheablePolicy = buildCsp({ ...cspBase, profile: 'cacheable' });

/**
 * Anti-framing is enforced separately by a static
 * `Content-Security-Policy: frame-ancestors …` from next.config.mjs, because
 * frame-ancestors is ignored inside a Report-Only policy. It must NOT be set
 * here: Next copies middleware response headers into the request it renders,
 * and reads the script nonce from `content-security-policy` before
 * `content-security-policy-report-only`, so an enforced frame-ancestors-only
 * header from middleware would hide the nonce. In enforce mode the full
 * policy below replaces the static one (middleware headers win) and carries
 * the same frame-ancestors.
 */
function documentCsp(pathname: string): DocumentCsp {
  if (cspMode === 'off') return { responseHeaders: [] };
  const profile = cspProfileForPath(pathname);
  const nonce = profile === 'strict' ? generateNonce() : undefined;
  const policy = profile === 'strict' ? buildCsp({ ...cspBase, profile, nonce }) : cacheablePolicy;
  const headerName = cspMode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
  return {
    responseHeaders: [
      [headerName, policy],
      ...(reportingApi ? ([['Reporting-Endpoints', reportingEndpointsHeader(CSP_REPORT_PATH)]] as Array<[string, string]>) : []),
    ],
    requestHeader: nonce ? [headerName.toLowerCase(), policy] : undefined,
  };
}

/**
 * Catalogue landings with a meaningful query (/movies?genre=Action …) are
 * served from the ISR-cached /catalogue-variant route; the visitor's URL is
 * unchanged. Queries that normalise to the defaults fall through to the
 * cached bare landing. See src/lib/catalogue-variant.ts.
 */
function rewriteCatalogueVariant(
  request: NextRequest,
  init?: { request: { headers: Headers } },
): NextResponse | undefined {
  const { pathname, searchParams } = request.nextUrl;
  const section = pathname.replace(/^\/+|\/+$/g, '');
  if (!isCatalogueSection(section)) return undefined;

  const variant = encodeCatalogueVariant(section, searchParams);
  if (!variant) return undefined;

  const target = request.nextUrl.clone();
  target.pathname = `${CATALOGUE_VARIANT_PREFIX}/${section}/${variant}`;
  target.search = '';
  const response = NextResponse.rewrite(target, init);
  // The document is the same for every visitor (including local=1, whose
  // market is fetched after hydration). Preserve the public cache policy when
  // a self-hosted Next server treats an internal rewrite as dynamic.
  if (request.method === 'GET' || request.method === 'HEAD') {
    response.headers.set('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=600');
  }
  return response;
}

export const config = {
  // Skip static assets and internal API routes; every document request gets
  // tracking-parameter consolidation and the document CSP. API responses get
  // their own locked-down CSP from next.config.mjs.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon.svg|.*\\..*).*)'],
};
