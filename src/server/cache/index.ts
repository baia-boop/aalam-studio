import { LruCache } from './lru';
import { redisDel, redisGet, redisSet, getRedisStatus } from './redis';
import { SingleFlight } from '../core/concurrency';
import { logger } from '../core/logger';

/**
 * Two-tier cache.
 *
 *  L1 — per-instance LRU (sub-millisecond, bounded memory).
 *  L2 — optional Redis shared across instances / cold starts.
 *
 * `getOrSet` adds the two behaviours that matter under load:
 *  - single-flight: concurrent misses for a key share one loader call;
 *  - stale-while-revalidate: an expired value is served immediately while one
 *    background refresh runs, so users never wait on an upstream refresh.
 */

const l1 = new LruCache<unknown>(Number(process.env.AALAM_L1_CACHE_ENTRIES) || 5000);
const flights = new SingleFlight();
const refreshes = new SingleFlight();
let backgroundRefreshFailures = 0;

interface L2Envelope<T> {
  v: T;
  /** Fresh-until timestamp in ms; L2 TTL itself covers the stale window. */
  f: number;
}

export interface CacheOptions {
  /** Seconds a value is fresh. */
  ttl: number;
  /** Extra seconds a value may be served stale while refreshing. */
  swr?: number;
  /** Store in Redis as well (default true). Disable for per-user or huge values. */
  shared?: boolean;
  /** Return false to skip caching a loaded value (e.g. empty upstream results). */
  cacheIf?: (value: unknown) => boolean;
}

export type CacheStatus = 'HIT' | 'STALE' | 'MISS';

async function readL2<T>(key: string): Promise<{ value: T; fresh: boolean } | undefined> {
  const raw = await redisGet(key);
  if (!raw) return undefined;
  try {
    const envelope = JSON.parse(raw) as L2Envelope<T>;
    return { value: envelope.v, fresh: envelope.f > Date.now() };
  } catch {
    return undefined;
  }
}

function writeAll<T>(key: string, value: T, options: CacheOptions) {
  const swr = options.swr ?? 0;
  l1.set(key, value, options.ttl, swr);
  if (options.shared !== false) {
    const envelope: L2Envelope<T> = { v: value, f: Date.now() + options.ttl * 1000 };
    void redisSet(key, JSON.stringify(envelope), options.ttl + swr);
  }
}

async function load<T>(key: string, loader: () => Promise<T>, options: CacheOptions): Promise<T> {
  const value = await loader();
  if (!options.cacheIf || options.cacheIf(value)) writeAll(key, value, options);
  return value;
}

function refreshInBackground<T>(key: string, loader: () => Promise<T>, options: CacheOptions) {
  void refreshes
    .do(key, () => load(key, loader, options))
    .catch((error) => {
      backgroundRefreshFailures += 1;
      logger.warn('Background cache refresh failed; serving stale value', { key: key.slice(0, 120), error });
    });
}

export async function getOrSet<T>(
  key: string,
  loader: () => Promise<T>,
  options: CacheOptions
): Promise<{ value: T; status: CacheStatus }> {
  const local = l1.peek(key);
  if (local) {
    if (!local.fresh) refreshInBackground(key, loader, options);
    return { value: local.value as T, status: local.fresh ? 'HIT' : 'STALE' };
  }

  if (options.shared !== false) {
    const shared = await readL2<T>(key);
    if (shared) {
      // Remaining freshness is unknown precisely; a short L1 copy is enough.
      l1.set(key, shared.value, shared.fresh ? Math.min(options.ttl, 60) : 1, options.swr ?? 0);
      if (!shared.fresh) refreshInBackground(key, loader, options);
      return { value: shared.value, status: shared.fresh ? 'HIT' : 'STALE' };
    }
  }

  const value = await flights.do(key, () => load(key, loader, options));
  return { value, status: 'MISS' };
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const local = l1.peek(key);
  if (local?.fresh) return local.value as T;
  const shared = await readL2<T>(key);
  return shared?.fresh ? shared.value : undefined;
}

export function cacheSet<T>(key: string, value: T, options: CacheOptions): void {
  writeAll(key, value, options);
}

export async function cacheDelete(keys: string[]): Promise<void> {
  for (const key of keys) l1.delete(key);
  await redisDel(keys);
}

/** Local-only prefix invalidation (Redis keys expire on their own short TTLs). */
export function cacheDeleteLocalPrefix(prefix: string): number {
  return l1.deletePrefix(prefix);
}

export function getCacheStats() {
  return {
    l1: l1.stats(),
    l2: getRedisStatus(),
    inFlightLoads: flights.size,
    backgroundRefreshFailures,
  };
}

export function clearCacheForTests() {
  l1.clear();
  backgroundRefreshFailures = 0;
}
