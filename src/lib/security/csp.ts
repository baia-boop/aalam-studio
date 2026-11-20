import { THIRD_PARTY_SOURCES } from '@/lib/embed-sources';

/**
 * Content-Security-Policy for HTML documents (applied by src/middleware.ts).
 *
 * Two profiles, because Next.js can only stamp a per-request nonce on pages
 * that are rendered per request:
 *
 * - `strict` — routes rendered per request (admin, search, watch). Nonce + 'strict-dynamic': only scripts Next itself emits
 *   (stamped with this response's nonce) and what they load can run.
 *   Injected inline scripts and event-handler attributes are blocked.
 * - `cacheable` — ISR/CDN-cached public pages (home, catalogue, titles…). The
 *   same HTML is shared by every visitor, so a per-request nonce is
 *   impossible, and Next's inline bootstrap/RSC scripts change on every
 *   regeneration, so hashes are impractical. These pages render only TMDB
 *   data through React's escaping and reflect no request input. They allow
 *   inline scripts from 'self' only: no third-party script hosts, no eval
 *   (outside dev), and the same strict object/base/form/frame rules.
 *
 * Every other directive is shared and allow-lists exactly what the app loads:
 *   img     TMDB images, Pexels fallbacks, YouTube thumbnails
 *   connect first-party APIs + the Supabase project (https + realtime wss);
 *           TMDB only if a public key is baked into the client bundle
 *   frame   the retained embed players (embed-sources.ts) + youtube-nocookie
 *   media   Real-Debrid stream/transcode hosts (premium playback)
 *
 * Roll-out: CSP_MODE=report-only (the default) sends
 * Content-Security-Policy-Report-Only with reports to /api/csp-report
 * (report-uri; add the Reporting API with CSP_REPORTING_API=1). Review
 * the violations, then switch to CSP_MODE=enforce. See docs/security.md.
 */

export type CspMode = 'off' | 'report-only' | 'enforce';
export type CspProfile = 'strict' | 'cacheable';

export const CSP_REPORT_PATH = '/api/csp-report';
export const CSP_REPORT_GROUP = 'csp-endpoint';

/**
 * Path prefixes whose pages are `force-dynamic` (rendered per request, never
 * cached). Only these may use the nonce profile: a statically prerendered or
 * ISR page has no per-request nonce, so enforcing the strict profile there
 * would block Next's own scripts. tests/security-headers.test.cjs asserts
 * every prefix maps to a force-dynamic page. Statically rendered auth pages
 * (signin, profile, my-list…) use the cacheable profile.
 */
export const STRICT_CSP_PATH_PREFIXES = ['/admin', '/search', '/watch'] as const;

export function cspProfileForPath(pathname: string): CspProfile {
  return STRICT_CSP_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? 'strict'
    : 'cacheable';
}

export function readCspMode(raw: string | undefined): CspMode {
  const value = raw?.trim().toLowerCase();
  if (value === 'off' || value === 'enforce' || value === 'report-only') return value;
  return 'report-only';
}

/** 128-bit random nonce, base64 (edge + Node). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Static image hosts rendered by the UI. */
export const IMG_SOURCES = ['https://image.tmdb.org', 'https://images.pexels.com', 'https://i.ytimg.com'] as const;

export const TMDB_API_ORIGIN = 'https://api.themoviedb.org';

/** Real-Debrid direct download + transcode hosts (premium playback only). */
export const MEDIA_SOURCES = ['https://*.real-debrid.com', 'https://*.rdeb.io'] as const;

/**
 * Embed players retained in embed-sources.ts plus the trailer player.
 * `extraFrameOrigins` covers players that redirect between their own
 * subdomains (CSP checks each redirect target of the iframe navigation).
 */
export function frameSources(): string[] {
  const origins = new Set<string>(
    THIRD_PARTY_SOURCES.flatMap((source) => [source.frameOrigin, ...(source.extraFrameOrigins ?? [])])
  );
  origins.add('https://www.youtube-nocookie.com');
  return Array.from(origins).sort();
}

