/**
 * AALAM Hybrid Search Engine with contextual CineMatch ranking
 *
 * Combines:
 *  1. Zero-latency NLU Query Parser ("90s sci-fi movies", "top rated crime series", "80s horror")
 *  2. Okapi BM25 multi-field scoring (title: 3.0, tagline: 1.5, overview: 1.0)
 *  3. Prefix/token titleMatchScore for real-time as-you-type accuracy ("nar" -> Naruto, Narcos)
 *  4. Noise suppression (strips posterless 0-vote TMDB junk entries)
 */

import { MediaType } from '@/types/media';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'may',
  'might', 'must', 'can', 'could', 'not', 'no', 'it', 'its', 'this',
  'that', 'these', 'those',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function titleMatchScore(title: string, query: string): number {
  const t = normalizeTitle(title);
  const q = normalizeTitle(query);
  if (!t || !q) return 0;
  if (t === q) return 1.0;
  if (t.startsWith(q)) return 0.85;
  const titleWords = t.split(' ');
  const queryWords = q.split(' ');
  const last = queryWords[queryWords.length - 1];
  const earlier = queryWords.slice(0, -1);
  if (
    earlier.every((w) => titleWords.includes(w)) &&
    titleWords.some((w) => w.startsWith(last))
  ) {
    return 0.62;
  }
  if (t.includes(q)) return 0.42;
  return 0;
}

export interface RawSearchCandidate {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  tagline?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  original_language?: string;
}

export function isSearchNoise(item: RawSearchCandidate): boolean {
  if (item.media_type === 'person') return true;
  return !item.poster_path && (item.vote_count ?? 0) < 20;
}

/* ============================================================================
   Okapi BM25 + Hybrid Ranker
   ============================================================================ */

interface FieldSpec {
  weight: number;
  k1: number;
  b: number;
}

const FIELD_SPECS: Record<'title' | 'overview' | 'tagline', FieldSpec> = {
  title: { weight: 3.0, k1: 0.9, b: 0.1 },
  overview: { weight: 1.0, k1: 1.5, b: 0.75 },
  tagline: { weight: 1.5, k1: 1.0, b: 0.3 },
};

