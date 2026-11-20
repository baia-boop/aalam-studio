import 'server-only';
import { TMDB_ALLOWED_HOSTS, resolveTmdbBaseUrl } from '@/lib/tmdb-base-url';
import { DEFAULT_TORRENTIO_BASE_URL, DEFAULT_TORRENTIO_OPTIONS, sanitizeTorrentioOptions } from '@/lib/torrentio';

/**
 * Server configuration, read once per process.
 *
 * Every value here is server-only. Nothing in this module may be imported by
 * client components: the TMDB key and Redis token must never reach a bundle.
 */

function clean(value: string | undefined): string {
  return (value || '').trim().replace(/^["']|["']$/g, '');
}

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export { TMDB_ALLOWED_HOSTS, resolveTmdbBaseUrl };

export interface ServerConfig {
  nodeEnv: string;
  isProduction: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  tmdb: {
    key: string;
    baseUrl: string;
    timeoutMs: number;
    maxConcurrent: number;
    requestsPerSecond: number;
    retries: number;
  };
  supabase: { url: string; publicKey: string };
  redis: { url: string; token: string; timeoutMs: number };
  allowedOrigins: string[];
  /** Which inbound headers may be trusted to identify the client. */
  proxy: {
    /**
     * How many trusted proxies append to X-Forwarded-For. 0 means "no proxy
     * in front", so no forwarded header is read at all.
     */
    hops: number;
    /** A header the platform overwrites rather than appends, or '' for none. */
    header: string;
  };
  engine: { sourceTimeoutMs: number; pipelineBudgetMs: number };
  debrid: {
    /** Torrentio stream discovery + Real-Debrid playback (NEXT_PUBLIC_DEBRID_PLAYBACK). */
    enabled: boolean;
    torrentioBaseUrl: string;
    torrentioOptions: string;
    torrentioTimeoutMs: number;
    realDebridTimeoutMs: number;
  };
}

/**
 * Torrentio may receive AALAM's Real-Debrid service token, so it must be https.
 * Self-hosted instances/mirrors are allowed; loopback only outside production.
 */
export function resolveTorrentioBaseUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  const configured = clean(raw);
  if (!configured) return DEFAULT_TORRENTIO_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('TORRENTIO_BASE_URL is not a valid URL');
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (isLoopback && nodeEnv !== 'production') return configured.replace(/\/+$/, '');
  if (parsed.protocol !== 'https:') throw new Error('TORRENTIO_BASE_URL must use https');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('TORRENTIO_BASE_URL must not contain credentials, a query or a fragment');
  }
  return configured.replace(/\/+$/, '');
}

export function isDebridPlaybackEnabled(raw: string | undefined): boolean {
  return !['false', '0', 'off', 'no'].includes(clean(raw).toLowerCase());
}

/** Header names only: letters, digits and hyphens, as a header token allows. */
export function normalizeProxyHeader(raw: string | undefined): string {
  const value = clean(raw).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : '';
}

let cached: ServerConfig | null = null;

export function getConfig(): ServerConfig {
  if (cached) return cached;
  const env = process.env;
  const nodeEnv = env.NODE_ENV || 'development';
  const level = clean(env.AALAM_LOG_LEVEL).toLowerCase();
  cached = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    logLevel: (['debug', 'info', 'warn', 'error'] as const).find((l) => l === level) || (nodeEnv === 'production' ? 'info' : 'debug'),
    tmdb: {
      // Server-only key first; the public key still works for small deployments.
      key: clean(env.TMDB_API_KEY) || clean(env.NEXT_PUBLIC_TMDB_API_KEY),
      baseUrl: resolveTmdbBaseUrl(env.TMDB_BASE_URL, nodeEnv, { allowLoopback: env.TMDB_ALLOW_LOOPBACK === '1' }),
      timeoutMs: intFrom(env.TMDB_TIMEOUT_MS, 6000, 500, 30000),
      maxConcurrent: intFrom(env.TMDB_MAX_CONCURRENT, 16, 1, 64),
      // TMDB tolerates ~50 req/s per IP; stay comfortably under it.
      requestsPerSecond: intFrom(env.TMDB_REQUESTS_PER_SECOND, 35, 1, 50),
      retries: intFrom(env.TMDB_RETRIES, 2, 0, 5),
    },
    supabase: {
      url: clean(env.NEXT_PUBLIC_SUPABASE_URL),
      publicKey: clean(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) || clean(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    },
    redis: {
      url: clean(env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, ''),
      token: clean(env.UPSTASH_REDIS_REST_TOKEN),
      timeoutMs: intFrom(env.REDIS_TIMEOUT_MS, 350, 50, 5000),
    },
    allowedOrigins: clean(env.API_ALLOWED_ORIGINS)
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    proxy: {
      // Default 1: the near-universal single edge proxy. The client address is
      // then the entry that proxy appended itself, so a client cannot pick its
      // own value. Deployments with no proxy must set TRUSTED_PROXY_HOPS=0.
      hops: intFrom(env.TRUSTED_PROXY_HOPS, 1, 0, 10),
      header: normalizeProxyHeader(env.TRUSTED_PROXY_HEADER),
    },
    engine: {
      sourceTimeoutMs: intFrom(env.CINEMATCH_SOURCE_TIMEOUT_MS, 2500, 200, 10000),
      pipelineBudgetMs: intFrom(env.CINEMATCH_PIPELINE_BUDGET_MS, 6000, 1000, 20000),
    },
    debrid: {
      enabled: isDebridPlaybackEnabled(env.NEXT_PUBLIC_DEBRID_PLAYBACK),
      torrentioBaseUrl: resolveTorrentioBaseUrl(env.TORRENTIO_BASE_URL, nodeEnv),
      torrentioOptions: env.TORRENTIO_OPTIONS === undefined
        ? DEFAULT_TORRENTIO_OPTIONS
        : sanitizeTorrentioOptions(clean(env.TORRENTIO_OPTIONS)),
      torrentioTimeoutMs: intFrom(env.TORRENTIO_TIMEOUT_MS, 9000, 1000, 30000),
      realDebridTimeoutMs: intFrom(env.REALDEBRID_TIMEOUT_MS, 10000, 1000, 30000),
    },
  };
  return cached;
}

/** Tests change env between cases; production never calls this. */
export function resetConfigForTests(): void {
  cached = null;
}
