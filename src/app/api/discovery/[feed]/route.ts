import { isCatalogueSort } from '@/lib/catalogue-route';
import { getTmdbGenreFilterId } from '@/lib/genres';
import { isServiceSort, parseDiscoveryPage, parseProviderId } from '@/lib/service-catalogue';
import { isWatchRegion } from '@/lib/watch-regions';
import { apiRoute, json } from '@/server/core/api';
import { badRequest, notFound } from '@/server/core/errors';
import { fetchOriginCatalogue, fetchRegionalFeed, fetchRegionalServices, fetchServiceCatalogue } from '@/server/discovery/catalogue';
import { RATE_LIMITS } from '@/server/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILTERS = {
  providers: ['region'],
  market: ['region'],
  service: ['region', 'provider', 'type', 'page', 'sort'],
  origin: ['region', 'type', 'page', 'sort', 'genre'],
} as const;

// These responses contain no account data. The profile country is resolved on
// the client and sent explicitly, so each URL identifies one public market.
const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300';

export const GET = apiRoute<{ feed: string }>({ name: 'regional-discovery', rateLimit: RATE_LIMITS.catalogue }, async ({ req, url, params }) => {
  if (!Object.hasOwn(FILTERS, params.feed)) throw notFound('Unknown discovery feed.');
  const filters: readonly string[] = FILTERS[params.feed as keyof typeof FILTERS];
  const query = url.searchParams;
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !filters.includes(key))) throw badRequest('Invalid or duplicate discovery filters.');
  const region = query.get('region')?.trim().toUpperCase();
  if (!isWatchRegion(region)) throw badRequest('Choose a valid ISO country code.');
  const reply = (data: unknown, partial = false) => json(data, { headers: { 'Cache-Control': partial ? 'no-store' : PUBLIC_CACHE } });

  if (params.feed === 'providers') return reply(await fetchRegionalServices(region));
  if (params.feed === 'market') {
    const feed = await fetchRegionalFeed(region);
    return reply(feed, feed.partial);
  }

  const type = query.get('type');
  const page = parseDiscoveryPage(query.get('page') ?? '1');
  if (type !== 'movie' && type !== 'tv') throw badRequest('Choose Movies or TV shows.');
  if (page === null) throw badRequest('Page must be an integer from 1 to 500.');

  if (params.feed === 'service') {
    const providerId = parseProviderId(query.get('provider'));
    const sort = query.get('sort') ?? 'popular';
    if (providerId === null) throw badRequest('Choose a valid TMDB provider ID.');
    if (!isServiceSort(sort)) throw badRequest('Invalid service sort.');
    return reply(await fetchServiceCatalogue({ region, providerId, type, sort, page, signal: req.signal }));
  }

  const sort = query.get('sort') ?? 'popularity';
  const genre = query.get('genre') ?? '';
  if (!isCatalogueSort(sort) || (genre && (genre.length > 80 || !getTmdbGenreFilterId(type, genre)))) {
    throw badRequest('Invalid catalogue sort or genre.');
  }
  return reply(await fetchOriginCatalogue({ region, type, sort, genre, page }));
});