export function rankSearchCandidates(
  candidates: RawSearchCandidate[],
  query: string
): RawSearchCandidate[] {
  const filtered = candidates.filter((c) => !isSearchNoise(c));
  if (filtered.length <= 1 || !query.trim()) return filtered;

  const qTokens = tokenize(query);
  const N = filtered.length;

  const docFieldTokens = filtered.map((c) => ({
    title: tokenize(c.title || c.name || ''),
    overview: tokenize(c.overview || ''),
    tagline: tokenize(c.tagline || ''),
  }));

  const docFreq = new Map<string, number>();
  const avgLengths = { title: 0, overview: 0, tagline: 0 };

  for (const doc of docFieldTokens) {
    avgLengths.title += doc.title.length;
    avgLengths.overview += doc.overview.length;
    avgLengths.tagline += doc.tagline.length;

    const uniqueTerms = new Set([
      ...doc.title,
      ...doc.overview,
      ...doc.tagline,
    ]);
    for (const term of uniqueTerms) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  avgLengths.title = Math.max(1, avgLengths.title / N);
  avgLengths.overview = Math.max(1, avgLengths.overview / N);
  avgLengths.tagline = Math.max(1, avgLengths.tagline / N);

  const rawBm25Scores = docFieldTokens.map((doc) => {
    if (!qTokens.length) return 0;
    let total = 0;
    for (const field of ['title', 'overview', 'tagline'] as const) {
      const tokens = doc[field];
      if (!tokens.length) continue;
      const { weight, k1, b } = FIELD_SPECS[field];
      const avgdl = avgLengths[field];
      const tfMap = new Map<string, number>();
      for (const tok of tokens) tfMap.set(tok, (tfMap.get(tok) || 0) + 1);

      for (const qt of qTokens) {
        const tf = tfMap.get(qt) || 0;
        if (!tf) continue;
        const df = docFreq.get(qt) || 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const num = tf * (k1 + 1);
        const den = tf + k1 * (1 - b + b * (tokens.length / avgdl));
        total += weight * idf * (num / den);
      }
    }
    return total;
  });

  const maxBm25 = Math.max(1e-6, ...rawBm25Scores);
  const maxLogPop = Math.max(
    1e-6,
    ...filtered.map((c) => Math.log1p(Math.max(0, c.popularity || 0)))
  );

  const words = normalizeTitle(query).split(' ').filter(Boolean);
  const weights =
    words.length === 1 && words[0].length <= 4
      ? { bm25: 0.12, title: 0.48, pop: 0.4 }
      : { bm25: 0.38, title: 0.37, pop: 0.25 };

  const scored = filtered.map((item, idx) => {
    const bm25Norm = rawBm25Scores[idx] / maxBm25;
    const tMatch = titleMatchScore(item.title || item.name || '', query);
    const popNorm =
      Math.log1p(Math.max(0, item.popularity || 0)) / maxLogPop;
    const voteDamping = Math.min(1, ((item.vote_count || 0) + 10) / 80);

    const score =
      (weights.bm25 * bm25Norm +
        weights.title * tMatch +
        weights.pop * popNorm) *
      (0.55 + 0.45 * voteDamping);

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/* ============================================================================
   Natural Language Query (NLU) Parser
   ============================================================================ */

export const NLU_FILTER_KEYS = ['genre', 'year', 'language', 'type', 'runtime', 'sort'] as const;
export type NluFilterKey = typeof NLU_FILTER_KEYS[number];
export type NluQueryFilter = { key: NluFilterKey; label: string };

export function parseIgnoredQueryFilters(value: string | null): NluFilterKey[] {
  const requested = new Set((value || '').split(','));
  return NLU_FILTER_KEYS.filter(key => requested.has(key));
}

export interface ParsedNluQuery {
  mediaType?: MediaType;
  movieGenres: number[];
  tvGenres: number[];
  startYear?: number;
  endYear?: number;
  sortBy?: 'vote_average.desc' | 'primary_release_date.desc' | 'popularity.desc';
  originalLanguage?: string;
  /** Movie runtime ceiling in minutes ("under 2 hours" / "short films"). */
  maxRuntimeMinutes?: number;
  summaryLabel: string;
  filters: NluQueryFilter[];
}

const NLU_GENRE_PATTERNS: Array<{
  re: RegExp;
  label: string;
  movieId: number;
  tvId: number;
}> = [
  // Synonyms and plurals count as one genre: "funny comedy movies" is Comedy
  // once, and "comedies" / "thrillers" are understood like their singulars.
  { re: /\bsci[- ]?fi\b|\bscience.?fiction\b/i, label: 'Sci-Fi', movieId: 878, tvId: 10765 },
  { re: /\bactions?\b|\bsuperhero(?:es)?\b|\bsuperher/i, label: 'Action', movieId: 28, tvId: 10759 },
  { re: /\badventures?\b/i, label: 'Adventure', movieId: 12, tvId: 10759 },
  { re: /\banime\b/i, label: 'Anime', movieId: 16, tvId: 16 },
  { re: /\banimation\b|\banimated\b|\bcartoons?\b/i, label: 'Animation', movieId: 16, tvId: 16 },
  { re: /\bcomed(?:y|ies)\b|\bcomedic\b|\bfunny\b|\bfunniest\b|\bhilarious\b|\bsitcoms?\b|\brom[- ]?coms?\b/i, label: 'Comedy', movieId: 35, tvId: 35 },
  { re: /\bcrime\b|\bheists?\b|\bdetectives?\b|\bgangsters?\b/i, label: 'Crime', movieId: 80, tvId: 80 },
  { re: /\bdocumentar/i, label: 'Documentary', movieId: 99, tvId: 99 },
  { re: /\bdramas?\b|\bdramatic\b/i, label: 'Drama', movieId: 18, tvId: 18 },
  { re: /\bfamily\b|\bkids\b|\bchildren'?s?\b/i, label: 'Family', movieId: 10751, tvId: 10751 },
  { re: /\bfantas/i, label: 'Fantasy', movieId: 14, tvId: 10765 },
  { re: /\bhistor(?:y|ical)\b|\bperiod\b/i, label: 'History', movieId: 36, tvId: 10768 },
  { re: /\bhorrors?\b|\bscary\b|\bscariest\b|\bzombies?\b|\bsupernatural\b/i, label: 'Horror', movieId: 27, tvId: 9648 },
  { re: /\bmusicals?\b/i, label: 'Music', movieId: 10402, tvId: 10402 },
  { re: /\bmyster(?:y|ies)\b/i, label: 'Mystery', movieId: 9648, tvId: 9648 },
  { re: /\bromance\b|\bromances\b|\bromantic\b|\brom[- ]?coms?\b/i, label: 'Romance', movieId: 10749, tvId: 10749 },
  { re: /\bthrillers?\b|\bsuspense\b/i, label: 'Thriller', movieId: 53, tvId: 9648 },
  { re: /\bwar\b/i, label: 'War', movieId: 10752, tvId: 10768 },
  { re: /\bwesterns?\b/i, label: 'Western', movieId: 37, tvId: 37 },
];

const NLU_DECADES: Array<[RegExp, number]> = [
  [/\b(seventies|70s|1970s)\b/i, 1970],
  [/\b(eighties|80s|1980s)\b/i, 1980],
  [/\b(nineties|90s|1990s)\b/i, 1990],
  [/\b(2000s|two.?thousands)\b/i, 2000],
  [/\b(2010s|twenty.?tens)\b/i, 2010],
  [/\b(2020s|twenty.?twenties)\b/i, 2020],
];

const LANGUAGE_PATTERNS: Array<[RegExp, string, string]> = [
  [/\bkorean\b|\bk[- ]?drama\b/i, 'ko', 'Korean'],
  [/\bjapanese\b|\banime\b/i, 'ja', 'Japanese'],
  [/\bspanish\b/i, 'es', 'Spanish'],
  [/\bfrench\b/i, 'fr', 'French'],
  [/\bhindi\b|\bbollywood\b/i, 'hi', 'Hindi'],
];

/**
 * Runtime intents ("under two hours", "short movies"). Wordy phrases must come
 * before the single-word `short` fallback; a bare "short" next to an
 * unconsumed title word still fails the leftover check, so a title such as
 * "Short Circuit" never turns into a runtime filter.
 */
const RUNTIME_PATTERNS: Array<[RegExp, number, string]> = [
  [/\bunder\s+(?:2|two)\s+hours?\b/i, 120, 'Under 2 hours'],
  [/\bunder\s+(?:90)\s*(?:minutes|mins?)\b/i, 90, 'Under 90 minutes'],
  [/\b(?:short|brief)\b/i, 120, 'Under 2 hours'],
];

const MOVIE_RE = /\b(movies?|films?|cinema)\b/i;
const TV_RE = /\b(tv|shows?|series|sitcoms?|miniseries|k[- ]?drama)\b/i;
const TOP_RE = /\b(top.?rated|best|highest.?rated|acclaimed)\b/i;
const NEW_RE = /\b(recent|latest|new|newest)\b/i;

/**
 * Conversational words that carry no title information ("some funny movies
 * to watch tonight", "good horror films for kids"). They are removed only
 * after a real signal (genre, year, language, type, runtime or sort) was
 * found, so a query made of filler alone is still a plain title search.
 */
const NLU_FILLER_RE = /\b(?:a|an|the|some|any|in|from|of|for|to|with|and|or|me|my|i|want|need|show|find|give|suggest|recommend(?:ed|ations?)?|watch(?:ing)?|tonight|today|weekend|good|great|nice|fun|really|very|most|all|time|ever|list|please|that|are|is|which|something|anything|70s|80s|90s)\b|[&+,]/gi;

function stripAll(text: string, re: RegExp): string {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return text.replace(new RegExp(re.source, flags), '');
}

export function parseSearchQueryNLU(query: string): ParsedNluQuery | null {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return null;

  const movieGenres: number[] = [];
  const tvGenres: number[] = [];

  for (const g of NLU_GENRE_PATTERNS) {
    if (g.re.test(trimmed)) {
      if (!movieGenres.includes(g.movieId)) movieGenres.push(g.movieId);
      if (!tvGenres.includes(g.tvId)) tvGenres.push(g.tvId);
    }
  }

  let startYear: number | undefined;
  let endYear: number | undefined;

  for (const [re, dec] of NLU_DECADES) {
    if (re.test(trimmed)) {
      startYear = dec;
      endYear = dec + 9;
      break;
    }
  }

  if (!startYear) {
    const exactYear = trimmed.match(/\b(19[7-9]\d|20[0-2]\d)\b/);
    if (exactYear) {
      startYear = Number(exactYear[1]);
      endYear = startYear;
    }
  }

  let originalLanguage: string | undefined;
  for (const [re, code] of LANGUAGE_PATTERNS) {
    if (re.test(trimmed)) {
      originalLanguage = code;
      break;
    }
  }

  let maxRuntimeMinutes: number | undefined;
  let runtimeLabel = '';
  for (const [re, minutes, label] of RUNTIME_PATTERNS) {
    if (re.test(trimmed)) {
      maxRuntimeMinutes = minutes;
      runtimeLabel = label;
      break;
    }
  }

  let mediaType: MediaType | undefined;
  if (TV_RE.test(trimmed)) {
    mediaType = 'tv';
  } else if (MOVIE_RE.test(trimmed)) {
    mediaType = 'movie';
  }

  let sortBy: ParsedNluQuery['sortBy'];
  if (TOP_RE.test(trimmed)) {
    sortBy = 'vote_average.desc';
  } else if (NEW_RE.test(trimmed)) {
    sortBy = 'primary_release_date.desc';
  }

  // Only treat as structured NLU discover if at least 2 signals or genre + modifier matched,
  // and removing structural words leaves almost nothing (so "Inception 2010" still searches "Inception"!)
  // Every occurrence is removed (stripAll), not just the first: with a
  // first-match replace, "funny comedy movies" kept "comedy" as a leftover
  // word and fell back to a literal title search with no results.
  let leftover = stripAll(trimmed, MOVIE_RE);
  leftover = stripAll(leftover, TV_RE);
  leftover = stripAll(leftover, TOP_RE);
  leftover = stripAll(leftover, NEW_RE);
  leftover = leftover.replace(/\b(19[7-9]\d|20[0-2]\d)s?\b/g, '');

  for (const g of NLU_GENRE_PATTERNS) leftover = stripAll(leftover, g.re);
  for (const [re] of NLU_DECADES) leftover = stripAll(leftover, re);
  for (const [re] of LANGUAGE_PATTERNS) leftover = stripAll(leftover, re);
  if (maxRuntimeMinutes) {
    for (const [re, minutes] of RUNTIME_PATTERNS) {
      if (minutes === maxRuntimeMinutes && re.test(leftover)) {
        leftover = stripAll(leftover, re);
        break;
      }
    }
  }
  leftover = leftover.replace(NLU_FILLER_RE, '');

  const cleanedLeftover = leftover.replace(/[^a-z0-9]/gi, '').trim();
  const signalCount =
    (movieGenres.length > 0 ? 1 : 0) +
    (startYear ? 1 : 0) +
    (originalLanguage ? 1 : 0) +
    (mediaType ? 1 : 0) +
    (maxRuntimeMinutes ? 1 : 0) +
    (sortBy ? 1 : 0);

  if (signalCount === 0 || cleanedLeftover.length > 2) {
    return null;
  }

  const filters: NluQueryFilter[] = [];
  if (movieGenres.length) {
    filters.push({ key: 'genre', label: NLU_GENRE_PATTERNS.filter(genre => genre.re.test(trimmed)).map(genre => genre.label).join(' + ') });
  }
  if (startYear) filters.push({ key: 'year', label: startYear === endYear ? String(startYear) : `${startYear}s` });
  if (originalLanguage) filters.push({ key: 'language', label: LANGUAGE_PATTERNS.find(([, code]) => code === originalLanguage)![2] });
  if (mediaType) filters.push({ key: 'type', label: mediaType === 'movie' ? 'Movies' : 'Series' });
  if (maxRuntimeMinutes) filters.push({ key: 'runtime', label: runtimeLabel });
  if (sortBy) filters.push({ key: 'sort', label: sortBy === 'vote_average.desc' ? 'Top rated' : 'Newest' });

  return {
    mediaType, movieGenres, tvGenres, startYear, endYear, sortBy, originalLanguage, maxRuntimeMinutes,
    filters,
    summaryLabel: filters.map(filter => filter.label).join(' · '),
  };
}

// Keep descriptive discovery active even when the last chip is removed. Do not
// reinterpret the unchanged sentence as a literal title or silently reapply it.
export function excludeNluFilters(query: ParsedNluQuery, ignored: readonly NluFilterKey[]): ParsedNluQuery {
  const excluded = new Set(ignored);
  const filters = query.filters.filter(filter => !excluded.has(filter.key));
  return {
    ...query,
    movieGenres: excluded.has('genre') ? [] : query.movieGenres,
    tvGenres: excluded.has('genre') ? [] : query.tvGenres,
    startYear: excluded.has('year') ? undefined : query.startYear,
    endYear: excluded.has('year') ? undefined : query.endYear,
    originalLanguage: excluded.has('language') ? undefined : query.originalLanguage,
    mediaType: excluded.has('type') ? undefined : query.mediaType,
    maxRuntimeMinutes: excluded.has('runtime') ? undefined : query.maxRuntimeMinutes,
    sortBy: excluded.has('sort') ? undefined : query.sortBy,
    filters,
    summaryLabel: filters.map(filter => filter.label).join(' · '),
  };
}
