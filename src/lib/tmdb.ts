import { LruCache } from '@/server/cache/lru';
import { isClean, normalizeDisplayTitle, isShelfEligible, isRecommendationEligible, isComingSoonEligible } from '@/lib/content-eligibility';
import { isReleased } from '@/lib/release';
import {
  AnimeFeedData,
  CastMember,
  CineMatchProfile,
  EpisodeItem,
  HomeFeedData,
  MediaDetail,
  MediaItem,
  MediaType,
  PaginatedResult,
  SearchScope,
  SeasonSummary,
  VideoItem,
} from '@/types/media';
import {
  getTmdbGenreFilterId,
  mapGenreIds,
  TMDB_GENRE_NAMES,
  WORLD_GENRES,
} from '@/lib/genres';
import {
  FALLBACK_TITLES,
  getFallbackAnimeFeed,
  getFallbackBrowse,
  getFallbackDetail,
  getFallbackHomeFeed,
  getFallbackSearch,
  getFallbackSeasonEpisodes,
} from '@/lib/fallback-data';
import { THIRD_PARTY_SOURCES } from '@/lib/embed-sources';
import { isTopRatedEligible } from '@/lib/ratings';
import {
  curateComingSoon,
  curateHero,
  curatePopular,
  curateTopTen,
  HERO_RULE,
} from '@/lib/home-curation';
import { isUpcoming } from '@/lib/release';
import { selectTitleRecommendations } from '@/lib/title-recommendations';
import { MISSING_SYNOPSIS_TEXT } from '@/lib/title-quality';
import { BRAND_ACCENT, BRAND_BACKGROUND, BRAND_MUTED, BRAND_SURFACE } from '@/lib/site';
import { DEFAULT_TMDB_BASE_URL, resolveTmdbBaseUrl } from '@/lib/tmdb-base-url';
import {
  AUTHORS_CHOICE_ANIME,
  AUTHORS_CHOICE_DOCUMENTARIES,
  AUTHORS_CHOICE_MOVIES,
  AUTHORS_CHOICE_TV,
  CuratedChoiceItem,
} from '@/data/curated-lists';
import {
  parseSearchQueryNLU,
  excludeNluFilters,
  NluFilterKey,
  rankSearchCandidates,
  RawSearchCandidate,
} from '@/lib/hybrid-search';
import { titleMatchKind, type MatchKind } from '@/lib/search-text';
import {
  NO_REFINEMENTS,
  REFINE_SCAN_PAGES,
  appendSearchRefinements,
  buildDiscoverParams,
  hasSearchRefinements,
  normalizeSearchRefinements,
  refineRows,
  sortRowsByRefinement,
  type RefinableRow,
  type SearchRefinements,
} from '@/lib/search-refine';
import { tmdbPageCount } from '@/lib/pagination';
import { buildBrowseDiscoverParams } from '@/lib/catalogue-route';
import { isWatchRegion, type WatchRegion } from '@/lib/watch-regions';
import {
  rowsFromCollection,
  rowsFromPersonCredits,
  scopeRequest,
  type RawCollection,
  type RawPersonWithCredits,
} from '@/lib/search-scope';

const TMDB_BASE = DEFAULT_TMDB_BASE_URL;

/**
 * Browser requests use the same-origin proxy. Server renders honour
 * TMDB_BASE_URL under the same allowlist as the server gateway, so a local
 * mock can stand in for TMDB in tests and performance-budget runs.
 */
function serverTmdbBase(): string {
  if (typeof window !== 'undefined') return TMDB_BASE;
  // Loopback (a local TMDB mock) is refused in production unless the
  // perf/test-only TMDB_ALLOW_LOOPBACK=1 opt-in is set.
  try {
    return resolveTmdbBaseUrl(process.env.TMDB_BASE_URL, process.env.NODE_ENV, {
      allowLoopback: process.env.TMDB_ALLOW_LOOPBACK === '1',
    });
  } catch {
    return TMDB_BASE;
  }
}
export const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p';
export const STORAGE_TMDB_KEY = 'aalam.tmdb_key';

