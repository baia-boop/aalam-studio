import { apiRoute, json } from '@/server/core/api';
import { ApiError } from '@/server/core/errors';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { isAllowedTmdbPath, sanitizeTmdbParams, ttlForTmdbPath } from '@/server/tmdb/policy';
import { tmdbGet } from '@/server/tmdb/gateway';

/**
 * Read-only TMDB catalogue proxy used by the browser when no client key is set.
 *
 * Unlike the previous pass-through, it only serves allow-listed endpoints and
 * parameters, never accepts a caller-supplied key, rate-limits per client,
 * and answers from a shared cache with stale-while-revalidate, single-flight
 * de-duplication, timeouts and retries (see `src/server/tmdb`).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEGMENT = /^[A-Za-z0-9_-]{1,40}$/;

export const GET = apiRoute<{ path: string[] }>(
  { name: 'tmdb-proxy', rateLimit: RATE_LIMITS.catalogue },
  async ({ params, url, mark }) => {
    const segments = Array.isArray(params.path) ? params.path : [];
    if (!segments.length || segments.length > 6 || !segments.every((s) => SEGMENT.test(s))) {
      throw new ApiError(404, 'ENDPOINT_NOT_ALLOWED', 'This catalogue endpoint is not available.');
    }
    const path = segments.join('/');
    if (!isAllowedTmdbPath(path)) {
      throw new ApiError(404, 'ENDPOINT_NOT_ALLOWED', 'This catalogue endpoint is not available.');
    }
    const query = sanitizeTmdbParams(path, url.searchParams);

    const started = performance.now();
    const { data, cache } = await tmdbGet(path, query);
    mark('tmdb', started);

    const ttl = ttlForTmdbPath(path);
    const browserTtl = Math.min(ttl, 300);
    return json(data, {
      headers: {
        'Cache-Control': `public, max-age=${browserTtl}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
        'X-Cache': cache,
      },
    });
  }
);
