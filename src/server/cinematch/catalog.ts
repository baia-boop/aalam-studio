/** Static catalogue knowledge used by the engine. */

export const GENRE_NAMES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

/**
 * TMDB uses different genre ids for some TV genres. Profiles are kept in the
 * movie id space so a liked film and a liked series reinforce each other.
 */
const TV_TO_MOVIE: Record<number, number[]> = {
  10759: [28, 12],
  10765: [878, 14],
  10768: [10752],
  10762: [10751],
};

const MOVIE_TO_TV: Record<number, number> = {
  28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768,
};

export function canonicalGenres(genreIds: readonly number[]): number[] {
  const out = new Set<number>();
  for (const id of genreIds) {
    const mapped = TV_TO_MOVIE[id];
    if (mapped) mapped.forEach((m) => out.add(m));
    else out.add(id);
  }
  return [...out];
}

export function tvGenreFor(movieGenreId: number): number {
  return MOVIE_TO_TV[movieGenreId] ?? movieGenreId;
}

/** Broad categories for dislike throttling ("stop showing me horror"). */
export const CATEGORIES: Record<string, readonly number[]> = {
  action: [28, 12],
  romance: [10749],
  horror: [27],
  scifi: [878, 14],
  thriller: [53, 9648],
  crime: [80],
  animation: [16],
  documentary: [99],
  drama: [18],
  comedy: [35],
  family: [10751],
  reality: [10764, 10767],
  war: [10752, 36],
  music: [10402],
  western: [37],
};

export function categoriesFor(genreIds: readonly number[]): string[] {
  const canonical = new Set(canonicalGenres(genreIds));
  return Object.entries(CATEGORIES)
    .filter(([, ids]) => ids.some((id) => canonical.has(id)))
    .map(([key]) => key);
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', ur: 'Urdu', pa: 'Punjabi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  ko: 'Korean', ja: 'Japanese', zh: 'Chinese', cn: 'Cantonese', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', tr: 'Turkish', ar: 'Arabic', fa: 'Persian', pt: 'Portuguese', th: 'Thai', id: 'Indonesian',
  ru: 'Russian', sv: 'Swedish', da: 'Danish', no: 'Norwegian', pl: 'Polish', nl: 'Dutch',
};
