import 'server-only';

import { compactFeed, compactResult } from '@/lib/media-wire';
import { buildBrowseDiscoverParams, type CatalogueRouteParams } from '@/lib/catalogue-route';
import { tmdbPageCount } from '@/lib/pagination';
import { blendRegionalMedia, marketDiscoverParams, regionalPicks, REGIONAL_DISCOVERY } from '@/lib/regional-discovery';
import { DISCOVERY_LANGUAGE, mergeServiceProviders, serviceDiscoverParams, type ServiceSort } from '@/lib/service-catalogue';
import { normalizeTmdbItem } from '@/lib/tmdb';
import type { WatchRegion } from '@/lib/watch-regions';
import type { MediaItem, MediaType, PaginatedResult } from '@/types/media';
import { ApiError } from '@/server/core/errors';
import { TmdbError, tmdbGet } from '@/server/tmdb/gateway';

type ProviderList = { results: unknown[] };
type RawItem = NonNullable<Parameters<typeof normalizeTmdbItem>[0]>;
type DiscoverList = { page: number; total_pages: number; total_results: number; results: RawItem[] };
type Query = Record<string, string | number>;

function hasResults(value: unknown): value is ProviderList {
  return Boolean(value && typeof value === 'object' && 'results' in value && Array.isArray(value.results));
}

function isDiscoverList(value: unknown): value is DiscoverList {
  if (!hasResults(value)) return false;
  const list = value as DiscoverList;
  return [list.page, list.total_pages, list.total_results].every((n) => Number.isSafeInteger(n) && n >= 0)
    && list.page > 0;
}

async function discoverPage(type: MediaType, params: Query): Promise<PaginatedResult> {
  const { data } = await tmdbGet<DiscoverList>(`discover/${type}`, params, {
    validate: (body) => isDiscoverList(body) && body.page === params.page,
  });
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const row of data.results) {
    if (typeof row?.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 1 || row.adult === true) continue;
    const item = normalizeTmdbItem(row, type);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return {
    items, page: data.page, totalResults: data.total_results,
    ...(data.total_pages === 0 ? { totalPages: 0 } : tmdbPageCount(data.total_pages)), isLive: true,
  };
}

export async function fetchRegionalServices(region: WatchRegion) {
  const params = { watch_region: region, language: DISCOVERY_LANGUAGE };
  const [movie, tv] = await Promise.all([
    tmdbGet<ProviderList>('watch/providers/movie', params, { validate: hasResults }),
    tmdbGet<ProviderList>('watch/providers/tv', params, { validate: hasResults }),
  ]);
  return { region, providers: mergeServiceProviders(region, movie.data.results, tv.data.results) };
}

export async function fetchServiceCatalogue(input: { region: WatchRegion; providerId: number; type: MediaType; sort: ServiceSort; page: number; signal?: AbortSignal }) {
  const checkCancelled = () => {
    if (input.signal?.aborted) throw new ApiError(499, 'CANCELLED', 'Request cancelled.');
  };
  checkCancelled();

  // Provider IDs and supported formats are market-specific. Reuse the same
  // regional roster as the directory, then fetch exactly the selected page.
  const { providers } = await fetchRegionalServices(input.region);
  checkCancelled();
  const provider = providers.find(({ id }) => id === input.providerId);
  if (!provider) throw new ApiError(404, 'PROVIDER_UNAVAILABLE', 'This service is not listed for the selected country.');
  if (!provider.types.includes(input.type)) {
    throw new ApiError(404, 'PROVIDER_FORMAT_UNAVAILABLE', 'This format is not listed for the service in the selected country.');
  }

  const result = await discoverPage(input.type, serviceDiscoverParams(input));
  checkCancelled();
  return compactResult(result);
}

export async function fetchOriginCatalogue({ region, type, sort, genre, page }: {
  region: WatchRegion;
  type: MediaType;
  sort: CatalogueRouteParams['sort'];
  genre: string;
  page: number;
}) {
  return compactResult(await discoverPage(type, buildBrowseDiscoverParams({
    mode: type, type, sort, genre, page, originRegion: region,
  })));
}

export async function fetchRegionalFeed(region: WatchRegion) {
  const today = new Date().toISOString().slice(0, 10);
  const [movies, series, marketMovies, marketSeries] = await Promise.allSettled([
    discoverPage('movie', marketDiscoverParams(region, 'movie', 'origin', today)),
    discoverPage('tv', marketDiscoverParams(region, 'tv', 'origin', today)),
    discoverPage('movie', marketDiscoverParams(region, 'movie', 'market', today)),
    discoverPage('tv', marketDiscoverParams(region, 'tv', 'market', today)),
  ]);
  const responses = [movies, series, marketMovies, marketSeries];
  // A failed half does not hide valid results from the other half. An all-out
  // failure instead preserves the gateway's real timeout/rate-limit/error code.
  if (responses.every((result) => result.status === 'rejected')) {
    throw responses.find((result) => result.status === 'rejected' && result.reason instanceof TmdbError)?.reason
      ?? new TmdbError(502, 'Regional discovery failed');
  }
  const items = (result: PromiseSettledResult<PaginatedResult>) => result.status === 'fulfilled' ? result.value.items : [];
  return compactFeed({
    movies: regionalPicks(items(movies), REGIONAL_DISCOVERY.originRailSize),
    series: regionalPicks(items(series), REGIONAL_DISCOVERY.originRailSize),
    popular: regionalPicks(blendRegionalMedia(items(marketMovies), items(marketSeries)), REGIONAL_DISCOVERY.marketCandidateLimit),
    partial: responses.some((result) => result.status === 'rejected'),
  });
}
