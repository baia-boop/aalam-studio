import type { WatchRegion } from '@/lib/watch-regions';
import type { CollectionStack } from '@/lib/collections';

export type MediaType = 'movie' | 'tv';

export type BrowseMode = 'home' | 'movie' | 'tv' | 'anime' | 'documentary';

export interface MediaItem {
  id: string;
  tmdbId?: number;
  type: MediaType;
  title: string;
  posterUrl: string;
  posterSrcSet?: string;
  backdropUrl: string;
  backdropThumbUrl: string;
  backdropSrcSet?: string;
  genres: string[];
  genreIds?: number[];
  year: string;
  /**
   * ISO `YYYY-MM-DD` release (or first-air) date from TMDB. Absent when the
   * source has none; see lib/release.ts for how that is interpreted.
   */
  releaseDate?: string;
  /** Verified TMDB theatrical date and market for a Coming soon card. */
  theatricalReleaseDate?: string;
  theatricalRegion?: string;
  lengthLabel: string;
  rating: number;
  voteCount: number;
  popularity: number;
  cert: string;
  sourcesCount: number;
  tagline?: string;
  /** Transparent title-treatment logo (TMDB /images, English or textless). */
  logoUrl?: string;
  overview: string;
  editorialNote?: string;
  matchPct?: number;
  recommendationReason?: string;
}

export interface CastMember {
  id: string;
  name: string;
  character: string;
  profileUrl: string | null;
}

export interface VideoItem {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
  /** ISO timestamp TMDB lists for the upload, when known. */
  publishedAt?: string;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate?: string;
}

export interface EpisodeItem {
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  stillUrl: string;
  runtime: number;
  airDate?: string;
  rating?: number;
}

export interface MediaDetail extends MediaItem {
  tagline: string;
  status: string;
  releaseDate: string;
  runtimeMinutes: number;
  seasonsCount: number;
  isLimitedSeries?: boolean;
  episodesCount: number;
  seasons: SeasonSummary[];
  creatorOrDirector: string;
  originalLanguage: string;
  networkOrStudio: string;
  cast: CastMember[];
  videos: VideoItem[];
  trailerKey: string | null;
  certificationsByRegion?: Partial<Record<WatchRegion, string>>;
  related: MediaItem[];
  imdbId?: string | null;
  /**
   * When TMDB served this data (ISO). Detail pages are cached (ISR), so the
   * page shows this beside volatile facts: rating, votes, release status.
   */
  fetchedAt?: string;
  /**
   * Provenance for structured data. Several display fields carry readable
   * fallbacks ("Not rated", "—", 45-minute episodes, "Drama"); these flags
   * say which values TMDB actually supplied.
   */
  verified?: {
    certification: boolean;
    genres: boolean;
    overview: boolean;
  };
  /** Credited directors (movies), as listed on TMDB. */
  directors?: string[];
  /** Credited creators (series), as listed on TMDB. */
  creators?: string[];
}

export interface ContinueItem {
  key: string;
  item: MediaItem;
  season?: number;
  episode?: number;
  episodeName?: string;
  pct: number;
  /** Seconds watched, when the player could report them. */
  positionSec?: number;
  /** Total duration in seconds, when known. */
  durationSec?: number;
  leftLabel: string;
  server?: string;
  updatedAt: number;
  /**
   * Watched to the end (`>= CONTINUE_COMPLETED_PCT`). Finished rows stay in the
   * history so the library can show them, but Continue Watching never offers
   * them as unfinished.
   */
  completed?: boolean;
}

export interface TasteSeed {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  genreIds: number[];
}

export interface CineMatchProfile {
  enabled?: boolean;
  previewAutoplay?: boolean;
  floatingShortcut?: boolean;
  completedOnboarding: boolean;
  seeds: TasteSeed[];
  likedKeys: string[];
  dislikedKeys: string[];
  genreWeights: Record<number, number>;
}

export interface HomeFeedData {
  featured: MediaItem[];
  trendingToday: MediaItem[];
  trendingWeek: MediaItem[];
  topRated: MediaItem[];
  /** TMDB /movie/popular — audience pull, not a rating. */
  popularMovies: MediaItem[];
  popularSeries: MediaItem[];
  readyToPlay: MediaItem[];
  /** Released, rated titles for the "Popular right now" shelf (lib/home-curation.ts). */
  popularNow: MediaItem[];
  /** Titles with a known future release date, soonest first. */
  comingSoon: MediaItem[];
  /** Authored collections with three posters each, resolved on the server. */
  collectionStacks: CollectionStack[];
  /** Highest-rated title not already in the spotlight — algorithmic, never editorial. */
  topRatedPick: MediaItem | null;
  worldBackdrops: Record<string, { imageUrl: string; countLabel: string }>;
  isLive: boolean;
}

export interface AnimeFeedData {
  featured: MediaItem[];
  popularSeries: MediaItem[];
  animeMovies: MediaItem[];
  topRated: MediaItem[];
  newReleases: MediaItem[];
  isLive: boolean;
}

export interface PaginatedResult {
  items: MediaItem[];
  page: number;
  totalPages: number;
  /**
   * TMDB reported more pages than it serves (500). `totalPages` is then only
   * the last reachable page and is not shown as a count.
   */
  totalPagesCapped?: boolean;
  totalResults: number;
  /** All requested upstream catalogue lists failed, rather than returning zero matches. */
  unavailable?: boolean;
  isLive: boolean;
  smartQueryHint?: string;
  /** Server search corrected a likely typo and searched this title instead. */
  correctedQuery?: string;
  /** Set when results are scoped to a person's credits or a collection. */
  scope?: SearchScope;
}

/** A person or collection chosen from search suggestions. */
export interface SearchScope {
  kind: 'person' | 'collection';
  id: number;
  /** Name as listed on TMDB (not the URL's query text). */
  name: string;
}
