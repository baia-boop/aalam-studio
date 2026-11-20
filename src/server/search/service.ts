import type { MediaItem, MediaType, PaginatedResult } from '@/types/media';
import {
  excludeNluFilters, parseSearchQueryNLU, rankSearchCandidates, titleMatchScore,
  type NluFilterKey, type ParsedNluQuery, type RawSearchCandidate,
} from '@/lib/hybrid-search';
import {
  NO_REFINEMENTS, REFINE_SCAN_PAGES, buildDiscoverParams, hasSearchRefinements,
  normalizeSearchRefinements, refineRows, sortRowsByRefinement, type SearchRefinements,
} from '@/lib/search-refine';
import { TMDB_MAX_PAGES, tmdbPageCount } from '@/lib/pagination';
import { normalizeTmdbItem } from '@/lib/tmdb';
import { compactFold, titleMatchKind, type MatchKind } from '@/lib/search-text';
import {
  rowsFromCollection, rowsFromPersonCredits, scopeRequest,
  type RawCollection, type RawPersonWithCredits,
} from '@/lib/search-scope';
import type { SearchScope } from '@/types/media';
import { SingleFlight, mapConcurrent } from '../core/concurrency';
import { logger } from '../core/logger';
import { tmdbGet, tmdbTry } from '../tmdb/gateway';
import { SuggestTrie, foldText, type TrieEntity } from './trie';

/**
 * Server search. Mirrors the browser's search contract exactly (NLU discover
 * queries, hybrid BM25/title/popularity ranking via `@/lib/hybrid-search`)
 * and adds what only a server can do well: shared caching, typo correction
 * from a popularity-ranked title index, and instant suggestions.
 */

import { TMDB_GENRE_NAMES } from '@/lib/genres';

type Raw = RawSearchCandidate & {
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  popularity?: number;
  adult?: boolean;
};

interface ListResponse {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: Raw[];
}

export type SearchStrategy = 'trending' | 'discover' | 'nlu' | 'hybrid' | 'corrected' | 'scoped';

export interface SearchResponse extends PaginatedResult {
  strategy: SearchStrategy;
  query: string;
  /** Set when the original query found little and a close title did better. */
  correctedQuery?: string;
}

const normalize = (rows: Raw[] | undefined, type?: MediaType): MediaItem[] =>
  (rows || [])
    .filter((row) => !row.adult)
    .map((row) => normalizeTmdbItem(row as Parameters<typeof normalizeTmdbItem>[0], type))
    .filter((item): item is MediaItem => item !== null);

async function trendingResults(type: 'all' | MediaType): Promise<SearchResponse> {
  const { data } = await tmdbGet<ListResponse>(`trending/${type}/week`, { language: 'en-US', page: 1 });
  const items = normalize(data.results, type === 'all' ? undefined : type).slice(0, 18);
  return { items, page: 1, totalPages: 1, totalResults: items.length, isLive: true, strategy: 'trending', query: '' };
}

/**
 * TMDB discover for a descriptive query and/or the page filters. Every filter
 * runs upstream, so each page is a full page of matches with real totals.
 */
async function discoverResults(
  query: string,
  nlu: ParsedNluQuery | null,
  type: 'all' | MediaType,
  page: number,
  refine: SearchRefinements
): Promise<SearchResponse> {
  const effective = type !== 'all' ? type : nlu?.mediaType || 'all';
  const wantMovies = effective === 'all' || effective === 'movie';
  const wantTv = effective === 'all' || effective === 'tv';

  const [movies, series] = await Promise.all([
    wantMovies ? tmdbGet<ListResponse>('discover/movie', buildDiscoverParams('movie', page, nlu, refine)).then((r) => r.data) : null,
    wantTv ? tmdbGet<ListResponse>('discover/tv', buildDiscoverParams('tv', page, nlu, refine)).then((r) => r.data) : null,
  ]);
  const rows = [
    ...(movies?.results || []).map((row) => ({ ...row, media_type: 'movie' })),
    ...(series?.results || []).map((row) => ({ ...row, media_type: 'tv' })),
  ] as Raw[];
  const ordered =
    refine.sort !== 'relevance'
      ? sortRowsByRefinement(rows, refine)
      : nlu?.sortBy === 'vote_average.desc'
        ? [...rows].sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0))
        : [...rows].sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0));
  return {
    items: normalize(ordered),
    page,
    ...tmdbPageCount(movies?.total_pages, series?.total_pages),
    totalResults: Number(movies?.total_results || 0) + Number(series?.total_results || 0),
    isLive: true,
    ...(nlu ? { smartQueryHint: nlu.summaryLabel } : {}),
    strategy: nlu ? 'nlu' : 'discover',
    query,
  };
}

