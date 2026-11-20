import { ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from '@/lib/admin-auth';
import { getTmdbResponseCacheStats } from '@/lib/tmdb';
import { apiRoute } from '@/server/core/api';
import { getCacheStats } from '@/server/cache';
import { getRedisStatus } from '@/server/cache/redis';
import { isAuthConfigured } from '@/server/auth/session';
import { getEngineStats } from '@/server/cinematch/pipeline';
import { getSuggestIndexStats } from '@/server/search/service';
import { getRateLimitStats, RATE_LIMITS } from '@/server/security/rate-limit';
import { getTmdbStats, isTmdbConfigured } from '@/server/tmdb/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const startedAt = Date.now();

/**
 * Liveness + readiness. Public callers get a minimal status (safe for uptime
 * monitors); a signed-in admin also gets cache, upstream and engine metrics.
 *
 * Next's `cookies()` is not usable here: this handler is invoked with a plain
 * `Request`, and `cookies()` throws outside a Next request scope. The header is
 * parsed by hand instead — and defensively, because anyone can send a cookie
 * and this endpoint must never be the thing an uptime monitor reports as down.
 */
function adminCookie(header: string | null): string | undefined {
  for (const part of (header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
    const raw = part.slice(separator + 1).trim();
    // A malformed escape sequence makes decodeURIComponent throw a URIError.
    // Hand the raw value on instead: verifyAdminSessionToken rejects anything
    // that is not a correctly signed token.
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export const GET = apiRoute({ name: 'health', rateLimit: RATE_LIMITS.admin }, async ({ req }) => {
  const redis = getRedisStatus();
  const checks = {
    catalogue: isTmdbConfigured() ? 'ok' : 'not_configured',
    accounts: isAuthConfigured() ? 'ok' : 'not_configured',
    sharedCache: redis.configured ? (redis.circuitOpen ? 'degraded' : 'ok') : 'memory_only',
  };
  const status = checks.catalogue === 'ok' ? (checks.sharedCache === 'degraded' ? 'degraded' : 'ok') : 'degraded';
  const body: Record<string, unknown> = {
    status,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    checks,
    time: new Date().toISOString(),
  };
  if (verifyAdminSessionToken(adminCookie(req.headers.get('cookie')))) {
    body.metrics = {
      tmdb: getTmdbStats(),
      tmdbResponseCache: getTmdbResponseCacheStats(),
      cache: getCacheStats(),
      redis,
      rateLimit: getRateLimitStats(),
      cinematch: getEngineStats(),
      suggestIndex: getSuggestIndexStats(),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    };
  }
  return body;
});
