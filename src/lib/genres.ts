import { MediaType } from '@/types/media';

export const BROWSE_GENRES = [
  'Action',
  'Adventure',
  'Sci-Fi',
  'Drama',
  'Thriller',
  'Crime',
  'Mystery',
  'Horror',
  'Fantasy',
  'Documentary',
  'Comedy',
  'Animation',
  'Family',
  'Romance',
] as const;

export const SORT_OPTIONS: Record<string, string> = {
  popularity: 'Most popular',
  top_rated: 'Highest rated',
  newest: 'Newest first',
  az: 'Title A–Z',
};

export const TMDB_GENRE_NAMES: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  // TV-specific genre IDs
  10759: 'Action',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

const MOVIE_GENRE_FILTER_IDS: Record<string, string> = {
  Action: '28',
  Adventure: '12',
  'Sci-Fi': '878',
  Drama: '18',
  Thriller: '53',
  Crime: '80',
  Mystery: '9648',
  Horror: '27',
  Fantasy: '14',
  Documentary: '99',
  Comedy: '35',
  Animation: '16',
  Family: '10751',
  Romance: '10749',
};

const TV_GENRE_FILTER_IDS: Record<string, string> = {
  Action: '10759',
  Adventure: '10759',
  'Sci-Fi': '10765',
  Drama: '18',
  Thriller: '80|9648',
  Crime: '80',
  Mystery: '9648',
  Horror: '9648|10765',
  Fantasy: '10765',
  Documentary: '99',
  Comedy: '35',
  Animation: '16',
  // TV "Family" covers the Family (10751) and Kids (10762) catalogue sections.
  Family: '10751|10762',
  Romance: '10749',
};

export function getTmdbGenreFilterId(type: MediaType, genreName: string): string {
  if (!genreName) return '';
  return type === 'movie'
    ? MOVIE_GENRE_FILTER_IDS[genreName] || ''
    : TV_GENRE_FILTER_IDS[genreName] || '';
}

/**
 * The canonical genre label for a catalogue landing (/movies?genre=…,
 * /series?genre=…), or '' when the genre does not change the listing.
 *
 * - Unknown genres apply no filter, so they would duplicate the bare page.
 * - Several labels can share one TMDB filter (e.g. TV "Action" and
 *   "Adventure" both use 10759). They render identical lists, so all of them
 *   canonicalize to the first label in BROWSE_GENRES order.
 */
export function canonicalGenreLanding(type: MediaType, genreName: string): string {
  const filterId = getTmdbGenreFilterId(type, genreName);
  if (!filterId) return '';
  return BROWSE_GENRES.find((g) => getTmdbGenreFilterId(type, g) === filterId) || '';
}

/** Distinct, indexable genre landings for a catalogue type (sitemap source). */
export function genreLandings(type: MediaType): string[] {
  return Array.from(
    new Set(BROWSE_GENRES.map((g) => canonicalGenreLanding(type, g)).filter(Boolean))
  );
}

export function mapGenreIds(ids?: number[]): string[] {
  if (!Array.isArray(ids) || !ids.length) return ['Drama'];
  const mapped = ids
    .map((id) => TMDB_GENRE_NAMES[id])
    .filter((v): v is string => Boolean(v));
  const unique = Array.from(new Set(mapped));
  return unique.length ? unique.slice(0, 3) : ['Drama'];
}

export const WORLD_GENRES: Array<{ genre: string; fallbackPexelsId: number }> = [
  { genre: 'Action', fallbackPexelsId: 28075918 },
  { genre: 'Sci-Fi', fallbackPexelsId: 36772273 },
  { genre: 'Thriller', fallbackPexelsId: 6695554 },
  { genre: 'Adventure', fallbackPexelsId: 34593219 },
  { genre: 'Mystery', fallbackPexelsId: 18634896 },
  { genre: 'Documentary', fallbackPexelsId: 5685222 },
];
