import type { BrowseMode, MediaType } from '@/types/media';
import { getTmdbGenreFilterId } from '@/lib/genres';
import { TOP_RATED_MIN_VOTES } from '@/lib/ratings';
import { DISCOVERY_LANGUAGE } from '@/lib/service-catalogue';
import type { WatchRegion } from '@/lib/watch-regions';

export type RouteSearchParams = Record<string, string | string[] | undefined>;

const SORT_VALUES = new Set(['popularity', 'coming_soon', 'top_rated', 'newest', 'az']);
export function isCatalogueSort(value: string): value is CatalogueRouteParams['sort'] {
  return SORT_VALUES.has(value);
}

export type CatalogueRouteParams = {
  genre: string;
  sort: 'popularity' | 'coming_soon' | 'top_rated' | 'newest' | 'az';
  onlyWithSources: boolean;
  local?: true;
  page: number;
};

export function firstSearchParam(
  params: RouteSearchParams,
  key: string
): string | null {
  const value = params[key];
  if (Array.isArray(value)) return value[0] || null;
  return typeof value === 'string' ? value : null;
}

/** Normalizes URL input before it reaches the server catalogue request. */
export function readCatalogueRouteParams(
  params: RouteSearchParams,
  mode: Exclude<BrowseMode, 'home'>
): CatalogueRouteParams {
  const rawSort = firstSearchParam(params, 'sort');
  const rawPage = Number(firstSearchParam(params, 'page'));
  const rawGenre = firstSearchParam(params, 'genre') || '';

  return {
    genre: mode === 'documentary' ? '' : rawGenre.slice(0, 80),
    sort: rawSort && isCatalogueSort(rawSort) ? rawSort : 'popularity',
    ...((mode === 'movie' || mode === 'tv') && firstSearchParam(params, 'local') === '1' ? { local: true } : {}),
    onlyWithSources:
      firstSearchParam(params, 'avail') === '1' ||
      firstSearchParam(params, 'src') === '1',
    page:
      Number.isSafeInteger(rawPage) && rawPage > 0
        ? Math.min(rawPage, 500)
        : 1,
  };
}

/** Shared sort choices for catalogue pages (movies, series, documentaries, anime). */
export const CATALOGUE_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'popularity', label: 'Popular to watch now' },
  { value: 'coming_soon', label: 'Coming soon' },
  { value: 'top_rated', label: 'Highest rated' },
  { value: 'newest', label: 'Newest first' },
  { value: 'az', label: 'Title A – Z' },
];

/** One discovery builder for the public catalogue and its local-origin view.
 * Premiere-date constraints control recency, not the selected watch market. */
export function buildBrowseDiscoverParams({ type, mode, genre, sort, page, onlyWithSources = false, originRegion }: {
  type: MediaType;
  mode: Exclude<BrowseMode, 'home'>;
  genre: string;
  sort: string;
  page: number;
  onlyWithSources?: boolean;
  originRegion?: WatchRegion;
}): Record<string, string | number> {
  const params: Record<string, string | number> = {
    language: DISCOVERY_LANGUAGE, page, include_adult: 'false', sort_by: 'popularity.desc',
  };
  const date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
  if (sort === 'top_rated') {
    params.sort_by = 'vote_average.desc';
    params['vote_count.gte'] = mode === 'documentary' ? TOP_RATED_MIN_VOTES.tv : TOP_RATED_MIN_VOTES[type];
  } else if (sort === 'newest') {
    params.sort_by = `${date}.desc`;
    params['vote_count.gte'] = 10;
  } else if (sort === 'az') {
    params.sort_by = type === 'movie' ? 'original_title.asc' : 'name.asc';
    params['vote_count.gte'] = 50;
  }
  const today = new Date();
  if (sort === 'coming_soon') {
    today.setUTCDate(today.getUTCDate() + 1);
    params[`${date}.gte`] = today.toISOString().slice(0, 10);
  } else if (sort === 'popularity' || sort === 'newest' || onlyWithSources || originRegion) {
    params[`${date}.lte`] = today.toISOString().slice(0, 10);
  }
  if (originRegion) params.with_origin_country = originRegion;
  if (mode === 'anime') {
    params.with_genres = '16';
    params.with_original_language = 'ja';
  } else if (mode === 'documentary') {
    params.with_genres = '99';
  } else if (genre) {
    const id = getTmdbGenreFilterId(type, genre);
    if (id) params.with_genres = id;
  }
  return params;
}
