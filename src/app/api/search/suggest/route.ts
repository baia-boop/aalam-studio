import { apiRoute, json } from '@/server/core/api';
import { badRequest } from '@/server/core/errors';
import { parseEnum, parseIntParam } from '@/server/core/validate';
import { suggestTitles } from '@/server/search/service';
import { RATE_LIMITS } from '@/server/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/search/suggest?q=&type=&limit= — as-you-type title suggestions. */
export const GET = apiRoute({ name: 'suggest', rateLimit: RATE_LIMITS.suggest }, async ({ url }) => {
  const q = url.searchParams.get('q') ?? '';
  if (q.length > 80) throw badRequest('q must be at most 80 characters');
  const type = parseEnum(url.searchParams.get('type') ?? undefined, ['all', 'movie', 'tv'] as const, 'type', 'all');
  const limit = parseIntParam(url.searchParams.get('limit'), 'limit', { min: 1, max: 12, fallback: 8 });
  const result = await suggestTitles(q, type, limit);
  return json(result, { headers: { 'Cache-Control': 'public, max-age=120, s-maxage=600, stale-while-revalidate=1800' } });
});
