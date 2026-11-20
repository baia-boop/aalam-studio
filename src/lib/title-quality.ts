import type { MediaDetail, MediaType } from '@/types/media';
import { isClean, normalizeDisplayTitle } from '@/lib/content-eligibility';
import { titleSlugSuffix } from '@/lib/seo-url';

/**
 * Title indexing policy — the single source of truth for which
 * /title/{type}/{id}-{slug} pages are *intentionally indexable*.
 *
 * The same predicate is evaluated in two places so they can never disagree:
 *
 *  1. The title page's `robots` meta (src/app/title/[type]/[id]/page.tsx).
 *     Pages that fail render `noindex, follow`: still reachable from
 *     internal cards, but not offered to search engines as landing pages.
 *  2. The title sitemaps (src/server/seo/sitemap-shards.ts). Only titles
 *     that pass are listed, so every sitemap URL is an indexable, canonical,
 *     200-status page and Search Console never reports "Submitted URL marked
 *     noindex".
 *
 * Both callers read the same TMDB `en-US` record (discover list rows for the
 * sitemap, the detail payload for the page), so every signal below is taken
 * only from fields both payloads share.
 */

/** Text TMDB items get when TMDB has no overview (see normalizeTmdbItem). */
export const MISSING_SYNOPSIS_TEXT = 'No synopsis yet.';

/** A synopsis shorter than this is too thin to justify its own landing page. */
export const MIN_SYNOPSIS_CHARS = 40;

const DEFAULT_MIN_VOTES = 20;

/**
 * Minimum TMDB vote count: a proxy for "adequate metadata". Titles below it
 * are overwhelmingly stubs with sparse cast, artwork and synopsis data.
 * Override with TITLE_INDEX_MIN_VOTES (0–10000) on the server.
 */
export function titleIndexMinVotes(): number {
  const raw = typeof process !== 'undefined' ? process.env.TITLE_INDEX_MIN_VOTES : undefined;
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(parsed)) return DEFAULT_MIN_VOTES;
  return Math.min(10000, Math.max(0, Math.round(parsed)));
}

export interface TitleQualitySignals {
  type: MediaType;
  tmdbId: number;
  title: string;
  /** True only for real TMDB artwork (not the SVG placeholder). */
  hasPoster: boolean;
  overview: string;
  /** Full ISO date (YYYY-MM-DD) of first release / first air date. */
  releaseDate: string;
  genreCount: number;
  voteCount: number;
  adult: boolean;
}

export type TitleQualityFailure =
  | 'invalid-id'
  | 'missing-title'
  | 'missing-poster'
  | 'thin-synopsis'
  | 'missing-release-date'
  | 'unreleased'
  | 'missing-genres'
  | 'low-vote-count'
  | 'adult';

export interface TitleQualityResult {
  indexable: boolean;
  failures: TitleQualityFailure[];
  /** Canonical path (`/title/{type}/{id}-{slug}`) — present when the id is valid. */
  canonicalPath: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function canonicalTitlePath(type: MediaType, tmdbId: number, title: string): string {
  return `/title/${type}/${tmdbId}${titleSlugSuffix(tmdbId, title)}`;
}

export function assessTitleQuality(
  signals: TitleQualitySignals,
  options: { now?: Date; minVotes?: number } = {}
): TitleQualityResult {
  const failures: TitleQualityFailure[] = [];
  const now = options.now ?? new Date();
  const minVotes = options.minVotes ?? titleIndexMinVotes();

  const idValid = Number.isSafeInteger(signals.tmdbId) && signals.tmdbId > 0;
  if (!idValid) failures.push('invalid-id');

  const title = signals.title.trim();
  if (!isClean({ title })) failures.push('missing-title');

  if (!signals.hasPoster) failures.push('missing-poster');

  const overview = signals.overview.replace(/\s+/g, ' ').trim();
  if (overview === MISSING_SYNOPSIS_TEXT || overview.length < MIN_SYNOPSIS_CHARS) {
    failures.push('thin-synopsis');
  }

  if (!isValidIsoDate(signals.releaseDate)) {
    failures.push('missing-release-date');
  } else if (signals.releaseDate > now.toISOString().slice(0, 10)) {
    // Upcoming titles rarely have stable metadata; they become indexable
    // (and enter the sitemap) once released.
    failures.push('unreleased');
  }

  if (signals.genreCount < 1) failures.push('missing-genres');
  if (!(signals.voteCount >= minVotes)) failures.push('low-vote-count');
  if (signals.adult) failures.push('adult');

  return {
    indexable: failures.length === 0,
    failures,
    canonicalPath: idValid && title ? canonicalTitlePath(signals.type, signals.tmdbId, title) : null,
  };
}

/** Raw TMDB list/detail row (discover, popular, /movie/{id} …). */
export interface RawTmdbQualityRow {
  id?: number | string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  poster_path?: string | null;
  overview?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  genre_ids?: number[];
  genres?: Array<{ id?: number }>;
  vote_count?: number;
  adult?: boolean;
}

export function signalsFromTmdbRow(row: RawTmdbQualityRow, type: MediaType): TitleQualitySignals {
  // Mirrors normalizeTmdbItem, so the slug matches the page's canonical.
  const title = normalizeDisplayTitle(String(row.title || row.name || row.original_title || row.original_name || ''));
  const genreCount = Array.isArray(row.genre_ids)
    ? row.genre_ids.length
    : Array.isArray(row.genres)
      ? row.genres.length
      : 0;
  return {
    type,
    tmdbId: Number(row.id),
    title,
    hasPoster: typeof row.poster_path === 'string' && /^\/[\w.-]+$/.test(row.poster_path),
    overview: String(row.overview || ''),
    releaseDate: String((type === 'movie' ? row.release_date : row.first_air_date) || ''),
    genreCount,
    voteCount: Number(row.vote_count || 0),
    adult: row.adult === true,
  };
}

export function signalsFromDetail(detail: MediaDetail): TitleQualitySignals {
  return {
    type: detail.type,
    tmdbId: /^\d+$/.test(detail.id) ? Number(detail.id) : NaN,
    title: detail.title,
    hasPoster: detail.posterUrl.startsWith('https://image.tmdb.org/'),
    overview: detail.overview,
    releaseDate: detail.releaseDate,
    genreCount: detail.genreIds?.length ?? 0,
    voteCount: detail.voteCount,
    adult: false,
  };
}
