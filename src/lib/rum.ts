/**
 * Real-user monitoring (RUM) contract shared by the browser reporter and the
 * /api/rum collector. Pure and dependency-free so it can be unit tested.
 *
 * Segmentation dimensions are deliberately coarse and low-cardinality:
 *   route   – the Next route *pattern* (/title/[type]/[id]), never a raw URL
 *   country – ISO-3166 alpha-2 from the CDN geo header (server side only)
 *   device  – mobile | tablet | desktop
 *   network – navigator.connection.effectiveType (4g/3g/2g/slow-2g) | unknown
 * No user id, IP, full URL or query string is ever collected.
 */

export const RUM_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type RumMetric = (typeof RUM_METRICS)[number];

export const RUM_DEVICES = ['mobile', 'tablet', 'desktop'] as const;
export type RumDevice = (typeof RUM_DEVICES)[number];

export const RUM_NETWORKS = ['4g', '3g', '2g', 'slow-2g', 'unknown'] as const;
export type RumNetwork = (typeof RUM_NETWORKS)[number];

export type RumRating = 'good' | 'needs-improvement' | 'poor';

/** Core Web Vitals thresholds (web.dev), [good ≤ a, poor > b]. */
export const RUM_THRESHOLDS: Record<RumMetric, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export interface RumVitalEvent {
  kind: 'vital';
  metric: RumMetric;
  value: number;
  rating: RumRating;
  route: string;
  device: RumDevice;
  network: RumNetwork;
  /** Navigation type from web-vitals (navigate, reload, back-forward, …). */
  nav?: string;
}

export interface RumErrorEvent {
  kind: 'error';
  /** 'boundary' = a route error boundary rendered; 'window' / 'promise' = uncaught. */
  source: 'boundary' | 'window' | 'promise';
  route: string;
  device: RumDevice;
  network: RumNetwork;
  /** Error class/name only (e.g. TypeError, ChunkLoadError). No message/stack. */
  name: string;
  digest?: string;
}

/**
 * Product-funnel engagement events (conversion experiments). These answer "did
 * the visitor act" where vitals answer "was it fast": hero Play/Info clicks,
 * quick-intent shortcuts, search, a Play on a saved card, a resume from
 * Continue Watching, list saves and successful playback starts. The allowlist
 * keeps cardinality bounded and every dimension stays coarse — no titles,
 * queries or user ids.
 */
export const RUM_ENGAGEMENT_NAMES = [
  'hero_play',
  'hero_info',
  'hero_trailer',
  'quick_intent',
  'genre_pick',
  'search_open',
  'search_submit',
  'card_play',
  'continue_resume',
  'save_toggle',
  'release_reminder',
  'playback_start',
  'play_start',
  'play_error',
  'search',
  'list_add',
] as const;
export type RumEngagementName = (typeof RUM_ENGAGEMENT_NAMES)[number];

export interface RumEngagementEvent {
  kind: 'engagement';
  name: RumEngagementName;
  /**
   * Bounded UI placement, e.g. 'home-hero', 'rail:trending-today', 'ott-bar';
   * `target` carries a low-cardinality qualifier (chip id, platform id,
   * 'add'/'remove', hero slot). Both are validated against a strict pattern.
   */
  surface?: string;
  target?: string;
  route: string;
  device: RumDevice;
  network: RumNetwork;
}

export type RumEvent = RumVitalEvent | RumErrorEvent | RumEngagementEvent;

export const RUM_MAX_EVENTS_PER_BATCH = 25;

export function rateMetric(metric: RumMetric, value: number): RumRating {
  const [good, poor] = RUM_THRESHOLDS[metric];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

const ROUTE_PATTERNS: Array<[RegExp, string]> = [
  [/^\/title\/[^/]+\/[^/]+\/?$/, '/title/[type]/[id]'],
  [/^\/watch\/[^/]+\/[^/]+\/?$/, '/watch/[type]/[id]'],
  [/^\/share\/[^/]+\/?$/, '/share/[id]'],
  [/^\/person\/[^/]+\/?$/, '/person/[id]'],
];

const KNOWN_STATIC_ROUTES = new Set([
  '/', '/movies', '/series', '/anime', '/documentaries', '/trending', '/search',
  '/browse', '/my-list', '/profile', '/signin', '/signup', '/forgot-password',
  '/update-password', '/admin', '/auth/callback', '/about', '/privacy', '/terms',
]);

/** Maps a pathname to a low-cardinality route label. */
export function rumRouteFromPath(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] || '/').replace(/\/{2,}/g, '/');
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const [pattern, label] of ROUTE_PATTERNS) {
    if (pattern.test(trimmed)) return label;
  }
  if (KNOWN_STATIC_ROUTES.has(trimmed)) return trimmed;
  return '/other';
}

export function classifyDevice(input: {
  width?: number;
  mobileHint?: boolean;
  userAgent?: string;
}): RumDevice {
  const ua = input.userAgent || '';
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (input.mobileHint || /Mobi|iPhone|iPod|Android.*Mobile/i.test(ua)) return 'mobile';
  const width = input.width ?? 1280;
  if (width < 768) return 'mobile';
  if (width < 1100 && /Macintosh/.test(ua) && 'ontouchend' in (globalThis as object)) return 'tablet';
  return 'desktop';
}

export function normalizeNetwork(effectiveType: unknown): RumNetwork {
  return typeof effectiveType === 'string' &&
    (RUM_NETWORKS as readonly string[]).includes(effectiveType)
    ? (effectiveType as RumNetwork)
    : 'unknown';
}

