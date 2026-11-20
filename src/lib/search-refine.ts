import type { MediaType } from '@/types/media';
import type { ParsedNluQuery } from '@/lib/hybrid-search';
import { BROWSE_GENRES, getTmdbGenreFilterId } from '@/lib/genres';
import { RATING_MIN_VOTES, TOP_RATED_MIN_VOTES } from '@/lib/ratings';

/**
 * Search filters (Genre / Year / Rating / Sort) applied to the *whole* result
 * set, not only the page that happens to be loaded. Shared by the server
 * search service and the browser-key fallback in `@/lib/tmdb`, so both build
 * identical TMDB requests.
 *
 * - Discovery searches ("hindi movies", "90s thrillers", an empty query with
 *   filters) push every filter into TMDB `discover`, so page 1 holds a full
 *   page of matches and the counts are TMDB's own.
 * - Plain title searches cannot be filtered by TMDB, so the server scans the
 *   best `REFINE_SCAN_PAGES` pages of matches, filters them and pages the
 *   result locally (`refineRows`).
 */

export type SearchSort = 'relevance' | 'popular' | 'rating' | 'newest';

export interface SearchRefinements {
  genre: string;
  /** Four-digit release year, or ''. */
  year: string;
  /** Minimum TMDB score (0 = any). */
  minRating: number;
  sort: SearchSort;
}

export const NO_REFINEMENTS: SearchRefinements = Object.freeze({
  genre: '',
  year: '',
  minRating: 0,
  sort: 'relevance',
});

/** Title searches scan this many TMDB pages (20 each) when filters are on. */
export const REFINE_SCAN_PAGES = 5;
/** Page size for locally paged (title-search / scoped) results. */
export const REFINE_PAGE_SIZE = 20;

const GENRES = new Set<string>(BROWSE_GENRES);

export function parseSearchRefinements(
  get: (key: string) => string | null | undefined
): SearchRefinements {
  const genre = get('genre') || '';
  const year = (get('year') || '').trim();
  const rating = Number(get('rating'));
  const sort = get('sort');
  return {
    genre: GENRES.has(genre) ? genre : '',
    year: /^(18|19|20|21)\d{2}$/.test(year) ? year : '',
    minRating: Number.isInteger(rating) && rating >= 1 && rating <= 9 ? rating : 0,
    sort: sort === 'popular' || sort === 'rating' || sort === 'newest' ? sort : 'relevance',
  };
}

export function normalizeSearchRefinements(
  value: Partial<SearchRefinements> | null | undefined
): SearchRefinements {
  if (!value) return NO_REFINEMENTS;
  return parseSearchRefinements((key) => {
    if (key === 'rating') return value.minRating ? String(value.minRating) : '';
    const raw = value[key as keyof SearchRefinements];
    return raw === undefined || raw === null ? '' : String(raw);
  });
}

export function hasSearchRefinements(r: SearchRefinements): boolean {
  return Boolean(r.genre || r.year || r.minRating || r.sort !== 'relevance');
}

/** Adds the active refinements to a query string (`genre`, `year`, `rating`, `sort`). */
export function appendSearchRefinements(qs: URLSearchParams, r: SearchRefinements): URLSearchParams {
  if (r.genre) qs.set('genre', r.genre);
  if (r.year) qs.set('year', r.year);
  if (r.minRating) qs.set('rating', String(r.minRating));
  if (r.sort !== 'relevance') qs.set('sort', r.sort);
  return qs;
}

type DiscoverParams = Record<string, string | number | undefined>;

const raiseFloor = (p: DiscoverParams, floor: number) => {
  p['vote_count.gte'] = Math.max(Number(p['vote_count.gte'] || 0), floor);
};

/**
 * TMDB `discover/{type}` parameters for a descriptive query (`nlu`, may be
 * null for "filters only") plus the visitor's page filters.
 */
