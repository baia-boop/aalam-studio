import { getConfig } from '../core/config';
import { logger } from '../core/logger';
import { Semaphore, TokenBucket, sleep } from '../core/concurrency';
import { cacheDelete, getOrSet, type CacheStatus } from '../cache';
import { ttlForTmdbPath } from './policy';

/**
 * The single way the server talks to TMDB.
 *
 *  - server-held key only (v3 key as query param, v4 token as bearer);
 *  - global concurrency cap + token-bucket pacing below TMDB's per-IP limit;
 *    only real network calls are paced, cache hits never wait;
 *  - per-attempt timeout; retries with exponential backoff + jitter on
 *    network errors, timeouts, 5xx and 429 (honouring Retry-After);
 *  - normalised cache keys, per-endpoint TTLs, stale-while-revalidate,
 *    single-flight de-duplication and short negative caching of 404s.
 */

export class TmdbError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) {
    super(message);
    this.name = 'TmdbError';
  }
}

interface NotFoundMarker {
  __tmdbNotFound: true;
}

const stats = {
  requests: 0,
  upstreamCalls: 0,
  retries: 0,
  rateLimited: 0,
  timeouts: 0,
  errors: 0,
  notFound: 0,
  totalUpstreamMs: 0,
};

let semaphore: Semaphore | null = null;
let bucket: TokenBucket | null = null;

function limiter() {
  if (!semaphore || !bucket) {
    const { maxConcurrent, requestsPerSecond } = getConfig().tmdb;
    semaphore = new Semaphore(maxConcurrent);
    bucket = new TokenBucket(requestsPerSecond, requestsPerSecond);
  }
  return { semaphore, bucket };
}

export function isTmdbConfigured(): boolean {
  return Boolean(getConfig().tmdb.key);
}

export function normalizeTmdbPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function tmdbCacheKey(path: string, params: Record<string, string | number | undefined>): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `tmdb:v1:${normalizeTmdbPath(path)}?${query}`;
}

/** Honour numeric and HTTP-date forms without spending the request budget
 * waiting out a long upstream cooldown. */
function retryAfterSec(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header.trim()) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) ? Math.max(0, seconds) : undefined;
}

function retryDelayMs(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return retryAfter * 1000;
  const base = 250 * 2 ** attempt;
  return Math.min(4000, base + Math.random() * base * 0.3);
}

async function fetchUpstream<T>(path: string, params: Record<string, string>): Promise<T | NotFoundMarker> {
  const { key, baseUrl, timeoutMs, retries } = getConfig().tmdb;
  if (!key) throw new TmdbError(503, 'TMDB is not configured on the server');

  const url = new URL(`${baseUrl}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key.startsWith('eyJ') || key.length > 60) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  const { semaphore: sem, bucket: tokens } = limiter();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) stats.retries += 1;
    const started = performance.now();
    let res: Response;
    try {
      res = await sem.run(async () => {
        await tokens.take();
        stats.upstreamCalls += 1;
        return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      });
    } catch (error) {
      // Network failure or per-attempt timeout: retryable.
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) stats.timeouts += 1;
      lastError = error;
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      break;
    }
    stats.totalUpstreamMs += performance.now() - started;

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch {
        lastError = new TmdbError(502, 'TMDB returned an unreadable response');
        break;
      }
    }
    if (res.status === 404) {
      stats.notFound += 1;
      return { __tmdbNotFound: true };
    }
    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) stats.rateLimited += 1;
      const retryAfter = retryAfterSec(res.headers.get('retry-after'));
      lastError = new TmdbError(res.status === 429 ? 429 : 502, `TMDB upstream status ${res.status}`, retryAfter);
      void res.body?.cancel().catch(() => {});
      const delay = retryDelayMs(attempt, retryAfter);
      if (attempt < retries && delay <= 4000) {
        await sleep(delay);
        continue;
      }
      break;
    }
    // Other 4xx are configuration/caller errors; retrying cannot help.
    stats.errors += 1;
    throw new TmdbError(res.status === 401 ? 503 : 400, `TMDB rejected the request (${res.status})`);
  }

  stats.errors += 1;
  logger.warn('TMDB request failed', { path, error: lastError });
  if (lastError instanceof TmdbError) throw lastError;
  throw new TmdbError(504, 'TMDB did not respond in time');
}

export interface TmdbResult<T> {
  data: T;
  cache: CacheStatus;
}

/**
 * Cached GET. Throws TmdbError(404) for missing titles, TmdbError(503) when
 * no key is configured, and TmdbError(429/502/504) when TMDB is unavailable.
 */
export async function tmdbGet<T = unknown>(
  rawPath: string,
  params: Record<string, string | number | undefined> = {},
  options: {
    ttl?: number;
    /** A malformed HTTP 200 must not be cached as a successful list. */
    validate?: (value: unknown) => boolean;
    /**
     * false = skip the shared response cache (still paced, retried and
     * limited). For bulk scans such as sitemap generation, which would
     * otherwise evict hot user-facing entries from the bounded L1 cache;
     * callers cache their own compact result instead.
     */
    cache?: boolean;
  } = {}
): Promise<TmdbResult<T>> {
  stats.requests += 1;
  const path = normalizeTmdbPath(rawPath);
  const cleanParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') cleanParams[k] = String(v);

  const notFound = (value: T | NotFoundMarker): value is NotFoundMarker => Boolean(
    value && typeof value === 'object' && '__tmdbNotFound' in value
  );
  const valid = (value: T | NotFoundMarker) => notFound(value) || !options.validate || options.validate(value);
  const load = async () => {
    const value = await fetchUpstream<T>(path, cleanParams);
    if (!valid(value)) throw new TmdbError(502, 'TMDB returned an invalid response');
    return value;
  };
  const key = tmdbCacheKey(path, cleanParams);
  const ttl = options.ttl ?? ttlForTmdbPath(path);
  const { value, status } = options.cache === false
    ? { value: await load(), status: 'MISS' as const }
    : await getOrSet(key, load, { ttl, swr: ttl * 4 });
  if (notFound(value)) throw new TmdbError(404, 'Not found on TMDB');
  // A legacy consumer of this cache key may not have asked for validation.
  if (!valid(value)) {
    await cacheDelete([key]);
    throw new TmdbError(502, 'TMDB returned an invalid response');
  }
  return { data: value as T, cache: status };
}

/** Like tmdbGet, but resolves to null instead of throwing. For fan-out sources. */
export async function tmdbTry<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T | null> {
  try {
    return (await tmdbGet<T>(path, params)).data;
  } catch {
    return null;
  }
}

export function getTmdbStats() {
  const { semaphore: sem } = limiter();
  return {
    configured: isTmdbConfigured(),
    ...stats,
    avgUpstreamMs: stats.upstreamCalls ? Math.round(stats.totalUpstreamMs / stats.upstreamCalls) : 0,
    inFlight: sem.running,
    queued: sem.pending,
  };
}

export function resetTmdbForTests() {
  semaphore = null;
  bucket = null;
  for (const key of Object.keys(stats) as Array<keyof typeof stats>) stats[key] = 0;
}
