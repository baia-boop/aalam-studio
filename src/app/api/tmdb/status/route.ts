import { apiRoute } from '@/server/core/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { isTmdbConfigured } from '@/server/tmdb/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tells the browser whether it can use the server catalogue proxy. The answer
 * is identical for every visitor, so it is CDN-cacheable; the catalogue limit
 * still bounds uncached floods per IP.
 */
export const GET = apiRoute(
  {
    name: 'tmdb-status',
    rateLimit: RATE_LIMITS.catalogue,
    cacheControl: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  },
  async () => ({ hasServerKey: isTmdbConfigured() })
);
