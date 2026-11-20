import type { MediaType } from '@/types/media';
import { TOP_RATED_MIN_VOTES } from '@/lib/ratings';
import { tmdbTry } from '../tmdb/gateway';
import { mapConcurrent } from '../core/concurrency';
import { GENRE_NAMES, LANGUAGE_NAMES, canonicalGenres, tvGenreFor } from './catalog';
import { topEntries } from './profile';
import type { Candidate, RawTitle, SourceName, UserProfile } from './types';

/**
 * Candidate retrieval. Each source returns titles in its own relevance order;
 * fusion later rewards titles that several independent sources agree on.
 * Every source is best-effort: failures return [] and never fail the request.
 */

interface ListResponse {
  results?: RawTitle[];
}

export function toCandidate(raw: RawTitle, fallbackType: MediaType | undefined, source: SourceName, seed?: string): Candidate | null {
  if (!raw?.id || raw.adult || raw.media_type === 'person') return null;
  const mediaType: MediaType | undefined =
    raw.media_type === 'movie' || raw.media_type === 'tv'
      ? raw.media_type
      : fallbackType ?? (raw.title ? 'movie' : raw.name ? 'tv' : undefined);
  if (!mediaType) return null;
  const genreIds = raw.genre_ids ?? (raw.genres || []).map((g) => g.id).filter((id): id is number => Number.isInteger(id));
  return {
    key: `${mediaType}:${raw.id}`,
    tmdbId: raw.id,
    mediaType,
    raw: { ...raw, media_type: mediaType },
    genreIds: canonicalGenres(genreIds),
    language: raw.original_language || '',
    popularity: raw.popularity || 0,
    voteAverage: raw.vote_average || 0,
    voteCount: raw.vote_count || 0,
    releaseDate: raw.release_date || raw.first_air_date || '',
    hasPoster: Boolean(raw.poster_path),
    sources: [source],
    seeds: seed ? { [source]: seed } : {},
    fusion: 0,
  };
}

function fromList(data: ListResponse | null, type: MediaType | undefined, source: SourceName, seed?: string, limit = 20): Candidate[] {
  return (data?.results || [])
    .map((raw) => toCandidate(raw, type, source, seed))
    .filter((c): c is Candidate => c !== null)
    .slice(0, limit);
}

const BASE = { language: 'en-US', page: 1 } as const;

/** Interleaves per-seed lists so the strongest seed does not monopolise ranks. */
function interleave(lists: Candidate[][]): Candidate[] {
  const out: Candidate[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const list of lists) if (list[i]) out.push(list[i]);
  return out;
}

export async function recommendationsSource(profile: UserProfile): Promise<Candidate[]> {
  const lists = await mapConcurrent(profile.seeds.slice(0, 5), 5, async (seed) =>
    fromList(await tmdbTry<ListResponse>(`${seed.mediaType}/${seed.tmdbId}/recommendations`, BASE), seed.mediaType, 'recommendations', seed.title, 15)
  );
  return interleave(lists);
}

export async function similarSource(profile: UserProfile): Promise<Candidate[]> {
  const lists = await mapConcurrent(profile.seeds.slice(0, 4), 4, async (seed) =>
    fromList(await tmdbTry<ListResponse>(`${seed.mediaType}/${seed.tmdbId}/similar`, BASE), seed.mediaType, 'similar', seed.title, 12)
  );
  return interleave(lists);
}

export async function genreSource(profile: UserProfile): Promise<Candidate[]> {
  const top = topEntries(profile.genre, 3, 0.25).map(([id]) => Number(id));
  const lists = await mapConcurrent(top, 3, async (genreId) => {
    const name = GENRE_NAMES[genreId] || 'Genre';
    const [movies, series] = await Promise.all([
      tmdbTry<ListResponse>('discover/movie', { ...BASE, with_genres: genreId, sort_by: 'vote_average.desc', 'vote_count.gte': TOP_RATED_MIN_VOTES.movie }),
      tmdbTry<ListResponse>('discover/tv', { ...BASE, with_genres: tvGenreFor(genreId), sort_by: 'vote_average.desc', 'vote_count.gte': TOP_RATED_MIN_VOTES.tv }),
    ]);
    return interleave([fromList(movies, 'movie', 'genre', name, 12), fromList(series, 'tv', 'genre', name, 12)]);
  });
  return interleave(lists);
}

