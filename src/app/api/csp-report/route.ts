import { apiRoute } from '@/server/core/api';
import { logger } from '@/server/core/logger';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { isRedisConfigured, redisPipeline } from '@/server/cache/redis';
import {
  CSP_REPORT_CONTENT_TYPES,
  CSP_REPORT_MAX_BYTES,
  cspAggregationCommands,
  parseCspReports,
} from '@/lib/security/csp-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * CSP violation collector for the report-only roll-out (docs/security.md).
 *
 * Public by necessity (browsers post here), so it is rate-limited per IP,
 * cross-site posts are refused by apiRoute, bodies are capped at 16 KB with
 * a content-type allow-list, and reports are reduced to sanitised records
 * (no query strings, bounded strings) before being logged as `csp-violation`
 * lines and counted per day in Redis (`HGETALL csp:v1:YYYY-MM-DD`).
 * Always answers 204 for accepted input so browsers do not retry.
 */
export const POST = apiRoute({ name: 'csp-report', rateLimit: RATE_LIMITS.cspReport }, async (ctx) => {
  const violations = parseCspReports(await ctx.readJson(CSP_REPORT_MAX_BYTES, CSP_REPORT_CONTENT_TYPES));
  if (violations.length > 0) {
    for (const violation of violations) logger.warn('csp-violation', { ...violation });
    if (isRedisConfigured()) {
      const day = new Date().toISOString().slice(0, 10);
      await redisPipeline(violations.flatMap((violation) => cspAggregationCommands(violation, day))).catch(
        () => undefined
      );
    }
  }
  return new Response(null, { status: 204 });
});