// A source token we are willing to accept from env: scheme-qualified host with
// an optional leading wildcard label and port, nothing else (no quotes, no
// keywords, no paths with spaces/semicolons).
const EXTRA_SOURCE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

/** Parses a space/comma separated env list of extra https origins. */
export function parseExtraSources(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim().replace(/\/+$/, ''))
    .filter((token) => EXTRA_SOURCE.test(token));
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export interface CspOptions {
  profile: CspProfile;
  /** Required for the strict profile. */
  nonce?: string;
  dev?: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL. */
  supabaseUrl?: string;
  /**
   * True only when NEXT_PUBLIC_TMDB_API_KEY is baked into the client bundle:
   * the browser then calls TMDB directly instead of the /api/tmdb proxy.
   */
  directTmdb?: boolean;
  /** AALAM_FRAME_ANCESTORS override (defaults to 'self'). */
  frameAncestors?: string;
  /** Adds upgrade-insecure-requests (only meaningful when enforced over https). */
  upgradeInsecureRequests?: boolean;
  extra?: Partial<Record<'img' | 'connect' | 'frame' | 'media', string[]>>;
  reportUri?: string;
  /**
   * Also emit `report-to` (Reporting API). Off by default: when report-to is
   * present Chrome ignores report-uri, and Reporting-API uploads could not be
   * verified end-to-end in CI, whereas report-uri delivery is. Enable with
   * CSP_REPORTING_API=1 after checking delivery on an HTTPS staging host.
   */
  reportTo?: boolean;
}

/** Validated frame-ancestors value: 'self', 'none', or https origins. */
export function normalizeFrameAncestors(raw: string | undefined): string {
  const tokens = (raw || '').trim().split(/\s+/).filter(Boolean);
  const valid = tokens.filter((token) => token === "'self'" || token === "'none'" || EXTRA_SOURCE.test(token));
  if (!valid.length) return "'self'";
  return valid.includes("'none'") ? "'none'" : valid.join(' ');
}

export function buildCsp(options: CspOptions): string {
  const { profile, nonce, dev = false, extra = {} } = options;
  if (profile === 'strict' && !nonce) throw new Error('The strict CSP profile needs a nonce');

  const supabase = originOf(options.supabaseUrl);
  const scriptSrc =
    profile === 'strict'
      ? // CSP3 browsers use the nonce + strict-dynamic and ignore the rest;
        // 'unsafe-inline' https: only keep very old browsers working.
        [`'nonce-${nonce}'`, "'strict-dynamic'", "'unsafe-inline'", 'https:']
      : ["'self'", "'unsafe-inline'"];
  if (dev) scriptSrc.push("'unsafe-eval'");

  const connectSrc = [
    "'self'",
    ...(supabase ? [supabase, supabase.replace(/^http/, 'ws')] : []),
    ...(options.directTmdb ? [TMDB_API_ORIGIN] : []),
    ...(extra.connect ?? []),
  ];
  if (dev) connectSrc.push('ws:', 'wss:');

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...IMG_SOURCES, ...(extra.img ?? [])]],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connectSrc],
    ['media-src', ["'self'", 'blob:', ...MEDIA_SOURCES, ...(extra.media ?? [])]],
    ['frame-src', [...frameSources(), ...(extra.frame ?? [])]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', [normalizeFrameAncestors(options.frameAncestors)]],
  ];
  if (options.upgradeInsecureRequests) directives.push(['upgrade-insecure-requests', []]);
  if (options.reportUri) {
    directives.push(['report-uri', [options.reportUri]]);
    if (options.reportTo) directives.push(['report-to', [CSP_REPORT_GROUP]]);
  }

  return directives
    .map(([name, values]) => (values.length ? `${name} ${Array.from(new Set(values)).join(' ')}` : name))
    .join('; ');
}

/** Reporting API endpoint declaration matching `report-to csp-endpoint`. */
export function reportingEndpointsHeader(reportUri: string): string {
  return `${CSP_REPORT_GROUP}="${reportUri}"`;
}
