import { parseIgnoredQueryFilters } from '@/lib/hybrid-search';
import { parseScopeParam } from '@/lib/search-scope';
import { parseSearchRefinements } from '@/lib/search-refine';
import { apiRoute, json } from '@/server/core/api';
import { badRequest } from '@/server/core/errors';
import { parseEnum, parseIntParam } from '@/server/core/validate';
import { searchTitles } from '@/server/search/service';
import { RATE_LIMITS } from '@/server/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/search?q=&type=all|movie|tv&page=&ignore=genre,year[&person=ID|&collection=ID]
 *   [&genre=Thriller&year=2024&rating=7&sort=rating|newest]
 *
 * Natural-language discovery ("90s korean thrillers"), hybrid title ranking
 * and typo correction ("intersteller" → Interstellar). Genre / year / rating /
 * sort filter the whole result set, so every page is a full page of matches.
 */
export const GET = apiRoute({ name: 'search', rateLimit: RATE_LIMITS.search }, async ({ url, mark }) => {
  const q = url.searchParams.get('q') ?? '';
  if (q.length > 120) throw badRequest('q must be at most 120 characters');
  const type = parseEnum(url.searchParams.get('type') ?? undefined, ['all', 'movie', 'tv'] as const, 'type', 'all');
  const page = parseIntParam(url.searchParams.get('page'), 'page', { min: 1, max: 500, fallback: 1 });
  const started = performance.now();
  const result = await searchTitles({
    query: q,
    type,
    page,
    ignoredFilters: parseIgnoredQueryFilters(url.searchParams.get('ignore')),
    refine: parseSearchRefinements((key) => url.searchParams.get(key)),
    // A person / collection picked from suggestions scopes the results.
    scope: url.searchParams.has('person')
      ? parseScopeParam('person', url.searchParams.get('person'))
      : url.searchParams.has('collection')
        ? parseScopeParam('collection', url.searchParams.get('collection'))
        : null,
  });
  mark('search', started);
  return json(result, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' } });
});