const PLACEHOLDER_POSTER = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${BRAND_SURFACE}"/><stop offset="100%" stop-color="${BRAND_BACKGROUND}"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><circle cx="200" cy="275" r="24" fill="${BRAND_ACCENT}" opacity="0.85"/><ellipse cx="200" cy="275" rx="46" ry="17" fill="none" stroke="${BRAND_ACCENT}" stroke-width="4" transform="rotate(-24 200 275)" opacity="0.85"/><text x="200" y="345" text-anchor="middle" fill="${BRAND_MUTED}" font-family="sans-serif" font-size="14" font-weight="600" letter-spacing="3">AALAM</text></svg>`
)}`;

const PLACEHOLDER_BACKDROP = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${BRAND_SURFACE}"/><stop offset="100%" stop-color="${BRAND_BACKGROUND}"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="640" cy="340" r="32" fill="${BRAND_ACCENT}" opacity="0.7"/><ellipse cx="640" cy="340" rx="62" ry="22" fill="none" stroke="${BRAND_ACCENT}" stroke-width="5" transform="rotate(-24 640 340)" opacity="0.7"/></svg>`
)}`;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

export function extractMediaId(idAndSlug: string): string {
  const clean = decodeURIComponent(idAndSlug || '').trim();
  const numericPrefix = /^(\d+)(?:-|$)/.exec(clean);
  if (numericPrefix) return numericPrefix[1];
  return clean;
}

export function tmdbImage(
  path: string | null | undefined,
  size: 'w185' | 'w300' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original',
  kind: 'poster' | 'backdrop' = 'poster'
): string {
  if (!path) {
    return kind === 'poster' ? PLACEHOLDER_POSTER : PLACEHOLDER_BACKDROP;
  }
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('data:')
  ) {
    return path;
  }
  return `${TMDB_IMG_BASE}/${size}${path}`;
}

export function tmdbSrcSet(
  path: string | null | undefined,
  kind: 'poster' | 'backdrop'
): string | undefined {
  if (!path || path.startsWith('http') || path.startsWith('data:')) {
    return undefined;
  }
  if (kind === 'poster') {
    return [
      `${TMDB_IMG_BASE}/w185${path} 185w`,
      `${TMDB_IMG_BASE}/w342${path} 342w`,
      `${TMDB_IMG_BASE}/w500${path} 500w`,
    ].join(', ');
  }
  return [
    `${TMDB_IMG_BASE}/w300${path} 300w`,
    `${TMDB_IMG_BASE}/w780${path} 780w`,
    `${TMDB_IMG_BASE}/w1280${path} 1280w`,
  ].join(', ');
}

export function formatRuntime(minutes?: number | null): string {
  if (!minutes || minutes <= 0) return 'Movie';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}


/* ============================================================================
   TMDB Key & Cache Layer
   ============================================================================ */

/**
 * Raw TMDB responses, bounded.
 *
 * Keys carry user-driven cardinality — every `search/multi?query=…`, every
 * title, every season and episode — and a detail payload runs to tens of
 * kilobytes, so a plain Map grows for the life of a long-lived process
 * (`next start`, a container) with expiry only ever consulted on read. The
 * browser gets a tighter cap: less memory, shorter session.
 */
const RESPONSE_CACHE_ENTRIES =
  Number(process.env.AALAM_TMDB_CACHE_ENTRIES) || (typeof window === 'undefined' ? 500 : 150);
const responseCache = new LruCache<{ data: unknown; fetchedAt: number }>(RESPONSE_CACHE_ENTRIES);
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Server data-cache lifetime per TMDB endpoint. A page's ISR interval is the
 * minimum of its own `revalidate` and the fetches it makes, so title metadata
 * (stable: overview, cast, ratings drift slowly) gets a longer lifetime than
 * trending/popularity lists. See docs/performance.md.
 */
export const TMDB_LIST_REVALIDATE_SECONDS = CACHE_TTL_MS / 1000;
export const TMDB_DETAIL_REVALIDATE_SECONDS = 6 * 60 * 60;
function serverRevalidateSeconds(endpoint: string): number {
  return /^(movie|tv)\/\d+(\/(season\/\d+|videos|external_ids))?$/.test(endpoint)
    ? TMDB_DETAIL_REVALIDATE_SECONDS
    : TMDB_LIST_REVALIDATE_SECONDS;
}
// The homepage must be useful even when TMDB is slow, blocked, or temporarily
// unavailable. A hard deadline lets the caller use the local editorial feed
// instead of leaving the page behind a streaming loading state.
const TMDB_REQUEST_TIMEOUT_MS = 4500;
const CERTIFICATION_REGION_FALLBACKS = ['PK', 'US', 'GB', 'CA', 'AU'] as const;

/** Opt-in server diagnostics for reconciling catalogue/detail data snapshots. */
function debugDataSnapshot(scope: string, data: Record<string, unknown>) {
  if (typeof window === 'undefined' && process.env.AALAM_DEBUG_DATA === 'true') {
    console.info('[AALAM data]', {
      scope,
      updatedAt: new Date().toISOString(),
      ...data,
    });
  }
}

let serverKeyChecked = false;
let serverHasKey = false;

function cleanKey(value?: string | null): string {
  return (value || '').trim().replace(/^["']|["']$/g, '');
}

let legacyClientKeyCleared = false;

/**
 * User-supplied TMDB keys are no longer a product feature. The server-side key
 * is the only catalogue credential, so the browser never uses a stored key.
 * Any legacy value left by an older build is discarded once here.
 */
export function getClientStoredKey(): string {
  if (typeof window === 'undefined') return '';
  if (!legacyClientKeyCleared) {
    legacyClientKeyCleared = true;
    try {
      localStorage.removeItem(STORAGE_TMDB_KEY);
    } catch {
      // Storage can be unavailable (private mode); nothing else to do.
    }
  }
  return '';
}

/**
 * Server-only TMDB key. Never read in the browser: `process.env.TMDB_API_KEY`
 * is not inlined into the client bundle and the window guard keeps the value
 * on the server even though this module is shared with client components.
 */
function getServerOnlyKey(): string {
  if (typeof window !== 'undefined') return '';
  const env = process.env;
  return cleanKey(env.TMDB_API_KEY) || cleanKey(env.NEXT_PUBLIC_TMDB_API_KEY);
}

export function clearTmdbCache() {
  responseCache.clear();
  serverKeyChecked = false;
}

/** Occupancy and evictions, surfaced by /api/health: a bound you cannot see is a bound you cannot trust. */
export function getTmdbResponseCacheStats() {
  return responseCache.stats();
}

async function checkServerKeyStatus(): Promise<boolean> {
  if (serverKeyChecked) return serverHasKey;
  if (typeof window === 'undefined') {
    serverHasKey = Boolean(getServerOnlyKey());
    serverKeyChecked = true;
    return serverHasKey;
  }
  try {
    const res = await fetch('/api/tmdb/status', { cache: 'no-store' });
    if (res.ok) {
      const json = (await res.json()) as { hasServerKey?: boolean };
      serverHasKey = Boolean(json.hasServerKey);
    }
  } catch {
    serverHasKey = false;
  }
  serverKeyChecked = true;
  return serverHasKey;
}

export async function isTmdbConfigured(): Promise<boolean> {
  getClientStoredKey(); // discard the legacy browser key
  if (getServerOnlyKey()) return true;
  return checkServerKeyStatus();
}

export interface RawTmdbLogo {
  file_path?: string | null;
  iso_639_1?: string | null;
  vote_average?: number;
  vote_count?: number;
  aspect_ratio?: number;
  width?: number;
}

/**
 * Pick the title-treatment logo shown in place of the text title.
 *
 * Only English or language-neutral logos are used, because the page title
 * next to them is English. Raster PNGs are preferred over SVG uploads (some
 * SVGs embed fonts or huge path data that render inconsistently); very tall
 * logos (aspect < 1) are skipped because they would push the hero copy down.
 * Ties go to the most-voted logo, as on TMDB's own title pages.
 */
export function pickTitleLogo(logos: RawTmdbLogo[] | undefined): string | undefined {
  if (!Array.isArray(logos) || !logos.length) return undefined;
  const languageRank = (lang: string | null | undefined) =>
    lang === 'en' ? 0 : lang == null || lang === '' || lang === 'xx' ? 1 : -1;
  const best = logos
    .filter((logo) => {
      const path = typeof logo.file_path === 'string' ? logo.file_path : '';
      return (
        /^\/[A-Za-z0-9_-]+\.(png|svg)$/.test(path) &&
        languageRank(logo.iso_639_1) >= 0 &&
        (typeof logo.aspect_ratio !== 'number' || logo.aspect_ratio >= 1)
      );
    })
    .sort(
      (a, b) =>
        languageRank(a.iso_639_1) - languageRank(b.iso_639_1) ||
        Number(String(b.file_path).endsWith('.png')) - Number(String(a.file_path).endsWith('.png')) ||
        Number(b.vote_average || 0) - Number(a.vote_average || 0) ||
        Number(b.vote_count || 0) - Number(a.vote_count || 0)
    )[0];
  if (!best?.file_path) return undefined;
  return `${TMDB_IMG_BASE}/w500${best.file_path}`;
}

interface RawTmdbObject {
  id?: number;
  media_type?: string;
  type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  genres?: Array<{ id?: number; name?: string }>;
  genre_ids?: number[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  adult?: boolean;
  tagline?: string;
  overview?: string;
  status?: string;
  original_language?: string;
  imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
  seasons?: Array<{
    season_number?: number;
    name?: string;
    episode_count?: number;
    air_date?: string;
  }>;
  created_by?: Array<{ name?: string }>;
  networks?: Array<{ name?: string }>;
  production_companies?: Array<{ name?: string }>;
  credits?: {
    cast?: Array<{
      id?: number;
      name?: string;
      character?: string;
      roles?: Array<{ character?: string }>;
      profile_path?: string | null;
    }>;
    crew?: Array<{ job?: string; name?: string }>;
  };
  images?: {
    logos?: RawTmdbLogo[];
  };
  videos?: {
    results?: Array<{
      id?: string;
      key?: string;
      name?: string;
      site?: string;
      type?: string;
      official?: boolean;
      published_at?: string;
    }>;
  };
  recommendations?: { results?: RawTmdbObject[] };
  similar?: { results?: RawTmdbObject[] };
  release_dates?: {
    results?: Array<{
      iso_3166_1?: string;
      release_dates?: Array<{ certification?: string; type?: number; release_date?: string }>;
    }>;
  };
  content_ratings?: {
    results?: Array<{ iso_3166_1?: string; rating?: string }>;
  };

}

interface TmdbListEnvelope {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: RawTmdbObject[];
}

/**
 * Native fetch abort support varies between browser runtimes and test
 * environments. Racing the request as well as aborting it guarantees that a
 * stalled upstream cannot keep an entire route in a loading state.
 */
async function fetchTmdbWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = TMDB_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort();

  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('TMDB request timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

/**
 * Lets ISR callers tell "TMDB says not found" from "TMDB unavailable", and
 * reports when the data was actually served (epoch ms). That time comes from
 * the response's Date header, which survives Next's data cache and the
 * catalogue proxy cache, so a cached page never claims to be fresher than it is.
 */
export type TmdbFetchOutcome = { upstreamFailed?: boolean; fetchedAt?: number };

function servedAt(res: Response): number {
  // Minimal Response stand-ins (tests, polyfills) may carry no headers.
  const header = Date.parse(res.headers?.get?.('date') || '');
  const now = Date.now();
  // Ignore missing headers and clocks in the future.
  return Number.isFinite(header) && header <= now + 60_000 ? Math.min(header, now) : now;
}

async function tmdbFetch<T = TmdbListEnvelope>(
  endpoint: string,
  params: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
  outcome?: TmdbFetchOutcome
): Promise<T | null> {
  const directKey = getServerOnlyKey();
  const hasServer = directKey ? false : await checkServerKeyStatus();

  if (!directKey && !hasServer) {
    return null;
  }

  const cleanEndpoint = endpoint.replace(/^\/+/, '');
  const queryEntries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== ''
  );
  const cacheKey = `${
    directKey ? directKey.slice(0, 8) : 'srv'
  }:${cleanEndpoint}?${queryEntries.map(([k, v]) => `${k}=${v}`).join('&')}`;

  const cached = responseCache.get(cacheKey);
  if (cached) {
    if (outcome) outcome.fetchedAt = cached.fetchedAt;
    return cached.data as T;
  }

  try {
    let res: Response;
    if (directKey) {
      const url = new URL(`${serverTmdbBase()}/${cleanEndpoint}`);
      for (const [k, v] of queryEntries) {
        url.searchParams.set(k, String(v));
      }
      const isBearer = directKey.startsWith('eyJ') || directKey.length > 60;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (isBearer) {
        headers.Authorization = `Bearer ${directKey}`;
      } else {
        url.searchParams.set('api_key', directKey);
      }
      res = await fetchTmdbWithDeadline(url.toString(), {
        headers,
        signal,
        // Server renders read through Next's persistent data cache; the
        // browser keeps its own in-memory cache instead.
        ...(typeof window === 'undefined'
          ? { next: { revalidate: serverRevalidateSeconds(cleanEndpoint) } }
          : {}),
      });
    } else {
      const qs = new URLSearchParams();
      for (const [k, v] of queryEntries) {
        qs.set(k, String(v));
      }
      const queryStr = qs.toString();
      // The browser proxy lives under /api/tmdb/status (the catch-all route is
      // app/api/tmdb/status/[...path]); omitting the segment 404s every
      // client-side catalogue read, including the player's title lookup.
      res = await fetchTmdbWithDeadline(
        `/api/tmdb/status/${cleanEndpoint}${queryStr ? `?${queryStr}` : ''}`,
        { signal }
      );
    }

    if (!res.ok) {
      if (outcome && res.status !== 404) outcome.upstreamFailed = true;
      return null;
    }

    const data = (await res.json()) as T;
    const fetchedAt = servedAt(res);
    if (outcome) outcome.fetchedAt = fetchedAt;
    responseCache.set(cacheKey, { data, fetchedAt }, CACHE_TTL_MS / 1000);
    return data;
  } catch {
    if (outcome) outcome.upstreamFailed = true;
    return null;
  }
}

export function normalizeTmdbItem(
  raw: RawTmdbObject | null | undefined,
  forcedType?: MediaType
): MediaItem | null {
  if (!raw || !raw.id) return null;
  if (raw.media_type === 'person') return null;

  const type: MediaType =
    forcedType ||
    (raw.media_type === 'tv' || (!raw.title && raw.name) ? 'tv' : 'movie');

  const title = normalizeDisplayTitle(String(raw.title || raw.name || raw.original_title || raw.original_name || ''));
  if (!isClean({ title })) return null;
  const dateStr: string = raw.release_date || raw.first_air_date || '';
  const year = dateStr ? dateStr.slice(0, 4) : '—';
  const released = isReleased({ releaseDate: dateStr });

  const genreIds: number[] = Array.isArray(raw.genre_ids)
    ? raw.genre_ids
    : Array.isArray(raw.genres)
      ? raw.genres.map((g) => Number(g.id || 0)).filter(Boolean)
      : [];

  const genres =
    Array.isArray(raw.genres) && raw.genres.length
      ? raw.genres
          .map((g) => g.name || '')
          .filter(Boolean)
          .slice(0, 3)
      : mapGenreIds(genreIds);

  const posterPath = raw.poster_path || null;
  const backdropPath = raw.backdrop_path || null;

  const rating =
    typeof raw.vote_average === 'number' && raw.vote_average > 0
      ? raw.vote_average
      : 0;

  let lengthLabel = type === 'movie' ? 'Movie' : 'Series';
  if (type === 'movie' && typeof raw.runtime === 'number' && raw.runtime > 0) {
    lengthLabel = formatRuntime(raw.runtime);
  } else if (
    type === 'tv' &&
    typeof raw.number_of_seasons === 'number' &&
    raw.number_of_seasons > 0
  ) {
    lengthLabel = `${raw.number_of_seasons} Season${
      raw.number_of_seasons > 1 ? 's' : ''
    }`;
  }

  // Discover/search payloads often omit ratings. Do not fabricate a regional
  // certification: title detail data supplies an explicit country fallback.
  const cert = extractCertification(raw, type);

  return {
    id: String(raw.id),
    tmdbId: Number(raw.id),
    type,
    title,
    posterUrl: tmdbImage(posterPath, 'w342', 'poster'),
    posterSrcSet: tmdbSrcSet(posterPath, 'poster'),
    backdropUrl: tmdbImage(backdropPath, 'w1280', 'backdrop'),
    backdropThumbUrl: tmdbImage(backdropPath, 'w780', 'backdrop'),
    backdropSrcSet: tmdbSrcSet(backdropPath, 'backdrop'),
    genres,
    genreIds,
    year,
    ...(dateStr ? { releaseDate: dateStr } : {}),
    lengthLabel,
    rating,
    voteCount: Number(raw.vote_count || 0),
    popularity: Number(raw.popularity || 0),
    cert,
    sourcesCount: released ? THIRD_PARTY_SOURCES.length : 0,
    tagline: raw.tagline || undefined,
    overview:
      raw.overview || MISSING_SYNOPSIS_TEXT,
  };
}

function extractCertification(raw: RawTmdbObject, type: MediaType): string {
  return extractListedCertification(raw, type) ?? (raw.adult ? '18+' : 'Not rated');
}

/** Return only actual certifications for each market. The detail document stays
 * cacheable across visitors; the client selects the appropriate fact from it. */
function certificationsByRegion(raw: RawTmdbObject, type: MediaType): Partial<Record<WatchRegion, string>> {
  const out: Partial<Record<WatchRegion, string>> = {};
  if (type === 'movie' && Array.isArray(raw.release_dates?.results)) {
    for (const entry of raw.release_dates.results) {
      if (!isWatchRegion(entry?.iso_3166_1) || !Array.isArray(entry.release_dates)) continue;
      const cert = entry.release_dates.find((date) => typeof date?.certification === 'string' && date.certification.trim())?.certification?.trim();
      if (cert) out[entry.iso_3166_1] ??= cert;
    }
  } else if (type === 'tv' && Array.isArray(raw.content_ratings?.results)) {
    for (const entry of raw.content_ratings.results) {
      if (isWatchRegion(entry?.iso_3166_1) && typeof entry.rating === 'string' && entry.rating.trim()) {
        out[entry.iso_3166_1] ??= entry.rating.trim();
      }
    }
  }
  return out;
}

/** Global fallback used for the existing SEO facts, never as a market rating. */
function extractListedCertification(raw: RawTmdbObject, type: MediaType): string | null {
  const ratings = certificationsByRegion(raw, type);
  return CERTIFICATION_REGION_FALLBACKS.map((region) => ratings[region]).find(Boolean) ?? null;
}

/* ============================================================================
   HOME, OTT PLATFORM, ANIME, DOCS, & CURATED FEEDS
   ============================================================================ */

function pickFeaturedTrendingBest(
  trendingDayAll: MediaItem[],
  trendingWeekAll: MediaItem[],
  limit = HERO_RULE.limit
): MediaItem[] {
  // One rule, shared with the client hero (lib/home-curation.ts): released,
  // >= 500 votes, rated >= 7.0. The carousel is an invitation to press Play, so
  // a title that cannot be played tonight is never promoted into it.
  const eligible = curateHero(
    { trending: [...trendingDayAll, ...trendingWeekAll] },
    { limit: limit * 6 }
  );
  if (eligible.length <= limit) return eligible;

  const indexMap = new Map<string, number>();
  eligible.forEach((item, idx) => indexMap.set(`${item.type}:${item.id}`, idx));

  const picked: MediaItem[] = [];
  const pickedKeys = new Set<string>();
  const addItem = (item: MediaItem) => {
    const key = `${item.type}:${item.id}`;
    if (pickedKeys.has(key)) return;
    pickedKeys.add(key);
    picked.push(item);
  };

  // Ensure both top trending movies and top trending series appear in the header carousel
  const topMovies = eligible.filter((i) => i.type === 'movie').slice(0, 3);
  const topSeries = eligible.filter((i) => i.type === 'tv').slice(0, 2);
  for (const m of topMovies.slice(0, 2)) addItem(m);
  for (const s of topSeries) addItem(s);
  for (const m of topMovies.slice(2)) addItem(m);

  for (const item of eligible) {
    if (picked.length >= limit) break;
    addItem(item);
  }

  picked.sort(
    (a, b) =>
      (indexMap.get(`${a.type}:${a.id}`) ?? 999) -
      (indexMap.get(`${b.type}:${b.id}`) ?? 999)
  );
  return picked.slice(0, limit);
}

export async function fetchHomeFeed(): Promise<HomeFeedData> {
  const configured = await isTmdbConfigured();
  if (!configured) {
    return getFallbackHomeFeed();
  }

  const [
    trendingDayRes,
    trendingWeekRes,
    topMoviesRes,
    popularMoviesRes,
    popularTvRes,
    nowPlayingRes,
    upcomingRes,
  ] = await Promise.all([
    tmdbFetch('/trending/all/day', { language: 'en-US' }),
    tmdbFetch('/trending/all/week', { language: 'en-US' }),
    tmdbFetch('/movie/top_rated', { language: 'en-US', page: 1 }),
    // /movie/popular is audience pull; /tv/top_rated is rating. Both are
    // reported under the label that matches the endpoint they come from.
    tmdbFetch('/movie/popular', { language: 'en-US', page: 1 }),
    tmdbFetch('/tv/top_rated', { language: 'en-US', page: 1 }),
    tmdbFetch('/movie/now_playing', { language: 'en-US', page: 1 }),
    // The only source of genuinely unreleased titles: the "Coming soon" shelf
    // (lib/home-curation.ts). Nothing from this list may enter the hero.
    tmdbFetch('/movie/upcoming', { language: 'en-US', page: 1 }),
  ]);

  const trendingDayAll: MediaItem[] = (trendingDayRes?.results || [])
    .map((r) => normalizeTmdbItem(r))
    .filter((x): x is MediaItem => x !== null);
  const trendingToday: MediaItem[] = curateTopTen(trendingDayAll);
  const todayIds = new Set(trendingToday.map((t) => `${t.type}:${t.id}`));

  const trendingWeekAll: MediaItem[] = (trendingWeekRes?.results || [])
    .map((r) => normalizeTmdbItem(r))
    .filter((x): x is MediaItem => x !== null);

  // Each ranking stands on its own. A missing day chart must not discard a
  // valid week chart, and today's titles must never be relabelled as weekly.
  if (!trendingDayAll.length && !trendingWeekAll.length) return getFallbackHomeFeed();

  const featuredCandidates = pickFeaturedTrendingBest(
    trendingDayAll,
    trendingWeekAll,
    5
  );

  const trendingWeek: MediaItem[] = trendingWeekAll.filter((item) => isShelfEligible(item)).slice(0, 14);

  // Top-rated rails only list titles with real vote volume.
  const topRated: MediaItem[] = (topMoviesRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x) && isTopRatedEligible('movie', x.voteCount))
    .slice(0, 14);

  const popularMovies: MediaItem[] = (popularMoviesRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x))
    .slice(0, 14);

  const popularSeries: MediaItem[] = (popularTvRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'tv'))
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x) && isTopRatedEligible('tv', x.voteCount))
    .slice(0, 14);

  const readyToPlay: MediaItem[] = (nowPlayingRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter(
      (x): x is MediaItem =>
        x !== null && isShelfEligible(x) && x.sourcesCount > 0 && !todayIds.has(`${x.type}:${x.id}`)
    )
    .slice(0, 14);

  // "Popular right now" is one shelf with one guarantee: every card carries a
  // real rating (see lib/ratings.ts). Weekly trending leads because it is the
  // widest audience signal; the popular lists add volume of their own.
  const popularNow = curatePopular(
    [...trendingWeek, ...popularMovies, ...popularSeries],
    { limit: 30 }
  );

  // /movie/upcoming's primary release date is not necessarily theatrical.
  // Verify type 2/3 release events and identify the market before claiming it.
  const upcomingCandidates = (upcomingRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter((x): x is MediaItem => x !== null && isComingSoonEligible(x))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 20);
  const withTheatricalDates = await Promise.all(upcomingCandidates.map(async (item) => {
    const raw = await tmdbFetch<RawTmdbObject>(`/movie/${item.id}`, { language: 'en-US', append_to_response: 'release_dates' });
    const events = (raw?.release_dates?.results || []).flatMap(region =>
      (region.release_dates || []).flatMap(event => {
        const date = event.release_date?.slice(0, 10) || '';
        const country = region.iso_3166_1 || '';
        return (event.type === 2 || event.type === 3) && /^[A-Z]{2}$/.test(country) && isUpcoming({ releaseDate: date })
          ? [{ date, country }] : [];
      })
    ).sort((a, b) => a.date.localeCompare(b.date) || a.country.localeCompare(b.country));
    const event = events[0];
    return event ? { ...item, theatricalReleaseDate: event.date, theatricalRegion: event.country } : null;
  }));
  const comingSoon = curateComingSoon(withTheatricalDates.filter((item): item is MediaItem & { theatricalReleaseDate: string; theatricalRegion: string } => item !== null), { limit: 8 });

  // Spotlight metadata is read from the canonical detail request, not the
  // thinner trending payload. This keeps rating, votes and country-specific
  // certification aligned with the detail page and shares its cache key.
  const featuredDetails = await Promise.all(
    featuredCandidates.map(async (item) => {
      if (!item.tmdbId) return item;
      const detail = await fetchMediaDetail(item.type, item.id);
      return detail
        ? {
            ...item,
            rating: detail.rating,
            voteCount: detail.voteCount,
            cert: detail.cert,
            lengthLabel: detail.lengthLabel,
            sourcesCount: detail.sourcesCount,
            ...(detail.releaseDate ? { releaseDate: detail.releaseDate } : {}),
            ...(detail.logoUrl ? { logoUrl: detail.logoUrl } : {}),
          }
        : item;
    })
  );
  const featured = curateHero({ featured: featuredDetails });
  const canonicalByKey = new Map(
    featuredDetails.map((item) => [`${item.type}:${item.id}`, item])
  );
  const applyCanonicalSnapshot = (items: MediaItem[]) =>
    items.map((item) => canonicalByKey.get(`${item.type}:${item.id}`) || item);
  const consistentTrendingToday = curateTopTen(applyCanonicalSnapshot(trendingToday));

  const allPool = [
    ...consistentTrendingToday,
    ...trendingWeek,
    ...topRated,
    ...readyToPlay,
    ...popularSeries,
  ];

  const worldBackdrops: Record<string, { imageUrl: string; countLabel: string }> = {};
  const fallbackWorlds = getFallbackHomeFeed().worldBackdrops;

  for (const w of WORLD_GENRES) {
    const match = allPool.find((item) => item.genres.includes(w.genre));
    worldBackdrops[w.genre] = {
      imageUrl: match ? match.backdropThumbUrl : fallbackWorlds[w.genre].imageUrl,
      countLabel: `Explore ${w.genre}`,
    };
  }

  // Algorithmic: the best-rated title not already in the hero. It must never
  // be labelled an editorial selection (see lib/playability.ts and docs).
  const topRatedPick =
    topRated.find((m) => !featured.some((f) => f.id === m.id)) ||
    topRated[0] ||
    featured[0] ||
    null;

  debugDataSnapshot('home-feed', {
    featured: featured.map((item) => ({
      id: item.id,
      type: item.type,
      rating: item.rating,
      voteCount: item.voteCount,
      cert: item.cert,
    })),
  });

  return {
    featured,
    trendingToday: consistentTrendingToday,
    trendingWeek,
    topRated,
    popularMovies,
    popularSeries,
    readyToPlay: readyToPlay.length ? readyToPlay : topRated.slice(0, 10),
    popularNow,
    comingSoon,
    // Resolved by the deferred feed (`/api/feeds/home-full`), never by the
    // document: the shelf sits below the fold and costs 12 TMDB requests.
    collectionStacks: [],
    topRatedPick,
    worldBackdrops,
    isLive: true,
  };
}

/**
 * Dedicated Anime Feed (Japanese-language animation across Series & Movies)
 */
export async function fetchAnimeFeed(): Promise<AnimeFeedData> {
  const configured = await isTmdbConfigured();
  if (!configured) {
    return getFallbackAnimeFeed();
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const minDate = twoYearsAgo.toISOString().slice(0, 10);

  const animeBase = {
    with_genres: '16',
    with_original_language: 'ja',
    language: 'en-US',
    page: 1,
  };

  const [seriesRes, moviesRes, topSeriesRes, topMovieRes, newSeriesRes] =
    await Promise.all([
      tmdbFetch('/discover/tv', {
        ...animeBase,
        sort_by: 'popularity.desc',
        'vote_count.gte': 400,
      }),
      tmdbFetch('/discover/movie', {
        ...animeBase,
        sort_by: 'popularity.desc',
        'vote_count.gte': 400,
      }),
      tmdbFetch('/discover/tv', {
        ...animeBase,
        sort_by: 'vote_average.desc',
        'vote_count.gte': 300,
      }),
      tmdbFetch('/discover/movie', {
        ...animeBase,
        sort_by: 'vote_average.desc',
        'vote_count.gte': 500,
      }),
      tmdbFetch('/discover/tv', {
        ...animeBase,
        sort_by: 'first_air_date.desc',
        'first_air_date.gte': minDate,
        'first_air_date.lte': todayStr,
        'vote_count.gte': 15,
      }),
    ]);

  const popularSeries = (seriesRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'tv'))
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x))
    .slice(0, 16);

  const animeMovies = (moviesRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x))
    .slice(0, 16);

  const topRated = [
    ...(topSeriesRes?.results || []).map((r) => normalizeTmdbItem(r, 'tv')),
    ...(topMovieRes?.results || []).map((r) => normalizeTmdbItem(r, 'movie')),
  ]
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 16);

  const newReleases = (newSeriesRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'tv'))
    .filter((x): x is MediaItem => x !== null && isShelfEligible(x))
    .slice(0, 16);

  const featured = curateHero({ featured: [...popularSeries, ...animeMovies] });

  if (!featured.length) {
    return getFallbackAnimeFeed();
  }

  return {
    featured,
    popularSeries,
    animeMovies,
    topRated,
    newReleases,
    isLive: true,
  };
}

/**
 * Author's Choice Curated Row (fetches lightweight details in parallel & caches for session)
 */
export async function fetchAuthorsChoice(
  category: 'all' | 'movie' | 'tv' | 'anime' | 'documentary',
  { authoredOnly = false }: { authoredOnly?: boolean } = {}
): Promise<MediaItem[]> {
  if (!authoredOnly && !(await isTmdbConfigured())) {
    return [...FALLBACK_TITLES].filter((item) => isShelfEligible(item))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 12);
  }

  let picks: readonly CuratedChoiceItem[];
  if (category === 'movie') picks = AUTHORS_CHOICE_MOVIES.slice(0, 12);
  else if (category === 'tv') picks = AUTHORS_CHOICE_TV.slice(0, 12);
  else if (category === 'anime') picks = AUTHORS_CHOICE_ANIME.slice(0, 12);
  else if (category === 'documentary')
    picks = AUTHORS_CHOICE_DOCUMENTARIES.slice(0, 12);
  else {
    picks = [
      ...AUTHORS_CHOICE_MOVIES.slice(0, 4),
      ...AUTHORS_CHOICE_TV.slice(0, 4),
      ...AUTHORS_CHOICE_ANIME.slice(0, 2),
      ...AUTHORS_CHOICE_DOCUMENTARIES.slice(0, 2),
    ];
  }

  return resolveCuratedTitles(picks);
}

/** Resolve the exact register; never substitute unrelated sample titles. */
export async function resolveCuratedTitles(picks: readonly CuratedChoiceItem[]): Promise<MediaItem[]> {
  const configured = await isTmdbConfigured();
  if (!configured) {
    return picks.flatMap((entry) => {
      const item = FALLBACK_TITLES.find((title) => title.type === entry.mediaType && title.tmdbId === entry.tmdbId);
      return item && isShelfEligible(item) ? [{ ...item, editorialNote: entry.note }] : [];
    });
  }

  const fetched = await Promise.all(
    picks.map(async (entry) => {
      const raw = await tmdbFetch<RawTmdbObject>(
        `/${entry.mediaType}/${entry.tmdbId}`,
        { language: 'en-US' }
      );
      const item = normalizeTmdbItem(raw, entry.mediaType);
      if (!item || item.tmdbId !== entry.tmdbId || !isShelfEligible(item)) return null;
      return {
        ...item,
        editorialNote: entry.note,
      } as MediaItem;
    })
  );

  return fetched.filter((x): x is MediaItem => x !== null);
}

/**
 * Contextual "Because You Watched [Title]" Row
 */
export async function fetchBecauseYouWatched(
  seed: MediaItem,
  dislikedKeys: ReadonlySet<string>
): Promise<{ seedTitle: string; items: MediaItem[] } | null> {
  if (!seed.tmdbId) {
    const fallbackItems = FALLBACK_TITLES.filter(
      (x) =>
        isRecommendationEligible(x) && x.id !== seed.id &&
        !dislikedKeys.has(`${x.type}:${x.id}`) &&
        x.genres.some((g) => seed.genres.includes(g))
    ).slice(0, 12);
    return fallbackItems.length >= 3
      ? { seedTitle: seed.title, items: fallbackItems }
      : null;
  }

  const configured = await isTmdbConfigured();
  if (!configured) return null;

  const [recRes, simRes] = await Promise.all([
    tmdbFetch(`/${seed.type}/${seed.tmdbId}/recommendations`, {
      language: 'en-US',
      page: 1,
    }),
    tmdbFetch(`/${seed.type}/${seed.tmdbId}/similar`, {
      language: 'en-US',
      page: 1,
    }),
  ]);

  const combined = [...(recRes?.results || []), ...(simRes?.results || [])];
  const seen = new Set<string>([`${seed.type}:${seed.id}`]);
  const out: MediaItem[] = [];

  for (const r of combined) {
    const item = normalizeTmdbItem(r, seed.type);
    if (!item || !isRecommendationEligible(item)) continue;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key) || dislikedKeys.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 14) break;
  }

  return out.length >= 3 ? { seedTitle: seed.title, items: out } : null;
}

/**
 * "Because you saved {Genre} titles" home rail: what is popular inside the
 * visitor's most-saved genre, excluding everything already in the library.
 * The genre id is resolved per media type (movie 878 ↔ tv 10765), so a genre
 * the visitor saved through films still finds its series equivalent honestly.
 */
export async function fetchBecauseYouSaved(
  genreId: number,
  excludeKeys: ReadonlySet<string>
): Promise<MediaItem[]> {
  const keep = (item: MediaItem) =>
    !excludeKeys.has(`${item.type}:${item.id}`) && !excludeKeys.has(item.id) && isRecommendationEligible(item);
  const configured = await isTmdbConfigured();
  if (!configured) {
    return FALLBACK_TITLES.filter(
      (t) => (t.genreIds || []).includes(genreId) && keep(t)
    ).slice(0, 14);
  }

  const name = TMDB_GENRE_NAMES[genreId] || '';
  const movieGenre = (name && getTmdbGenreFilterId('movie', name)) || String(genreId);
  const tvGenre = (name && getTmdbGenreFilterId('tv', name)) || '';

  const [mRes, tvRes] = await Promise.all([
    tmdbFetch('/discover/movie', {
      with_genres: movieGenre,
      sort_by: 'popularity.desc',
      'vote_count.gte': 150,
      language: 'en-US',
      include_adult: 'false',
      page: 1,
    }),
    tvGenre
      ? tmdbFetch('/discover/tv', {
          with_genres: tvGenre,
          sort_by: 'popularity.desc',
          'vote_count.gte': 100,
          language: 'en-US',
          include_adult: 'false',
          page: 1,
        })
      : Promise.resolve(null),
  ]);

  const movies = (mRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter((x): x is MediaItem => x !== null && keep(x));
  const series = (tvRes?.results || [])
    .map((r) => normalizeTmdbItem(r, 'tv'))
    .filter((x): x is MediaItem => x !== null && keep(x));

  // Interleave so the rail mixes films and series instead of one type first.
  const out: MediaItem[] = [];
  for (let i = 0; out.length < 14 && (i < movies.length || i < series.length); i++) {
    if (i < movies.length) out.push(movies[i]);
    if (i < series.length) out.push(series[i]);
  }
  return out;
}

/**
 * "Under 2 hours" home rail: feature films that fit one sitting, aligned with
 * the visitor's strongest saved/favourite genres when they exist. Runtime is
 * verified on TMDB (`with_runtime.lte`) or parsed from the sample catalogue's
 * explicit length labels — never asserted from a guess.
 */
export async function fetchShortWatchPicks(
  genreIds: number[],
  excludeKeys: ReadonlySet<string>,
  maxMinutes = 120
): Promise<MediaItem[]> {
  const keep = (item: MediaItem) => !excludeKeys.has(`${item.type}:${item.id}`) && isShelfEligible(item);
  const configured = await isTmdbConfigured();
  if (!configured) {
    const minutesOf = (label: string): number | null => {
      const m = /(\d+)h\s*(\d+)m/.exec(label);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    return FALLBACK_TITLES.filter((t) => {
      if (t.type !== 'movie' || !keep(t)) return false;
      const minutes = minutesOf(t.lengthLabel);
      return minutes !== null && minutes <= maxMinutes;
    }).slice(0, 14);
  }

  const p: Record<string, string | number | undefined> = {
    language: 'en-US',
    include_adult: 'false',
    page: 1,
    sort_by: 'popularity.desc',
    'vote_count.gte': 200,
    'with_runtime.lte': maxMinutes,
  };
  const genreFilter = genreIds
    .map((gid) => getTmdbGenreFilterId('movie', TMDB_GENRE_NAMES[gid] || '') || gid)
    .slice(0, 2);
  if (genreFilter.length) p.with_genres = genreFilter.join('|');

  const res = await tmdbFetch('/discover/movie', p);
  return (res?.results || [])
    .map((r) => normalizeTmdbItem(r, 'movie'))
    .filter((x): x is MediaItem => x !== null && keep(x))
    .slice(0, 14);
}

/**
 * Personalized CineMatch Recommendations Row
 */
export async function fetchCineMatchForYou(
  profile: CineMatchProfile,
  dislikedKeys: ReadonlySet<string>
): Promise<MediaItem[]> {
  if (profile.enabled === false) {
    profile = { completedOnboarding: false, seeds: [], likedKeys: [], dislikedKeys: [], genreWeights: {} };
    dislikedKeys = new Set();
  }
  const configured = await isTmdbConfigured();
  if (!configured) {
    return FALLBACK_TITLES.filter(
      (t) => isRecommendationEligible(t) && !dislikedKeys.has(`${t.type}:${t.id}`)
    ).slice(0, 12).map(item => ({ ...item, recommendationReason: 'Sample discovery pick · live recommendations are unavailable' }));
  }

  // Pick top 2 weighted genres + up to 2 onboarding/liked seeds
  const topGenres = Object.entries(profile.genreWeights)
    .map(([gid, w]) => [Number(gid), w] as const)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([gid]) => gid);

  const seedSample = profile.seeds.slice(0, 2);

  const requests: Array<Promise<TmdbListEnvelope | null>> = [];
  for (const s of seedSample) {
    requests.push(
      tmdbFetch(`/${s.mediaType}/${s.tmdbId}/recommendations`, {
        language: 'en-US',
        page: 1,
      })
    );
  }
  if (topGenres.length > 0) {
    requests.push(
      tmdbFetch('/discover/movie', {
        with_genres: topGenres.join('|'),
        sort_by: 'popularity.desc',
        'vote_count.gte': 250,
        language: 'en-US',
        page: 1,
      })
    );
  } else if (requests.length === 0) {
    requests.push(tmdbFetch('/trending/all/week', { language: 'en-US' }));
  }

  const responses = await Promise.all(requests);
  const seedKeys = new Set(
    profile.seeds.map((s) => `${s.mediaType}:${s.tmdbId}`)
  );
  const seen = new Set<string>();
  const candidates: Array<{ item: MediaItem; affinity: number }> = [];

  for (const res of responses) {
    for (const raw of res?.results || []) {
      const item = normalizeTmdbItem(raw);
      if (!item || !isRecommendationEligible(item)) continue;
      const key = `${item.type}:${item.id}`;
      if (seen.has(key) || seedKeys.has(key) || dislikedKeys.has(key)) continue;
      seen.add(key);

      let genreBoost = 0;
      for (const gid of item.genreIds || []) {
        genreBoost += profile.genreWeights[gid] || 0;
      }
      const affinity = item.rating * 8 + Math.min(25, genreBoost * 4);
      const matchPct = Math.min(99, Math.max(72, Math.round(affinity)));
      candidates.push({
        item: {
          ...item,
          ...(topGenres.length || seedSample.length ? { matchPct } : {}),
          recommendationReason: genreBoost > 0
            ? `Because you like ${item.genres.filter((_, index) => (profile.genreWeights[item.genreIds?.[index] || 0] || 0) > 0).join(', ') || 'similar genres'}`
            : seedSample.length ? 'More like your favorites' : 'Popular this week',
        },
        affinity,
      });
    }
  }

  candidates.sort((a, b) => b.affinity - a.affinity);
  return candidates.slice(0, 16).map((c) => c.item);
}

/* ============================================================================
   CATALOGUE DISCOVER (Movies, Series, Anime, Documentaries + OTT Provider)
   ============================================================================ */

export async function fetchBrowseCatalogue(params: {
  mode: 'movie' | 'tv' | 'anime' | 'documentary';
  genre?: string;
  sort?: string;
  onlyWithSources?: boolean;
  page?: number;
  /**
   * Blended modes (anime / documentaries) only: limit to films or series in
   * TMDB itself, so every page is a full page of that format.
   */
  format?: 'all' | MediaType;
}): Promise<PaginatedResult> {
  const {
    mode,
    genre = '',
    sort = 'popularity',
    onlyWithSources = false,
    page = 1,
  } = params;

  const configured = await isTmdbConfigured();
  if (!configured) {
    return getFallbackBrowse(mode, genre, sort, onlyWithSources);
  }

  const buildTypeParams = (type: MediaType) => buildBrowseDiscoverParams({ type, mode, genre, sort, page, onlyWithSources });

  // Blended modes (Anime & Documentaries fetch both Movies and Series!)
  if (mode === 'anime' || mode === 'documentary') {
    const format = params.format ?? 'all';
    const [mRes, tvRes] = await Promise.all([
      format !== 'tv' ? tmdbFetch('/discover/movie', buildTypeParams('movie')) : Promise.resolve(null),
      format !== 'movie' ? tmdbFetch('/discover/tv', buildTypeParams('tv')) : Promise.resolve(null),
    ]);

    let combined: MediaItem[] = [
      ...(mRes?.results || []).map((r) => normalizeTmdbItem(r, 'movie')),
      ...(tvRes?.results || []).map((r) => normalizeTmdbItem(r, 'tv')),
    ].filter((x): x is MediaItem => x !== null);

    if (onlyWithSources) {
      combined = combined.filter((x) => x.sourcesCount > 0);
    }

    if (sort === 'top_rated') combined.sort((a, b) => b.rating - a.rating);
    else if (sort === 'newest')
      combined.sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
    else if (sort === 'az')
      combined.sort((a, b) => a.title.localeCompare(b.title));
    else combined.sort((a, b) => b.popularity - a.popularity);

    const totalRes =
      Number(mRes?.total_results || 0) + Number(tvRes?.total_results || 0);

    return {
      items: combined,
      page,
      ...tmdbPageCount(mRes?.total_pages, tvRes?.total_pages),
      totalResults: totalRes || combined.length,
      isLive: Boolean(mRes?.results || tvRes?.results),
      unavailable: !mRes?.results && !tvRes?.results,
    };
  }

  // Single-type mode (Movies or Series)
  const data = await tmdbFetch(`/discover/${mode}`, buildTypeParams(mode));
  if (!data?.results) {
    return getFallbackBrowse(mode, genre, sort, onlyWithSources);
  }

  let items: MediaItem[] = (data.results || [])
    .map((r) => normalizeTmdbItem(r, mode))
    .filter((x): x is MediaItem => x !== null);

  if (onlyWithSources) {
    items = items.filter((t) => t.sourcesCount > 0);
  }

  return {
    items,
    page: Number(data.page || page),
    ...tmdbPageCount(data.total_pages),
    totalResults: Number(data.total_results || items.length),
    isLive: true,
  };
}

/* ============================================================================
   DETAIL, SEASONS, QUICK-PREVIEW TRAILER, & HYBRID SEARCH
   ============================================================================ */

type RawTmdbVideo = NonNullable<
  NonNullable<RawTmdbObject['videos']>['results']
>[number];

const VIDEO_TYPE_RANK: Record<string, number> = {
  Trailer: 0,
  Teaser: 1,
  Clip: 2,
};

function normalizeTmdbVideos(rawVideos?: RawTmdbVideo[]): VideoItem[] {
  const seenKeys = new Set<string>();
  const seenTitles = new Set<string>();

  return (rawVideos || [])
    .filter((video) =>
      video.site === 'YouTube' &&
      video.official === true &&
      Boolean(video.key) &&
      Object.hasOwn(VIDEO_TYPE_RANK, String(video.type || ''))
    )
    .map((video) => ({
      id: String(video.id || video.key),
      key: String(video.key),
      name: String(video.name || 'Official video'),
      site: 'YouTube',
      type: String(video.type),
      official: Boolean(video.official),
      ...(video.published_at && Number.isFinite(Date.parse(video.published_at))
        ? { publishedAt: new Date(video.published_at).toISOString() }
        : {}),
    }))
    .sort((a, b) =>
      Number(b.official) - Number(a.official) ||
      VIDEO_TYPE_RANK[a.type] - VIDEO_TYPE_RANK[b.type] ||
      a.name.localeCompare(b.name)
    )
    .filter((video) => {
      const titleKey = video.name
        .toLowerCase()
        .replace(/\b(official|trailer|teaser|clip|subtitled|dubbed|international|global|english|hindi|urdu|us|uk)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (seenKeys.has(video.key) || seenTitles.has(titleKey)) return false;
      seenKeys.add(video.key);
      seenTitles.add(titleKey);
      return true;
    })
    .slice(0, 12);
}

/** Lazy video catalogue for the detail-page Videos section. */
export async function fetchMediaVideos(
  type: MediaType,
  idOrSlug: string
): Promise<VideoItem[]> {
  const id = extractMediaId(idOrSlug);
  if (!/^\d+$/.test(id) || !(await isTmdbConfigured())) return [];

  const data = await tmdbFetch<RawTmdbObject['videos']>(`/${type}/${id}/videos`, {
    language: 'en-US',
  });
  return normalizeTmdbVideos(data?.results);
}

export async function fetchQuickPreviewTrailerKey(
  type: MediaType,
  tmdbId?: number
): Promise<string | null> {
  if (!tmdbId) return null;
  const videos = await fetchMediaVideos(type, String(tmdbId));
  return pickOfficialTrailer(videos)?.key || null;
}

/** Official trailer → any trailer → teaser → first official video. */
export function pickOfficialTrailer(videos: VideoItem[]): VideoItem | null {
  return (
    videos.find((video) => video.type === 'Trailer' && video.official) ||
    videos.find((video) => video.type === 'Trailer') ||
    videos.find((video) => video.type === 'Teaser') ||
    videos[0] ||
    null
  );
}

function normalizeRecommendation(raw: RawTmdbObject, type: MediaType): MediaItem | null {
  if (!raw.poster_path || (raw.media_type && raw.media_type !== type) ||
      (!raw.media_type && type === 'movie' && !!raw.first_air_date && !raw.release_date) ||
      (!raw.media_type && type === 'tv' && !!raw.release_date && !raw.first_air_date) ||
      typeof raw.vote_count !== 'number' || raw.vote_count < 300 ||
      typeof raw.vote_average !== 'number' || raw.vote_average < 6.5) return null;
  const item = normalizeTmdbItem(raw, type);
  return item && isRecommendationEligible(item) ? item : null;
}

export function normalizeTmdbDetail(
  value: unknown,
  type: MediaType
): MediaDetail | null {
  const raw = value as RawTmdbObject | null;
  const id = String(raw?.id || '');
  if (!raw || !raw.id) {
    return null;
  }

  const base = normalizeTmdbItem(raw, type);
  if (!base) return null;

  const cert = extractCertification(raw, type);
  const dateStr: string = raw.release_date || raw.first_air_date || '';
  const released =
    isReleased({ releaseDate: dateStr }) &&
    raw.status !== 'Upcoming' &&
    raw.status !== 'In Production';

  const runtimeMinutes =
    type === 'movie'
      ? Number(raw.runtime || 0)
      : Number(raw.episode_run_time?.[0] || 45);

  const seasons: SeasonSummary[] =
    type === 'tv' && Array.isArray(raw.seasons)
      ? raw.seasons
          .filter(
            (s) =>
              Number(s.season_number) > 0 && Number(s.episode_count) > 0
          )
          .map((s) => ({
            seasonNumber: Number(s.season_number),
            name: String(s.name || `Season ${s.season_number}`),
            episodeCount: Number(s.episode_count || 0),
            airDate: s.air_date || undefined,
          }))
      : [];

  const seasonsCount =
    type === 'tv'
      ? Math.max(seasons.length, Number(raw.number_of_seasons || 1))
      : 0;

  const directors =
    type === 'movie'
      ? Array.from(
          new Set(
            (raw.credits?.crew || [])
              .filter((c) => c.job === 'Director')
              .map((c) => c.name?.trim())
              .filter((n): n is string => Boolean(n))
          )
        ).slice(0, 3)
      : [];
  const creators =
    type === 'tv'
      ? Array.from(
          new Set(
            (raw.created_by || [])
              .map((c) => c.name?.trim())
              .filter((n): n is string => Boolean(n))
          )
        ).slice(0, 4)
      : [];
  let creatorOrDirector = '—';
  if (type === 'movie') {
    if (directors.length) creatorOrDirector = directors[0];
  } else if (creators.length) {
    creatorOrDirector = creators.slice(0, 2).join(', ');
  }

  const cast: CastMember[] = (raw.credits?.cast || [])
    .map((c, idx) => ({
      id: String(c.id || idx),
      name: String(c.name || 'Cast Member'),
      character: String(c.character || c.roles?.[0]?.character || 'Cast'),
      profileUrl: c.profile_path
        ? tmdbImage(c.profile_path, 'w185', 'poster')
        : null,
    }));

  const videos = normalizeTmdbVideos(raw.videos?.results);

  const officialTrailer =
    videos.find((v) => v.type === 'Trailer' && v.official) ||
    videos.find((v) => v.type === 'Trailer') ||
    videos.find((v) => v.type === 'Teaser') ||
    videos[0] ||
    null;

  // The append_to_response payload uses the same TMDB recommendations and
  // similar endpoints. Reject missing posters before normalization can replace
  // them with a placeholder, and never coerce a mismatched media_type.
  const normalizeRelated = (rows: RawTmdbObject[]) => rows.flatMap((row) => {
    const item = normalizeRecommendation(row, type);
    return item ? [item] : [];
  });
  const related = selectTitleRecommendations(
    base,
    normalizeRelated(raw.recommendations?.results || []),
    normalizeRelated(raw.similar?.results || [])
  );

  const networkOrStudio =
    type === 'tv'
      ? raw.networks?.[0]?.name || raw.production_companies?.[0]?.name || '—'
      : raw.production_companies?.[0]?.name || '—';

  return {
    ...base,
    editorialNote: [...AUTHORS_CHOICE_MOVIES, ...AUTHORS_CHOICE_TV, ...AUTHORS_CHOICE_ANIME, ...AUTHORS_CHOICE_DOCUMENTARIES]
      .find(entry => entry.mediaType === type && String(entry.tmdbId) === id)?.note,
    cert,
    backdropUrl: tmdbImage(
      raw.backdrop_path || raw.poster_path,
      'original',
      'backdrop'
    ),
    lengthLabel:
      type === 'movie'
        ? formatRuntime(runtimeMinutes)
        : `${seasonsCount} Season${seasonsCount !== 1 ? 's' : ''}`,
    sourcesCount: released ? THIRD_PARTY_SOURCES.length : 0,
    tagline: String(raw.tagline || ''),
    logoUrl: pickTitleLogo(raw.images?.logos),
    status: String(
      raw.status || (type === 'tv' ? 'Returning Series' : 'Released')
    ),
    releaseDate: dateStr || base.year,
    runtimeMinutes,
    seasonsCount,
    isLimitedSeries: type === 'tv' && raw.type === 'Miniseries',
    episodesCount: Number(raw.number_of_episodes || 0),
    seasons:
      seasons.length > 0
        ? seasons
        : type === 'tv'
          ? [{ seasonNumber: 1, name: 'Season 1', episodeCount: 8 }]
          : [],
    creatorOrDirector,
    originalLanguage: String(raw.original_language || 'en').toUpperCase(),
    networkOrStudio,
    cast,
    videos,
    trailerKey: officialTrailer?.key || null,
    certificationsByRegion: certificationsByRegion(raw, type),
    related,
    imdbId: raw.external_ids?.imdb_id || raw.imdb_id || null,
    verified: {
      certification: extractListedCertification(raw, type) !== null,
      genres: Array.isArray(raw.genres) && raw.genres.some((g) => Boolean(g.name)),
      overview: Boolean(raw.overview?.trim()),
    },
    directors,
    creators,
  };
}

export async function fetchMediaDetail(
  type: MediaType,
  idOrSlug: string,
  outcome: TmdbFetchOutcome = {}
): Promise<MediaDetail | null> {
  const id = extractMediaId(idOrSlug);
  if (!/^\d+$/.test(id)) {
    return getFallbackDetail(id);
  }

  const configured = await isTmdbConfigured();
  if (!configured) {
    return getFallbackDetail(id);
  }

  // Videos are intentionally lazy-loaded from the Videos section. This keeps
  // high-volume TMDB responses out of the initial document and hydration work.
  const append =
    type === 'movie'
      ? 'credits,recommendations,similar,release_dates,external_ids,images'
      : 'credits,recommendations,similar,content_ratings,external_ids,images';

  // `images` is limited to English + textless artwork: that is all the hero
  // logo picker uses, and it keeps the posters/backdrops arrays small.
  const raw = await tmdbFetch<RawTmdbObject>(
    `/${type}/${id}`,
    {
      language: 'en-US',
      append_to_response: append,
      include_image_language: 'en,null',
    },
    undefined,
    outcome
  );
  const detail = normalizeTmdbDetail(raw, type);
  if (detail) {
    detail.fetchedAt = new Date(outcome.fetchedAt ?? Date.now()).toISOString();
    debugDataSnapshot('title-detail', {
      id: detail.id,
      type: detail.type,
      rating: detail.rating,
      voteCount: detail.voteCount,
      cert: detail.cert,
    });
  }
  return detail;
}

/** Add same-genre editorial choices only when the upstream lists are sparse. */
export async function fillTitleRecommendations(detail: MediaDetail): Promise<MediaDetail> {
  if (detail.related.length >= 8) return detail;
  const register = detail.type === 'movie' ? AUTHORS_CHOICE_MOVIES : AUTHORS_CHOICE_TV;
  const configured = await isTmdbConfigured();
  const curated = configured
    ? (await Promise.all(register.map(async (entry) => {
        const raw = await tmdbFetch<RawTmdbObject>(`/${entry.mediaType}/${entry.tmdbId}`, { language: 'en-US' });
        return raw?.id === entry.tmdbId ? normalizeRecommendation(raw, detail.type) : null;
      }))).filter((item): item is MediaItem => item !== null)
    : await resolveCuratedTitles(register);
  return { ...detail, related: selectTitleRecommendations(detail, detail.related, [], curated) };
}

export async function fetchSeasonEpisodes(
  tvIdOrSlug: string,
  seasonNumber: number,
  fallbackBackdrop?: string
): Promise<EpisodeItem[]> {
  const tvId = extractMediaId(tvIdOrSlug);
  if (!/^\d+$/.test(tvId)) {
    return getFallbackSeasonEpisodes(tvId, seasonNumber);
  }

  const configured = await isTmdbConfigured();
  if (!configured) {
    return getFallbackSeasonEpisodes(tvId, seasonNumber);
  }

  const data = await tmdbFetch<{
    episodes?: Array<{
      episode_number?: number;
      season_number?: number;
      name?: string;
      overview?: string;
      still_path?: string | null;
      runtime?: number | null;
      air_date?: string | null;
      vote_average?: number;
    }>;
  }>(`/tv/${tvId}/season/${seasonNumber}`, {
    language: 'en-US',
  });

  if (!data?.episodes?.length) {
    return [];
  }

  return data.episodes.map((ep, idx) => ({
    episodeNumber: Number(ep.episode_number || idx + 1),
    seasonNumber: Number(ep.season_number || seasonNumber),
    name: String(ep.name || `Episode ${idx + 1}`),
    overview: String(
      ep.overview || 'Episode synopsis is not yet available on TMDB.'
    ),
    stillUrl: ep.still_path
      ? tmdbImage(ep.still_path, 'w780', 'backdrop')
      : fallbackBackdrop || PLACEHOLDER_BACKDROP,
    runtime: Number(ep.runtime || 45),
    airDate: ep.air_date || undefined,
    rating:
      typeof ep.vote_average === 'number' && ep.vote_average > 0
        ? Number(ep.vote_average.toFixed(1))
        : undefined,
  }));
}

/**
 * Browser + server-key mode: use the backend search service (shared cache,
 * typo correction). Returns null to fall back to the in-browser pipeline.
 */
async function searchViaServer(
  query: string,
  filterType: 'all' | MediaType,
  ignored: NluFilterKey[],
  page: number,
  signal?: AbortSignal,
  scope?: Pick<SearchScope, 'kind' | 'id'> | null,
  refine: SearchRefinements = NO_REFINEMENTS
): Promise<PaginatedResult | null> {
  if (typeof window === 'undefined') return null;
  const qs = new URLSearchParams({ q: query, type: filterType, page: String(page) });
  if (ignored.length) qs.set('ignore', ignored.join(','));
  if (scope) qs.set(scope.kind, String(scope.id));
  appendSearchRefinements(qs, refine);
  try {
    const res = await fetchTmdbWithDeadline(`/api/search?${qs}`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as PaginatedResult;
    return Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}

/** Sample catalogue has no upstream filters: refine the bundled titles here. */
function refineFallbackItems(result: PaginatedResult, refine: SearchRefinements): PaginatedResult {
  if (!hasSearchRefinements(refine)) return result;
  const items = result.items
    .filter(
      (item) =>
        (!refine.genre || item.genres.includes(refine.genre)) &&
        (!refine.year || item.year === refine.year) &&
        item.rating >= refine.minRating
    )
    .sort((a, b) =>
      refine.sort === 'popular'
        ? b.popularity - a.popularity
        : refine.sort === 'rating'
        ? b.rating - a.rating
        : refine.sort === 'newest'
          ? Number(b.year || 0) - Number(a.year || 0)
          : 0
    );
  return { ...result, items, page: 1, totalPages: 1, totalResults: items.length };
}

export async function searchCatalogue(params: {
  query: string;
  filterType?: 'all' | MediaType;
  ignoredQueryFilters?: NluFilterKey[];
  page?: number;
  signal?: AbortSignal;
  /** Person / collection picked from suggestions (wins over the query text). */
  scope?: Pick<SearchScope, 'kind' | 'id'> | null;
  /** Genre / year / rating / sort, applied across all results (not one page). */
  refine?: Partial<SearchRefinements> | null;
}): Promise<PaginatedResult> {
  const { query, filterType = 'all', ignoredQueryFilters = [], page = 1, signal, scope = null } = params;
  const refine = normalizeSearchRefinements(params.refine);
  const trimmed = query.trim();
  const fallbackType = filterType === 'all' ? undefined : filterType;

  const configured = await isTmdbConfigured();
  if (!configured) {
    return refineFallbackItems(getFallbackSearch(trimmed, filterType), refine);
  }

  const viaServer = await searchViaServer(trimmed, filterType, ignoredQueryFilters, page, signal, scope, refine);
  if (viaServer) return viaServer;

  if (scope) {
    const request = scopeRequest(scope);
    const raw = await tmdbFetch<RawPersonWithCredits & RawCollection>(`/${request.path}`, request.params, signal);
    if (!raw) throw new Error('Search service unavailable');
    const scoped =
      scope.kind === 'person'
        ? rowsFromPersonCredits(raw, filterType, page, refine)
        : rowsFromCollection(raw, filterType, page, refine);
    if (!scoped) return { items: [], page: 1, totalPages: 1, totalResults: 0, isLive: true };
    return {
      items: scoped.rows
        .map((row) => normalizeTmdbItem(row as RawTmdbObject, row.media_type))
        .filter((x): x is MediaItem => x !== null),
      page: Math.min(page, scoped.totalPages),
      totalPages: scoped.totalPages,
      totalResults: scoped.totalResults,
      isLive: true,
      scope: scoped.scope,
    };
  }

  if (!trimmed && !hasSearchRefinements(refine)) {
    const endpoint =
      filterType === 'movie'
        ? '/trending/movie/week'
        : filterType === 'tv'
          ? '/trending/tv/week'
          : '/trending/all/week';
    const data = await tmdbFetch(
      endpoint,
      { language: 'en-US', page: 1 },
      signal
    );
    if (!data?.results) throw new Error('Search service unavailable');
    const items: MediaItem[] = (data.results || [])
      .map((r) => normalizeTmdbItem(r, fallbackType))
      .filter((x): x is MediaItem => x !== null)
      .slice(0, 18);

    return {
      items,
      page: 1,
      totalPages: 1,
      totalResults: items.length,
      isLive: true,
    };
  }

  // 1. Descriptive search ("90s sci-fi movies", "hindi movies") or filters
  //    without a query: every filter runs in TMDB discover, so each page is a
  //    full page of matches with TMDB's real totals.
  const parsed = trimmed ? parseSearchQueryNLU(trimmed) : null;
  const nlu = parsed ? excludeNluFilters(parsed, filterType === 'all' ? ignoredQueryFilters : [...ignoredQueryFilters, 'type']) : null;
  if (nlu || !trimmed) {
    const effectiveType =
      filterType !== 'all' ? filterType : nlu?.mediaType || 'all';
    const wantMovies = effectiveType === 'all' || effectiveType === 'movie';
    const wantTv = effectiveType === 'all' || effectiveType === 'tv';

    const [mRes, tvRes] = await Promise.all([
      wantMovies
        ? tmdbFetch('/discover/movie', buildDiscoverParams('movie', page, nlu, refine), signal)
        : Promise.resolve(null),
      wantTv
        ? tmdbFetch('/discover/tv', buildDiscoverParams('tv', page, nlu, refine), signal)
        : Promise.resolve(null),
    ]);

    if ((wantMovies && !mRes?.results) || (wantTv && !tvRes?.results)) throw new Error('Search service unavailable');
    const rows = [
      ...(mRes?.results || []).map((r) => ({ ...r, media_type: 'movie' })),
      ...(tvRes?.results || []).map((r) => ({ ...r, media_type: 'tv' })),
    ] as Array<RawTmdbObject & RefinableRow>;
    const ordered =
      refine.sort !== 'relevance'
        ? sortRowsByRefinement(rows, refine)
        : rows;
    const items = ordered
      .map((r) => normalizeTmdbItem(r, r.media_type as MediaType))
      .filter((x): x is MediaItem => x !== null);
    if (refine.sort === 'relevance') {
      items.sort((a, b) =>
        nlu?.sortBy === 'vote_average.desc'
          ? b.rating - a.rating
          : b.popularity - a.popularity
      );
    }

    return {
      items,
      page,
      ...tmdbPageCount(mRes?.total_pages, tvRes?.total_pages),
      totalResults:
        Number(mRes?.total_results || 0) + Number(tvRes?.total_results || 0),
      isLive: true,
      ...(nlu ? { smartQueryHint: nlu.summaryLabel } : {}),
    };
  }

  // 2. Hybrid Title Search (TMDB Search + Okapi BM25 + Prefix Match + Noise Suppression)
  const endpoint =
    filterType === 'movie'
      ? '/search/movie'
      : filterType === 'tv'
        ? '/search/tv'
        : '/search/multi';
  const fetchPage = (n: number) =>
    tmdbFetch(
      endpoint,
      {
        query: trimmed,
        language: 'en-US',
        include_adult: 'false',
        page: n,
      },
      signal
    );

  if (hasSearchRefinements(refine)) {
    // Title search has no genre / year / rating parameters: filter the best
    // few pages of matches as one list, then page that list.
    const first = await fetchPage(1);
    if (!first?.results) throw new Error('Search service unavailable');
    const scan = Math.min(REFINE_SCAN_PAGES, Math.max(1, Number(first.total_pages || 1)));
    const rest = await Promise.all(
      Array.from({ length: scan - 1 }, (_, i) => fetchPage(i + 2).catch(() => null))
    );
    const seen = new Set<string>();
    const rows = [first, ...rest]
      .flatMap((data) => (data?.results || []) as RawSearchCandidate[])
      .filter((row) => {
        const key = `${row.media_type || fallbackType}:${row.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const refined = refineRows(rankSearchCandidates(rows, trimmed), refine, page, fallbackType);
    return {
      items: refined.rows
        .map((r) => normalizeTmdbItem(r as RawTmdbObject, fallbackType))
        .filter((x): x is MediaItem => x !== null),
      page: refined.page,
      totalPages: refined.totalPages,
      totalResults: refined.totalResults,
      isLive: true,
    };
  }

  const data = await fetchPage(page);

  if (!data?.results) {
    throw new Error('Search service unavailable');
  }

  const rankedRaw = rankSearchCandidates(
    data.results as RawSearchCandidate[],
    trimmed
  );

  const items: MediaItem[] = rankedRaw
    .map((r) => normalizeTmdbItem(r as RawTmdbObject, fallbackType))
    .filter((x): x is MediaItem => x !== null);

  return {
    items,
    page: Number(data.page || page),
    ...tmdbPageCount(data.total_pages),
    totalResults: Number(data.total_results || items.length),
    isLive: true,
  };
}