const has = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

const ROUTE_LABEL = /^\/[a-z0-9\-/[\]]{0,60}$/i;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;
/** Engagement surface/target qualifiers: bounded slugs, never free text. */
const ENGAGEMENT_QUALIFIER = /^[a-z0-9][a-z0-9:._/-]{0,47}$/i;

/** Strict server-side validation. Returns null for anything malformed. */
export function parseRumEvent(raw: unknown): RumEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const route = typeof value.route === 'string' && ROUTE_LABEL.test(value.route)
    ? rumRouteFromPath(value.route)
    : null;
  if (!route) return null;
  const device: RumDevice = has(RUM_DEVICES, value.device) ? value.device : 'desktop';
  const network = normalizeNetwork(value.network);

  if (value.kind === 'vital') {
    if (!has(RUM_METRICS, value.metric)) return null;
    const metricValue = Number(value.value);
    const max = value.metric === 'CLS' ? 10 : 120_000;
    if (!Number.isFinite(metricValue) || metricValue < 0 || metricValue > max) return null;
    const nav = typeof value.nav === 'string' && /^[a-z-]{1,24}$/.test(value.nav) ? value.nav : undefined;
    return {
      kind: 'vital',
      metric: value.metric,
      value: value.metric === 'CLS' ? Math.round(metricValue * 1000) / 1000 : Math.round(metricValue),
      rating: rateMetric(value.metric, metricValue),
      route,
      device,
      network,
      ...(nav ? { nav } : {}),
    };
  }

  if (value.kind === 'error') {
    if (!has(['boundary', 'window', 'promise'] as const, value.source)) return null;
    const name = typeof value.name === 'string' && ERROR_NAME.test(value.name) ? value.name : 'Error';
    const digest = typeof value.digest === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value.digest)
      ? value.digest
      : undefined;
    return { kind: 'error', source: value.source, route, device, network, name, ...(digest ? { digest } : {}) };
  }

  if (value.kind === 'engagement') {
    if (!has(RUM_ENGAGEMENT_NAMES, value.name)) return null;
    const productEvent = ['play_start', 'play_error', 'search', 'list_add'].includes(value.name);
    const surface =
      !productEvent && typeof value.surface === 'string' && ENGAGEMENT_QUALIFIER.test(value.surface)
        ? value.surface.toLowerCase()
        : undefined;
    const target =
      !productEvent && typeof value.target === 'string' && ENGAGEMENT_QUALIFIER.test(value.target)
        ? value.target.toLowerCase()
        : undefined;
    return {
      kind: 'engagement',
      name: value.name,
      ...(surface ? { surface } : {}),
      ...(target ? { target } : {}),
      route,
      device,
      network,
    };
  }

  return null;
}

export function parseRumBatch(raw: unknown): RumEvent[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { events?: unknown }).events)
      ? (raw as { events: unknown[] }).events
      : [];
  return list
    .slice(0, RUM_MAX_EVENTS_PER_BATCH)
    .map(parseRumEvent)
    .filter((event): event is RumEvent => event !== null);
}

/** Histogram bucket upper bounds used for p75 estimation in Redis. */
export const RUM_BUCKETS: Record<RumMetric, number[]> = {
  LCP: [1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000],
  INP: [50, 100, 150, 200, 300, 500, 1000],
  CLS: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5],
  FCP: [800, 1200, 1800, 2400, 3000, 5000],
  TTFB: [200, 400, 800, 1200, 1800, 3000],
};

export function rumBucket(metric: RumMetric, value: number): string {
  const bound = RUM_BUCKETS[metric].find((limit) => value <= limit);
  return bound === undefined ? 'inf' : String(bound);
}

/**
 * Redis aggregation commands for one event: a per-day hash per segment with
 * counters by rating and histogram bucket (enough for p75 + good-share
 * dashboards without storing individual samples).
 */
export function rumAggregationCommands(
  event: RumEvent,
  country: string,
  day: string,
  ttlSeconds = 35 * 24 * 60 * 60
): Array<Array<string | number>> {
  const segment = `${event.route}|${country}|${event.device}|${event.network}`;
  if (event.kind === 'vital') {
    const key = `rum:v1:${day}:${event.metric}`;
    return [
      ['HINCRBY', key, `${segment}|n`, 1],
      ['HINCRBY', key, `${segment}|${event.rating}`, 1],
      ['HINCRBY', key, `${segment}|b:${rumBucket(event.metric, event.value)}`, 1],
      ['EXPIRE', key, ttlSeconds],
    ];
  }
  const key = `rum:v1:${day}:errors`;
  if (event.kind === 'error') {
    return [
      ['HINCRBY', key, `${segment}|${event.source}|${event.name}`, 1],
      ['EXPIRE', key, ttlSeconds],
    ];
  }
  // Engagement: one counter per name × surface × target × segment. Totals per
  // name give the funnel, surface/target split it (e.g. hero slot, provider).
  const engagementKey = `rum:v1:${day}:engagement`;
  const qualifier = `${event.name}|${event.surface || '-'}|${event.target || '-'}`;
  return [
    ['HINCRBY', engagementKey, `${qualifier}|${segment}`, 1],
    ['HINCRBY', engagementKey, `${qualifier}|n`, 1],
    ['EXPIRE', engagementKey, ttlSeconds],
  ];
}
