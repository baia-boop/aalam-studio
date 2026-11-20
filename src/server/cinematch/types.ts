import type { MediaItem, MediaType } from '@/types/media';

/** Raw TMDB list/detail item, kept so the public shape uses the app's normaliser. */
export interface RawTitle {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  genres?: Array<{ id?: number; name?: string }>;
  original_language?: string;
  adult?: boolean;
}

export type SignalKind = 'like' | 'dislike' | 'clear' | 'watch' | 'watchlist' | 'view' | 'onboarding';

/** One observed preference event for a title. */
export interface TitleSignal {
  tmdbId: number;
  mediaType: MediaType;
  kind: SignalKind;
  /** Event time, ms epoch. */
  at: number;
  /** 0..1 for watch events. */
  progress?: number;
  title?: string;
  genreIds?: number[];
}

export interface TitleFeatures {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  genreIds: number[];
  keywordIds: number[];
  /** Top-billed cast and directors/creators, with names for explanations. */
  people: Array<{ id: number; name: string; role: 'cast' | 'director' }>;
  language: string;
  decade: number | null;
}

export interface SeedTitle {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  weight: number;
}

export interface UserProfile {
  genre: Record<number, number>;
  keyword: Record<number, number>;
  people: Record<number, number>;
  decade: Record<number, number>;
  language: Record<string, number>;
  personNames: Record<number, string>;
  /** `type:id` keys never to recommend (already watched/saved/rated). */
  excluded: Set<string>;
  disliked: Set<string>;
  categoryDislikes: Record<string, number>;
  /** Strongest positive titles, used to seed similarity sources. */
  seeds: SeedTitle[];
  /** Genre ids of the most recent positive titles (session momentum). */
  recentGenres: number[];
  positiveCount: number;
  stage: 'cold' | 'warming' | 'warm';
}

export type SourceName =
  | 'recommendations'
  | 'similar'
  | 'collaborative'
  | 'people'
  | 'keyword'
  | 'genre'
  | 'language'
  | 'trending'
  | 'acclaimed'
  | 'explore';

export interface Candidate {
  key: string;
  tmdbId: number;
  mediaType: MediaType;
  raw: RawTitle;
  genreIds: number[];
  language: string;
  popularity: number;
  voteAverage: number;
  voteCount: number;
  releaseDate: string;
  hasPoster: boolean;
  /** Every source that surfaced this title, strongest first. */
  sources: SourceName[];
  /** Per-source explanation subject (seed title, genre, person, language). */
  seeds: Partial<Record<SourceName, string>>;
  fusion: number;
  keywordIds?: number[];
  peopleIds?: number[];
  decade?: number | null;
}

export interface ScoreBreakdown {
  genre: number;
  keyword: number;
  people: number;
  decade: number;
  language: number;
  popularity: number;
  freshness: number;
  quality: number;
  fusion: number;
  momentum: number;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  breakdown: ScoreBreakdown;
  primarySource: SourceName;
  reason: string;
  matchPct?: number;
}

export interface RecommendationSection {
  id: string;
  title: string;
  source: SourceName;
  items: MediaItem[];
}

export interface SourceReport {
  count: number;
  ms: number;
  ok: boolean;
}

export interface RecommendationResult {
  personalized: boolean;
  stage: UserProfile['stage'];
  items: MediaItem[];
  sections: RecommendationSection[];
  computedAt: string;
  engine: {
    version: string;
    ms: number;
    candidates: number;
    sources: Partial<Record<SourceName, SourceReport>>;
  };
}

export const ENGINE_VERSION = 'cinematch-2.0';