/* ============================================================================
   Instant search suggestions (homepage quick search)
   ============================================================================ */

/** Compact, card-free shape for as-you-type suggestions. */
export interface SearchSuggestion {
  id: string;
  tmdbId?: number;
  type: MediaType;
  title: string;
  year: string;
  posterUrl: string;
  posterSrcSet?: string;
  genres: string[];
  /** How the title relates to the query (see `titleMatchKind`). */
  match?: MatchKind | 'fuzzy';
}

export interface PersonSuggestionItem {
  id: number;
  name: string;
  /** Empty when TMDB has no profile photo. */
  profileUrl: string;
  department: string;
  knownFor: string[];
}

export interface CollectionSuggestionItem {
  id: number;
  name: string;
  posterUrl: string;
}

export interface SuggestionResult {
  suggestions: SearchSuggestion[];
  /** False when only the bundled sample catalogue is available. */
  isLive: boolean;
  /** People whose name matches (server search mode only). */
  people?: PersonSuggestionItem[];
  /** Film collections whose name matches (server search mode only). */
  collections?: CollectionSuggestionItem[];
}

interface ServerSuggestion {
  id: string;
  tmdbId: number;
  type: MediaType;
  title: string;
  year: string;
  posterPath: string | null;
  genres?: string[];
  match?: MatchKind | 'fuzzy';
}

