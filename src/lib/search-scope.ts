import type { MediaType, SearchScope } from '@/types/media';
import { NO_REFINEMENTS, refineRows, type SearchRefinements } from '@/lib/search-refine';

/**
 * Person- and collection-scoped search ("titles with Tom Hanks", "The Dark
 * Knight Collection"). Pure helpers shared by the server search service and
 * the browser-key fallback in `@/lib/tmdb`, so both rank identically.
 *
 * TMDB sources:
 * - person:     GET person/{id}?append_to_response=combined_credits
 * - collection: GET collection/{id}
 */

export const SCOPE_PAGE_SIZE = 20;

/** Talk shows, news and award ceremonies are appearances, not filmography. */
const APPEARANCE_GENRES = new Set([10767, 10763]);
const SELF_CHARACTER = /^(self|himself|herself|themselves|narrator \(voice\)|host)\b/i;
const CREW_JOBS = new Set(['Director', 'Creator', 'Screenplay', 'Writer', 'Novel', 'Executive Producer']);

export interface ScopeRow {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  character?: string;
  job?: string;
  genre_ids?: number[];
  popularity?: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  adult?: boolean;
  poster_path?: string | null;
  [key: string]: unknown;
}

export interface RawPersonWithCredits {
  id?: number;
  name?: string;
  adult?: boolean;
  combined_credits?: { cast?: ScopeRow[]; crew?: ScopeRow[] };
}

export interface RawCollection {
  id?: number;
  name?: string;
  parts?: ScopeRow[];
}

export interface ScopedRows {
  scope: SearchScope;
  rows: Array<ScopeRow & { media_type: MediaType }>;
  totalResults: number;
  totalPages: number;
}

export function parseScopeParam(kind: string | null | undefined, id: string | null | undefined): Pick<SearchScope, 'kind' | 'id'> | null {
  if (kind !== 'person' && kind !== 'collection') return null;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 && n < 1e9 ? { kind, id: n } : null;
}

/** URL for a scoped search page; `q` keeps the visible name for no-JS / sharing. */
export function scopeSearchHref(scope: Pick<SearchScope, 'kind' | 'id' | 'name'>): string {
  const qs = new URLSearchParams({ q: scope.name, [scope.kind]: String(scope.id) });
  return `/search?${qs.toString()}`;
}

/** Applies the page filters to the whole list, then pages it. */
function page<T extends ScopeRow & { media_type: MediaType }>(rows: T[], pageNumber: number, refine: SearchRefinements) {
  const refined = refineRows(rows, refine, pageNumber, undefined, SCOPE_PAGE_SIZE);
  return { slice: refined.rows, totalPages: refined.totalPages, totalResults: refined.totalResults };
}

const isMediaRow = (row: ScopeRow): row is ScopeRow & { media_type: MediaType } =>
  Boolean(row.id) && (row.media_type === 'movie' || row.media_type === 'tv') && !row.adult;

/**
 * A person's filmography: acting credits (minus talk-show / "Self"
 * appearances) plus directing, writing and creating credits, one row per
 * title, most popular first.
 */
export function rowsFromPersonCredits(
  raw: RawPersonWithCredits | null | undefined,
  type: 'all' | MediaType,
  pageNumber: number,
  refine: SearchRefinements = NO_REFINEMENTS
): ScopedRows | null {
  if (!raw?.id || !raw.name || raw.adult) return null;
  const cast = (raw.combined_credits?.cast || []).filter(
    (row) =>
      !SELF_CHARACTER.test(String(row.character || '').trim()) &&
      !(row.genre_ids || []).some((g) => APPEARANCE_GENRES.has(g))
  );
  const crew = (raw.combined_credits?.crew || []).filter((row) => CREW_JOBS.has(String(row.job || '')));
  const seen = new Set<string>();
  const rows = [...cast, ...crew]
    .filter(isMediaRow)
    .filter((row) => type === 'all' || row.media_type === type)
    .filter((row) => {
      const key = `${row.media_type}:${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Popularity alone floats one-off cameos in trending shows; weight by votes.
    .sort((a, b) => score(b) - score(a));
  const { slice, totalPages, totalResults } = page(rows, pageNumber, refine);
  return {
    scope: { kind: 'person', id: raw.id, name: raw.name },
    rows: slice,
    totalResults,
    totalPages,
  };
}

function score(row: ScopeRow): number {
  return Math.log10(1 + Number(row.vote_count || 0)) * 2 + Math.log10(1 + Number(row.popularity || 0));
}

/** A collection's films in release order (undated parts last). */
export function rowsFromCollection(
  raw: RawCollection | null | undefined,
  type: 'all' | MediaType,
  pageNumber: number,
  refine: SearchRefinements = NO_REFINEMENTS
): ScopedRows | null {
  if (!raw?.id || !raw.name) return null;
  const rows = (raw.parts || [])
    .map((row) => ({ ...row, media_type: row.media_type || 'movie' }))
    .filter(isMediaRow)
    .filter((row) => type === 'all' || row.media_type === type)
    .sort((a, b) => {
      const da = a.release_date || a.first_air_date || '9999';
      const db = b.release_date || b.first_air_date || '9999';
      return da.localeCompare(db);
    });
  const { slice, totalPages, totalResults } = page(rows, pageNumber, refine);
  return {
    scope: { kind: 'collection', id: raw.id, name: raw.name },
    rows: slice,
    totalResults,
    totalPages,
  };
}

/** TMDB request for a scope (path + params), identical on server and client. */
export function scopeRequest(scope: Pick<SearchScope, 'kind' | 'id'>): { path: string; params: Record<string, string> } {
  return scope.kind === 'person'
    ? { path: `person/${scope.id}`, params: { language: 'en-US', append_to_response: 'combined_credits' } }
    : { path: `collection/${scope.id}`, params: { language: 'en-US' } };
}
