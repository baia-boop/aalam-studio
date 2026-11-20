import { isRedisConfigured, redisPipeline } from '../cache/redis';
import { getConfig } from '../core/config';
import { logger } from '../core/logger';

/**
 * Sliding-window-counter rate limiter.
 *
 * Counts requests in the current fixed window and weights the previous
 * window by how much of it still overlaps the sliding window. This avoids the
 * fixed-window "double burst" at boundaries while needing only two counters.
 *
 * Uses Redis when configured (shared across instances), otherwise a bounded
 * in-memory map (per instance). A Redis failure falls back to memory rather
 * than failing open or closed for every request.
 */

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
  store: 'redis' | 'memory';
}

export const RATE_LIMITS = {
  /** Catalogue proxy: a home page render fans out into ~20 calls. */
  catalogue: { name: 'catalogue', limit: 900, windowSeconds: 60 },
  recommendations: { name: 'recs', limit: 60, windowSeconds: 60 },
  search: { name: 'search', limit: 120, windowSeconds: 60 },
  suggest: { name: 'suggest', limit: 300, windowSeconds: 60 },
  interactions: { name: 'events', limit: 120, windowSeconds: 60 },
  destructive: { name: 'destructive', limit: 10, windowSeconds: 600 },
  admin: { name: 'admin', limit: 60, windowSeconds: 60 },
  /**
   * Admin password sign-in: the only credential-guessing surface. Shared via
   * Redis so the budget is per client, not per replica, and bounded by the
   * same memory cap as every other limit when Redis is absent.
   */
  adminLogin: { name: 'admin-login', limit: 8, windowSeconds: 60 },
  /** Torrentio stream lists (cached server-side per title/episode). */
  streams: { name: 'streams', limit: 60, windowSeconds: 60 },
  /** Real-Debrid relay: resolving polls while a torrent is prepared. */
  debrid: { name: 'debrid', limit: 90, windowSeconds: 60 },
  /** Web Vitals / error beacons: a few per page view, batched. */
  rum: { name: 'rum', limit: 120, windowSeconds: 60 },
  /** CSP violation reports (browsers batch them; extra reports are dropped). */
  cspReport: { name: 'csp', limit: 60, windowSeconds: 60 },
  /** Cheap unauthenticated status probes (admin logout, catalogue status). */
  status: { name: 'status', limit: 30, windowSeconds: 60 },
} satisfies Record<string, RateLimitPolicy>;

interface Counter {
  window: number;
  current: number;
  previous: number;
}

const MAX_MEMORY_KEYS = 20_000;
const memory = new Map<string, Counter>();
let blocked = 0;
let memoryFallbacks = 0;
let lastStore: RateLimitResult['store'] = 'memory';
let warnedPerInstance = false;

/**
 * The in-memory fallback is per process, so with N replicas the effective
 * global limit is `limit × N` — 8 admin sign-in attempts become 8 per replica.
 * That is a deliberate availability trade, but it must not be silent: say so
 * once per process, in production, the first time it happens.
 */
function noteMemoryFallback(): void {
  memoryFallbacks += 1;
  lastStore = 'memory';
  if (warnedPerInstance) return;
  warnedPerInstance = true;
  if (!getConfig().isProduction) return;
  logger.warn('Rate limits are per-instance: the effective global limit is the configured limit times the replica count', {
    reason: isRedisConfigured() ? 'Redis is configured but currently unavailable' : 'Redis is not configured',
    hint: 'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for one budget shared across replicas.',
  });
}

function computeResult(
  policy: RateLimitPolicy,
  current: number,
  previous: number,
  now: number,
  store: RateLimitResult['store']
): RateLimitResult {
  const windowMs = policy.windowSeconds * 1000;
  const elapsed = (now % windowMs) / windowMs;
  const weighted = previous * (1 - elapsed) + current;
  const allowed = weighted <= policy.limit;
  if (!allowed) blocked += 1;
  return {
    allowed,
    limit: policy.limit,
    remaining: Math.max(0, Math.floor(policy.limit - weighted)),
    resetSeconds: Math.ceil((windowMs - (now % windowMs)) / 1000),
    store,
  };
}

function memoryHit(policy: RateLimitPolicy, key: string, now: number): RateLimitResult {
  const window = Math.floor(now / (policy.windowSeconds * 1000));
  const id = `${policy.name}:${key}`;
  let counter = memory.get(id);
  if (!counter) {
    counter = { window, current: 0, previous: 0 };
  } else if (counter.window !== window) {
    counter = { window, previous: counter.window === window - 1 ? counter.current : 0, current: 0 };
  }
  counter.current += 1;
  memory.delete(id);
  memory.set(id, counter);
  if (memory.size > MAX_MEMORY_KEYS) {
    // Oldest-touched keys first; they are the least likely to be active.
    const excess = memory.size - MAX_MEMORY_KEYS;
    let i = 0;
    for (const k of memory.keys()) {
      if (i++ >= excess) break;
      memory.delete(k);
    }
  }
  noteMemoryFallback();
  return computeResult(policy, counter.current, counter.previous, now, 'memory');
}

export async function rateLimit(policy: RateLimitPolicy, key: string, now = Date.now()): Promise<RateLimitResult> {
  const window = Math.floor(now / (policy.windowSeconds * 1000));
  const base = `rl:${policy.name}:${key}`;
  const result = await redisPipeline([
    ['INCR', `${base}:${window}`],
    ['EXPIRE', `${base}:${window}`, policy.windowSeconds * 2],
    ['GET', `${base}:${window - 1}`],
  ]);
  if (result && typeof result[0] === 'number') {
    lastStore = 'redis';
    return computeResult(policy, result[0], Number(result[2] || 0), now, 'redis');
  }
  return memoryHit(policy, key, now);
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.resetSeconds),
  };
}

/**
 * `store` distinguishes a genuinely shared budget from a per-instance one:
 * `memory` (Redis not configured), `redis` (shared), or `degraded` (Redis is
 * configured but the last request fell back to memory). Only `redis` means the
 * configured limit is the real global limit.
 */
export function getRateLimitStats() {
  const store = isRedisConfigured() ? (lastStore === 'redis' ? 'redis' : 'degraded') : 'memory';
  return { store, shared: store === 'redis', memoryKeys: memory.size, memoryFallbacks, blocked };
}

export function resetRateLimitsForTests() {
  memory.clear();
  blocked = 0;
  memoryFallbacks = 0;
  lastStore = 'memory';
  warnedPerInstance = false;
}