interface ServerPersonSuggestion {
  id: number;
  name: string;
  profilePath: string | null;
  department?: string;
  knownFor?: string[];
}

interface ServerCollectionSuggestion {
  id: number;
  name: string;
  posterPath: string | null;
}

/** Same whitespace/case contract as the backend so cache keys agree. */
export function normalizeSuggestQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').slice(0, 80);
}

const SUGGEST_CACHE_LIMIT = 60;
const SUGGEST_CACHE_TTL_MS = 5 * 60 * 1000;
const suggestCache = new Map<string, { expires: number; value: SuggestionResult }>();

function suggestCacheKey(query: string, limit: number): string {
  return `${limit}:${normalizeSuggestQuery(query).toLowerCase()}`;
}

/** Synchronous cache peek so repeated queries (e.g. backspacing) render instantly. */
export function peekCachedSuggestions(query: string, limit: number): SuggestionResult | null {
  const key = suggestCacheKey(query, limit);
  const hit = suggestCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    suggestCache.delete(key);
    return null;
  }
  return hit.value;
}

function rememberSuggestions(query: string, limit: number, value: SuggestionResult) {
  const key = suggestCacheKey(query, limit);
  suggestCache.delete(key);
  suggestCache.set(key, { expires: Date.now() + SUGGEST_CACHE_TTL_MS, value });
  while (suggestCache.size > SUGGEST_CACHE_LIMIT) {
    const oldest = suggestCache.keys().next().value;
    if (oldest === undefined) break;
    suggestCache.delete(oldest);
  }
}

