import { apiRoute } from '@/server/core/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { resolveRequestCountry } from '@/lib/geo-country';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns a coarse country only. The app deliberately relies on a trusted CDN
 * country header instead of forwarding a raw visitor IP to a geo-IP vendor.
 */
export const GET = apiRoute(
  {
    name: 'geo-country',
    rateLimit: RATE_LIMITS.catalogue,
    cacheControl: 'private, no-store',
  },
  async (ctx) => resolveRequestCountry(ctx.req.headers)
);