async function nluResults(
  query: string,
  type: 'all' | MediaType,
  ignored: NluFilterKey[],
  page: number,
  refine: SearchRefinements
): Promise<SearchResponse | null> {
  const parsed = parseSearchQueryNLU(query);
  if (!parsed) return null;
  const nlu = excludeNluFilters(parsed, type === 'all' ? ignored : [...ignored, 'type']);
  return discoverResults(query, nlu, type, page, refine);
}

async function hybridResults(query: string, type: 'all' | MediaType, page: number, refine: SearchRefinements = NO_REFINEMENTS): Promise<SearchResponse> {
  const endpoint = type === 'movie' ? 'search/movie' : type === 'tv' ? 'search/tv' : 'search/multi';
  const fetchPage = (n: number) =>
    tmdbGet<ListResponse>(endpoint, { query, language: 'en-US', include_adult: 'false', page: n }).then((r) => r.data);
  const fallbackType = type === 'all' ? undefined : type;

  if (!hasSearchRefinements(refine)) {
    const data = await fetchPage(page);
    const ranked = rankSearchCandidates((data.results || []) as RawSearchCandidate[], query) as Raw[];
    const items = normalize(ranked, fallbackType);
    return {
      items,
      page: Number(data.page || page),
      ...tmdbPageCount(data.total_pages),
      totalResults: Number(data.total_results || items.length),
      isLive: true,
      strategy: 'hybrid',
      query,
    };
  }

  // TMDB title search has no genre / year / rating parameters: filter the
  // best few pages of matches as one list and page that, so page 1 is a full
  // page of matching titles.
  const first = await fetchPage(1);
  const scan = Math.min(REFINE_SCAN_PAGES, Math.max(1, Number(first.total_pages || 1)));
  const rest = await Promise.all(
    Array.from({ length: scan - 1 }, (_, i) => fetchPage(i + 2).catch(() => null))
  );
  const rows = [first, ...rest].flatMap((data) => data?.results || []);
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = `${row.media_type || fallbackType}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !row.adult;
  });
  const ranked = rankSearchCandidates(unique as RawSearchCandidate[], query) as Raw[];
  const refined = refineRows(ranked, refine, page, fallbackType);
  return {
    items: normalize(refined.rows, fallbackType),
    page: refined.page,
    totalPages: refined.totalPages,
    totalResults: refined.totalResults,
    isLive: true,
    strategy: 'hybrid',
    query,
  };
}

/** A result set is weak when nothing in it closely matches the query text. */
function isWeak(result: SearchResponse, query: string): boolean {
  if (result.items.length === 0) return true;
  return result.items.slice(0, 5).every((item) => titleMatchScore(item.title, query) < 0.4);
}

/** Titles for a person's credits or a collection's parts. */
async function scopedResults(
  scope: Pick<SearchScope, 'kind' | 'id'>,
  query: string,
  type: 'all' | MediaType,
  page: number,
  refine: SearchRefinements
): Promise<SearchResponse> {
  const { path, params } = scopeRequest(scope);
  const { data } = await tmdbGet<RawPersonWithCredits & RawCollection>(path, params);
  const scoped = scope.kind === 'person' ? rowsFromPersonCredits(data, type, page, refine) : rowsFromCollection(data, type, page, refine);
  if (!scoped) {
    return { items: [], page: 1, totalPages: 1, totalResults: 0, isLive: true, strategy: 'scoped', query };
  }
  const items = normalize(scoped.rows as Raw[]);
  return {
    items,
    page: Math.min(page, scoped.totalPages),
    totalPages: scoped.totalPages,
    totalResults: scoped.totalResults,
    isLive: true,
    strategy: 'scoped',
    query,
    scope: scoped.scope,
  };
}

export async function searchTitles(input: {
  query: string;
  type?: 'all' | MediaType;
  ignoredFilters?: NluFilterKey[];
  page?: number;
  /** Person or collection picked from suggestions; wins over the query text. */
  scope?: Pick<SearchScope, 'kind' | 'id'> | null;
  /** Genre / year / rating / sort, applied across all results (not one page). */
  refine?: Partial<SearchRefinements> | null;
}): Promise<SearchResponse> {
  const query = input.query.trim().replace(/\s+/g, ' ').slice(0, 120);
  const type = input.type ?? 'all';
  const page = Math.min(TMDB_MAX_PAGES, Math.max(1, input.page ?? 1));
  const refine = normalizeSearchRefinements(input.refine);
  if (input.scope) return scopedResults(input.scope, query, type, page, refine);
  if (!query) {
    return hasSearchRefinements(refine)
      ? discoverResults('', null, type, page, refine)
      : trendingResults(type);
  }

  // Descriptive queries ("funny comedy movies") become genre discovery. A
  // real title made only of such words ("Scary Movie", "The Family") must
  // still win, so page 1 also runs the literal search and keeps it when its
  // top result is that exact title. Chips the visitor removed keep discovery.
  const ignored = input.ignoredFilters ?? [];
  const checkLiteral = page === 1 && ignored.length === 0 && parseSearchQueryNLU(query) !== null;
  const [nlu, literal] = await Promise.all([
    nluResults(query, type, ignored, page, refine),
    checkLiteral ? hybridResults(query, type, 1, refine).catch(() => null) : Promise.resolve(null),
  ]);
  if (nlu) {
    const top = literal?.items[0];
    if (literal && top && compactFold(top.title) === compactFold(query)) return literal;
    return nlu;
  }

  const result = await hybridResults(query, type, page, refine);
  if (page !== 1 || query.length < 4 || !isWeak(result, query)) return result;

  // Typo recovery: "intersteller" → "Interstellar". Only adopt the correction
  // when it actually finds a strong title match.
  const index = await getSuggestIndex();
  const [candidate] = index.fuzzy(query, 1).filter((e) => type === 'all' || e.mediaType === type);
  if (!candidate || foldText(candidate.title) === foldText(query)) return result;
  try {
    const corrected = await hybridResults(candidate.title, type, 1, refine);
    if (!isWeak(corrected, candidate.title)) {
      return { ...corrected, strategy: 'corrected', query, correctedQuery: candidate.title };
    }
  } catch (error) {
    logger.debug('Search correction failed', { error });
  }
  return result;
}

/* ----------------------------------------------------------------------------
   Suggest index
   ------------------------------------------------------------------------- */

const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const SEED_LISTS: Array<[string, MediaType | undefined]> = [
  ['trending/all/day', undefined],
  ['trending/all/week', undefined],
  ['movie/popular', 'movie'],
  ['tv/popular', 'tv'],
  ['movie/top_rated', 'movie'],
  ['tv/top_rated', 'tv'],
  ['movie/now_playing', 'movie'],
];

let index: { trie: SuggestTrie; builtAt: number } | null = null;
const indexFlight = new SingleFlight();

function entityFrom(row: Raw, fallback?: MediaType): TrieEntity | null {
  const mediaType = row.media_type === 'movie' || row.media_type === 'tv' ? row.media_type : fallback;
  const title = row.title || row.name;
  if (!row.id || !mediaType || !title || row.adult) return null;
  return {
    key: `${mediaType}:${row.id}`,
    tmdbId: row.id,
    mediaType,
    title,
    year: (row.release_date || row.first_air_date || '').slice(0, 4),
    popularity: row.popularity || 0,
    posterPath: row.poster_path || null,
    genreIds: Array.isArray(row.genre_ids) ? row.genre_ids.filter((id) => Number.isInteger(id)).slice(0, 4) : undefined,
  };
}

async function buildIndex(): Promise<SuggestTrie> {
  const trie = new SuggestTrie();
  const jobs = SEED_LISTS.flatMap(([path, type]) => [1, 2, 3].map((page) => ({ path, type, page })));
  const lists = await mapConcurrent(jobs, 6, async (job) => ({
    type: job.type,
    data: await tmdbTry<ListResponse>(job.path, { language: 'en-US', page: job.page }),
  }));
  for (const { type, data } of lists) {
    for (const row of data?.results || []) {
      const entity = entityFrom(row, type);
      if (entity) trie.insert(entity);
    }
  }
  logger.info('Suggest index built', { titles: trie.size });
  return trie;
}

export async function getSuggestIndex(): Promise<SuggestTrie> {
  const now = Date.now();
  if (index && now - index.builtAt < INDEX_TTL_MS) return index.trie;
  const rebuild = indexFlight.do('suggest-index', async () => {
    const trie = await buildIndex();
    // Never replace a good index with an empty one (TMDB outage).
    if (trie.size > 0 || !index) index = { trie, builtAt: Date.now() };
    return index.trie;
  });
  if (index) {
    void rebuild.catch(() => undefined); // stale-while-revalidate
    return index.trie;
  }
  return rebuild;
}

export function getSuggestIndexStats() {
  return { titles: index?.trie.size ?? 0, builtAt: index ? new Date(index.builtAt).toISOString() : null };
}

export function resetSuggestIndexForTests() {
  index = null;
}

export interface Suggestion {
  id: string;
  tmdbId: number;
  type: MediaType;
  title: string;
  year: string;
  posterPath: string | null;
  /** Up to two human-readable genre names; empty when unknown. */
  genres: string[];
  /**
   * How the title relates to the query: `exact` (after folding accents,
   * punctuation and spacing), `prefix`, `partial`, or `fuzzy` (typo match).
   */
  match: MatchKind | 'fuzzy';
}

export interface PersonSuggestion {
  id: number;
  name: string;
  profilePath: string | null;
  /** e.g. "Acting", "Directing". */
  department: string;
  /** Up to two well-known titles, as TMDB lists them. */
  knownFor: string[];
}

export interface CollectionSuggestion {
  id: number;
  name: string;
  posterPath: string | null;
}

export interface SuggestResponse {
  suggestions: Suggestion[];
  people: PersonSuggestion[];
  collections: CollectionSuggestion[];
  source: string;
}

/** Entity rows (people / collections) shown per type. */
const ENTITY_LIMIT = 2;

interface RawPerson {
  id?: number;
  media_type?: string;
  name?: string;
  adult?: boolean;
  popularity?: number;
  profile_path?: string | null;
  known_for_department?: string;
  known_for?: Array<{ title?: string; name?: string }>;
}

interface RawCollectionHit {
  id?: number;
  name?: string;
  adult?: boolean;
  poster_path?: string | null;
}

/** Every query word must start some word of the name ("nol" → "Christopher Nolan"). */
function nameMatches(name: string, query: string): boolean {
  const words = foldText(name).split(' ');
  const tokens = foldText(query).split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => words.some((word) => word.startsWith(token)));
}

function peopleFrom(rows: unknown[] | undefined, query: string): PersonSuggestion[] {
  return ((rows || []) as RawPerson[])
    .filter((row) => row.media_type === 'person' && row.id && row.name && !row.adult && nameMatches(row.name, query))
    // Obscure namesakes are noise next to titles; require some recognition.
    .filter((row) => Number(row.popularity || 0) >= 1 && (row.known_for || []).length > 0)
    .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))
    .slice(0, ENTITY_LIMIT)
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      profilePath: row.profile_path || null,
      department: String(row.known_for_department || ''),
      knownFor: (row.known_for || [])
        .map((k) => k.title || k.name || '')
        .filter(Boolean)
        .slice(0, 2),
    }));
}

function collectionsFrom(rows: RawCollectionHit[] | undefined, query: string): CollectionSuggestion[] {
  return (rows || [])
    .filter((row) => row.id && row.name && !row.adult && nameMatches(row.name, query))
    .slice(0, ENTITY_LIMIT)
    .map((row) => ({ id: Number(row.id), name: String(row.name), posterPath: row.poster_path || null }));
}

const genreNames = (ids?: number[]): string[] =>
  Array.from(new Set((ids || []).map((id) => TMDB_GENRE_NAMES[id]).filter((name): name is string => Boolean(name)))).slice(0, 2);

const toSuggestion = (e: TrieEntity, match: Suggestion['match']): Suggestion => ({
  id: String(e.tmdbId),
  tmdbId: e.tmdbId,
  type: e.mediaType,
  title: e.title,
  year: e.year,
  posterPath: e.posterPath,
  genres: genreNames(e.genreIds),
  match,
});

const MATCH_TIER: Record<MatchKind, number> = { exact: 0, prefix: 1, partial: 2 };

/**
 * Instant suggestions: trie prefix (popular titles, ~0 ms) → live TMDB search
 * for the long tail (cached) → fuzzy trie match for typos.
 *
 * An exact title match always wins: when the popular-title index fills every
 * slot with prefix matches ("From Dusk Till Dawn" for "from"), the cached live
 * search still runs so a less-seeded exact title ("From") is promoted first.
 */
export async function suggestTitles(rawQuery: string, type: 'all' | MediaType = 'all', limit = 8): Promise<SuggestResponse> {
  const query = rawQuery.trim().replace(/\s+/g, ' ').slice(0, 80);
  const folded = foldText(query);
  if (folded.length < 1) return { suggestions: [], people: [], collections: [], source: 'empty' };
  const matchesType = (e: TrieEntity) => type === 'all' || e.mediaType === type;
  const trie = await getSuggestIndex();
  const picked = new Map<string, TrieEntity>();
  const add = (entities: TrieEntity[]) => {
    for (const e of entities) if (matchesType(e) && picked.size < limit && !picked.has(e.key)) picked.set(e.key, e);
  };
  add(trie.prefix(query, limit * 2));
  let source = 'index';
  const hasExact = () => [...picked.values()].some((e) => titleMatchKind(e.title, query) === 'exact');
  // People and collections are only offered in the unfiltered ("all") view,
  // from 3 characters, where a name is plausibly what was typed.
  const wantEntities = type === 'all' && folded.length >= 3;
  let people: PersonSuggestion[] = [];
  let collections: CollectionSuggestion[] = [];
  const collectionSearch = wantEntities
    ? tmdbTry<{ results?: RawCollectionHit[] }>('search/collection', { query, language: 'en-US', include_adult: 'false', page: 1 })
    : null;

  if (folded.length >= 2 && (picked.size < limit || !hasExact() || wantEntities)) {
    const endpoint = type === 'movie' ? 'search/movie' : type === 'tv' ? 'search/tv' : 'search/multi';
    const data = await tmdbTry<ListResponse>(endpoint, { query, language: 'en-US', include_adult: 'false', page: 1 });
    if (wantEntities) people = peopleFrom(data?.results, query);
    const ranked = rankSearchCandidates((data?.results || []) as RawSearchCandidate[], query) as Raw[];
    const live = ranked
      .map((row) => entityFrom(row, type === 'all' ? undefined : type))
      .filter((e): e is TrieEntity => e !== null && matchesType(e));
    const indexKeys = new Set(picked.keys());
    // Promote exact live matches even when the index already filled the list.
    const exact = live.filter((e) => !picked.has(e.key) && titleMatchKind(e.title, query) === 'exact');
    if (exact.length) {
      const rest = [...picked.values()];
      picked.clear();
      add(exact);
      add(rest);
    }
    add(live);
    if ([...picked.keys()].some((key) => !indexKeys.has(key))) source = indexKeys.size ? 'index+live' : 'live';
  }
  if (picked.size === 0) {
    add(trie.fuzzy(query, limit * 2));
    if (picked.size) source = 'fuzzy';
  }
  if (collectionSearch) collections = collectionsFrom((await collectionSearch)?.results, query);
  // Stable relevance tiers: exact title, then title prefix, then the rest —
  // each tier keeps the index/live popularity order it arrived in.
  const ordered = [...picked.values()]
    .map((entity, position) => {
      const match: Suggestion['match'] = source === 'fuzzy' ? 'fuzzy' : titleMatchKind(entity.title, query);
      return { entity, position, match, tier: match === 'fuzzy' ? 2 : MATCH_TIER[match] };
    })
    .sort((a, b) => a.tier - b.tier || a.position - b.position);
  return {
    suggestions: ordered.map(({ entity, match }) => toSuggestion(entity, match)),
    people,
    collections,
    source,
  };
}