export async function keywordSource(profile: UserProfile): Promise<Candidate[]> {
  const keywords = topEntries(profile.keyword, 5, 0.3).map(([id]) => id);
  if (keywords.length < 2) return [];
  const anchor = profile.seeds[0]?.title;
  const joined = keywords.join('|');
  const [movies, series] = await Promise.all([
    tmdbTry<ListResponse>('discover/movie', { ...BASE, with_keywords: joined, sort_by: 'popularity.desc', 'vote_count.gte': 150 }),
    tmdbTry<ListResponse>('discover/tv', { ...BASE, with_keywords: joined, sort_by: 'popularity.desc', 'vote_count.gte': 80 }),
  ]);
  return interleave([fromList(movies, 'movie', 'keyword', anchor, 15), fromList(series, 'tv', 'keyword', anchor, 10)]);
}

/** Graph hop: titles that share the directors/actors the user responds to. */
export async function peopleSource(profile: UserProfile): Promise<Candidate[]> {
  const top = topEntries(profile.people, 3, 0.35).map(([id]) => Number(id));
  const lists = await mapConcurrent(top, 3, async (personId) => {
    const data = await tmdbTry<ListResponse>('discover/movie', {
      ...BASE,
      with_people: personId,
      sort_by: 'vote_average.desc',
      'vote_count.gte': 200,
    });
    return fromList(data, 'movie', 'people', profile.personNames[personId], 10);
  });
  return interleave(lists);
}

/** Surfaces strong non-English tastes (Urdu, Hindi, Korean, Japanese …). */
export async function languageSource(profile: UserProfile): Promise<Candidate[]> {
  const [top] = topEntries(profile.language, 1, 0.35);
  if (!top || top[0] === 'en') return [];
  const lang = String(top[0]);
  const label = LANGUAGE_NAMES[lang] || lang.toUpperCase();
  const [movies, series] = await Promise.all([
    tmdbTry<ListResponse>('discover/movie', { ...BASE, with_original_language: lang, sort_by: 'popularity.desc', 'vote_count.gte': 50 }),
    tmdbTry<ListResponse>('discover/tv', { ...BASE, with_original_language: lang, sort_by: 'popularity.desc', 'vote_count.gte': 30 }),
  ]);
  return interleave([fromList(movies, 'movie', 'language', label, 12), fromList(series, 'tv', 'language', label, 12)]);
}

export async function trendingSource(): Promise<Candidate[]> {
  const data = await tmdbTry<ListResponse>('trending/all/week', { language: 'en-US' });
  return fromList(data, undefined, 'trending', undefined, 20);
}

export async function acclaimedSource(): Promise<Candidate[]> {
  const [movies, series] = await Promise.all([
    tmdbTry<ListResponse>('movie/top_rated', BASE),
    tmdbTry<ListResponse>('tv/top_rated', BASE),
  ]);
  return interleave([fromList(movies, 'movie', 'acclaimed', undefined, 15), fromList(series, 'tv', 'acclaimed', undefined, 15)]);
}

export interface CollaborativeRow {
  tmdbId: number;
  mediaType: MediaType;
  score: number;
}

/** Hydrates privacy-preserving co-occurrence rows into full candidates. */
export async function collaborativeSource(load: () => Promise<CollaborativeRow[]>): Promise<Candidate[]> {
  const rows = (await load()).slice(0, 12);
  const hydrated = await mapConcurrent(rows, 6, async (row) => {
    const raw = await tmdbTry<RawTitle>(`${row.mediaType}/${row.tmdbId}`, { language: 'en-US' });
    return raw ? toCandidate(raw, row.mediaType, 'collaborative') : null;
  });
  return hydrated.filter((c): c is Candidate => c !== null);
}