function suggestionFromItem(item: MediaItem, query: string): SearchSuggestion {
  return {
    id: item.id,
    tmdbId: item.tmdbId,
    type: item.type,
    title: item.title,
    year: item.year,
    posterUrl: item.posterUrl,
    posterSrcSet: item.posterSrcSet,
    genres: item.genres.slice(0, 2),
    match: titleMatchKind(item.title, query),
  };
}

/** Exact-title matches first (stable), so "exact title" is always on top. */
function exactFirst(list: SearchSuggestion[]): SearchSuggestion[] {
  return [...list.filter((s) => s.match === 'exact'), ...list.filter((s) => s.match !== 'exact')];
}

/**
 * As-you-type title suggestions. Mirrors `searchCatalogue`'s key modes:
 * server key → `/api/search/suggest` (prefix index + cached live search);
 * browser key → the existing in-browser hybrid search, trimmed to `limit`;
 * no key → the bundled sample catalogue. Throws when the service fails so the
 * caller can offer a retry instead of a misleading "no results" state.
 */
export async function suggestCatalogue(params: {
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SuggestionResult> {
  const limit = Math.min(12, Math.max(1, params.limit ?? 6));
  const query = normalizeSuggestQuery(params.query);
  if (!query) return { suggestions: [], isLive: true };

  const cached = peekCachedSuggestions(query, limit);
  if (cached) return cached;

  const dedupe = (list: SearchSuggestion[]) => {
    const seen = new Set<string>();
    return list.filter((s) => {
      const key = `${s.type}:${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
  };

  let value: SuggestionResult;
  if (!(await isTmdbConfigured())) {
    value = {
      suggestions: dedupe(exactFirst(getFallbackSearch(query, 'all').items.map((item) => suggestionFromItem(item, query)))),
      isLive: false,
    };
  } else if (typeof window !== 'undefined') {
    const qs = new URLSearchParams({ q: query, limit: String(limit) });
    const res = await fetchTmdbWithDeadline(`/api/search/suggest?${qs}`, { signal: params.signal });
    if (!res.ok) throw new Error('Suggestion service unavailable');
    const data = (await res.json()) as {
      suggestions?: ServerSuggestion[];
      people?: ServerPersonSuggestion[];
      collections?: ServerCollectionSuggestion[];
    };
    if (!Array.isArray(data.suggestions)) throw new Error('Suggestion service unavailable');
    value = {
      suggestions: dedupe(
        data.suggestions.map((s) => ({
          id: String(s.id),
          tmdbId: s.tmdbId,
          type: s.type,
          title: s.title,
          year: s.year || '',
          posterUrl: tmdbImage(s.posterPath, 'w185', 'poster'),
          posterSrcSet: s.posterPath ? `${TMDB_IMG_BASE}/w92${s.posterPath} 92w, ${TMDB_IMG_BASE}/w185${s.posterPath} 185w` : undefined,
          genres: Array.isArray(s.genres) ? s.genres.slice(0, 2) : [],
          match: s.match,
        }))
      ),
      isLive: true,
      people: (Array.isArray(data.people) ? data.people : []).slice(0, 3).map((p) => ({
        id: Number(p.id),
        name: String(p.name),
        profileUrl: p.profilePath ? `${TMDB_IMG_BASE}/w185${p.profilePath}` : '',
        department: String(p.department || ''),
        knownFor: Array.isArray(p.knownFor) ? p.knownFor.slice(0, 2).map(String) : [],
      })),
      collections: (Array.isArray(data.collections) ? data.collections : []).slice(0, 3).map((c) => ({
        id: Number(c.id),
        name: String(c.name),
        posterUrl: tmdbImage(c.posterPath, 'w185', 'poster'),
      })),
    };
  } else {
    const result = await searchCatalogue({ query, signal: params.signal });
    value = {
      suggestions: dedupe(exactFirst(result.items.map((item) => suggestionFromItem(item, query)))),
      isLive: result.isLive,
    };
  }

  if (!params.signal?.aborted) rememberSuggestions(query, limit, value);
  return value;
}

export function getDetailHref(
  item: Pick<MediaItem, 'type' | 'id' | 'title' | 'tmdbId'>
): string {
  const slugPart =
    item.tmdbId || /^\d+$/.test(item.id)
      ? `${item.id}${slugify(item.title) ? `-${slugify(item.title)}` : ''}`
      : item.id;
  return `/title/${item.type}/${slugPart}`;
}

export function getWatchHref(
  item: Pick<MediaItem, 'type' | 'id' | 'title' | 'tmdbId'>,
  opts?: { season?: number; episode?: number; server?: string; source?: string }
): string {
  const slugPart =
    item.tmdbId || /^\d+$/.test(item.id)
      ? `${item.id}${slugify(item.title) ? `-${slugify(item.title)}` : ''}`
      : item.id;
  const qs = new URLSearchParams();
  if (opts?.season) qs.set('s', String(opts.season));
  if (opts?.episode) qs.set('e', String(opts.episode));
  if (opts?.server) qs.set('server', opts.server);
  if (opts?.source) qs.set('source', opts.source);
  const s = qs.toString();
  return `/watch/${item.type}/${slugPart}${s ? `?${s}` : ''}`;
}
