import { apiRoute, json } from '@/server/core/api';
import { logger } from '@/server/core/logger';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { isRedisConfigured, redisPipeline } from '@/server/cache/redis';
import { GEO_COUNTRY_HEADERS } from '@/lib/geo-country';
import { parseRumBatch, rumAggregationCommands } from '@/lib/rum';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Country from the trusted CDN geo header only (never Accept-Language). */
function rumCountry(headers: Headers): string {
  for (const name of GEO_COUNTRY_HEADERS) {
    const value = headers.get(name)?.trim().toUpperCase();
    if (value && /^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1') return value;
  }
  return 'ZZ';
}

/**
 * Web Vitals / route-error beacon collector (see docs/performance.md).
 * Every accepted event is written as one structured log line (`rum` message,
 * ready for a log drain) and, when Upstash Redis is configured, aggregated
 * into per-day histograms segmented by route × country × device × network.
 */
export const POST = apiRoute(
  { name: 'rum', rateLimit: RATE_LIMITS.rum },
  async (ctx) => {
    const events = parseRumBatch(await ctx.readJson(16 * 1024));
    if (events.length === 0) return new Response(null, { status: 204 });

    const country = rumCountry(ctx.req.headers);
    for (const event of events) logger.info('rum', { ...event, country });

    if (isRedisConfigured()) {
      const day = new Date().toISOString().slice(0, 10);
      const commands = events.flatMap((event) => rumAggregationCommands(event, country, day));
      await redisPipeline(commands).catch(() => undefined);
    }

    return json({ accepted: events.length }, { status: 202 });
  }
);