export function buildDiscoverParams(
  t: MediaType,
  page: number,
  nlu: ParsedNluQuery | null,
  refine: SearchRefinements = NO_REFINEMENTS,
  today: string = new Date().toISOString().slice(0, 10)
): DiscoverParams {
  const dateField = t === 'movie' ? 'primary_release_date' : 'first_air_date';
  const p: DiscoverParams = {
    language: 'en-US',
    include_adult: 'false',
    page,
    sort_by:
      nlu?.sortBy === 'primary_release_date.desc'
        ? `${dateField}.desc`
        : nlu?.sortBy || 'popularity.desc',
  };
  if (nlu?.sortBy === 'vote_average.desc') p['vote_count.gte'] = TOP_RATED_MIN_VOTES[t];

  const queryGenres = (t === 'movie' ? nlu?.movieGenres : nlu?.tvGenres) || [];
  const pickedGenre = getTmdbGenreFilterId(t, refine.genre);
  if (pickedGenre && queryGenres.length && !pickedGenre.includes('|')) {
    // Query genre AND picked genre ("thriller movies" + Comedy).
    p.with_genres = Array.from(new Set([...queryGenres.map(String), pickedGenre])).join(',');
  } else if (pickedGenre) {
    // An either-of TV genre ("80|9648") cannot be AND-ed safely; the picked one wins.
    p.with_genres = pickedGenre;
  } else if (queryGenres.length) {
    p.with_genres = queryGenres.join(',');
  }

  if (nlu?.originalLanguage) p.with_original_language = nlu.originalLanguage;
  // Runtime caps apply to films only; a series "runtime" is per episode.
  if (t === 'movie' && nlu?.maxRuntimeMinutes) p['with_runtime.lte'] = nlu.maxRuntimeMinutes;
  if (nlu?.startYear && nlu.endYear) {
    p[`${dateField}.gte`] = `${nlu.startYear}-01-01`;
    p[`${dateField}.lte`] = `${nlu.endYear}-12-31`;
  }

  if (refine.year) p[t === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = refine.year;
  if (refine.minRating) {
    p['vote_average.gte'] = refine.minRating;
    // Cards show "New" below this many votes, so a score filter needs them.
    raiseFloor(p, RATING_MIN_VOTES);
  }
  if (refine.sort === 'popular') {
    p.sort_by = 'popularity.desc';
  } else if (refine.sort === 'rating') {
    p.sort_by = 'vote_average.desc';
    raiseFloor(p, RATING_MIN_VOTES);
  } else if (refine.sort === 'newest') {
    p.sort_by = `${dateField}.desc`;
    // Released titles only, and not empty placeholder entries.
    const lte = p[`${dateField}.lte`];
    if (!lte || String(lte) > today) p[`${dateField}.lte`] = today;
    raiseFloor(p, 10);
  }
  return p;
}

export interface RefinableRow {
  media_type?: string;
  genre_ids?: number[];
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
}

function rowType(row: RefinableRow, fallback?: MediaType): MediaType | null {
  const t = row.media_type || fallback;
  return t === 'movie' || t === 'tv' ? t : null;
}

const rowDate = (row: RefinableRow) => row.release_date || row.first_air_date || '';

export function rowMatchesRefinements(
  row: RefinableRow,
  r: SearchRefinements,
  fallbackType?: MediaType
): boolean {
  const t = rowType(row, fallbackType);
  if (!t) return false;
  if (r.genre) {
    const ids = getTmdbGenreFilterId(t, r.genre).split('|').filter(Boolean).map(Number);
    if (!ids.some((id) => (row.genre_ids || []).includes(id))) return false;
  }
  if (r.year && !rowDate(row).startsWith(r.year)) return false;
  if (r.minRating) {
    if (Number(row.vote_count || 0) < RATING_MIN_VOTES) return false;
    if (Number(row.vote_average || 0) < r.minRating) return false;
  }
  return true;
}

/** Stable sort: "relevance" keeps the incoming (ranked) order. */
export function sortRowsByRefinement<T extends RefinableRow>(rows: T[], r: SearchRefinements): T[] {
  if (r.sort === 'relevance') return rows;
  const today = new Date().toISOString().slice(0, 10);
  const score = (row: T) =>
    r.sort === 'rating'
      ? Number(row.vote_count || 0) >= RATING_MIN_VOTES
        ? Number(row.vote_average || 0)
        : -1
      : 0;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (r.sort === 'newest') {
        // Unreleased and undated titles go last.
        const da = rowDate(a.row);
        const db = rowDate(b.row);
        const va = da && da <= today ? da : '';
        const vb = db && db <= today ? db : '';
        if (va !== vb) return vb.localeCompare(va);
      } else if (r.sort === 'popular') {
        const diff = Number(b.row.popularity || 0) - Number(a.row.popularity || 0);
        if (diff) return diff;
      } else {
        const diff = score(b.row) - score(a.row);
        if (diff) return diff;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Filters, orders and pages an already-ranked list of rows. `totalPages` is
 * the real number of filtered pages.
 */
export function refineRows<T extends RefinableRow>(
  rows: T[],
  r: SearchRefinements,
  page: number,
  fallbackType?: MediaType,
  pageSize = REFINE_PAGE_SIZE
): { rows: T[]; page: number; totalPages: number; totalResults: number } {
  const kept = sortRowsByRefinement(
    rows.filter((row) => rowMatchesRefinements(row, r, fallbackType)),
    r
  );
  const totalPages = Math.max(1, Math.ceil(kept.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return {
    rows: kept.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    totalPages,
    totalResults: kept.length,
  };
}
