import type { MediaItem } from '@/types/media';
import { ratingPresentation } from '@/lib/ratings';
import { isHeroContentEligible, isShelfEligible, isComingSoonEligible } from '@/lib/content-eligibility';

/**
 * Homepage curation rules.
 *
 * The home page is an *edited* page, not a dump of whatever the charts return.
 * These are the rules that decide what is allowed into each section, kept apart
 * from the components so they can be reasoned about (and tested) without a DOM:
 *
 *  - **Hero** — a title the visitor can watch tonight: released, at least 500
 *    votes, and rated 7.0 or better. Nothing unreleased is ever promoted here,
 *    because the hero's primary action is Play.
 *  - **Top 10 today** — the daily chart itself, released titles only, in chart
 *    order, with the chart position as the rank.
 *  - **Popular right now** — released titles that carry a real rating (see
 *    lib/ratings.ts), so no card in the shelf has to hide its score.
 *  - **Coming soon** — titles with a *known future* release date. They never
 *    appear in the hero, the chart or the popular shelf.
 *  - **Curated collections** — four authored registers, three posters each.
 *
 * Everything is pure: the same functions run in the server feed, in the client
 * view that re-filters regional titles, and in tests/home-curation.test.cjs.
 */

/** The hero bar. Both numbers are product rules, not heuristics. */
export const HERO_RULE = {
  /** Enough votes that the score is not a rounding artefact. */
  minVotes: 500,
  /** A featured title has to be one we would actually recommend. */
  minRating: 7.0,
  /** How many titles the carousel carries. */
  limit: 5,
} as const;

const keyOf = (item: Pick<MediaItem, 'type' | 'id'>) => `${item.type}:${item.id}`;

function uniqueById(items: readonly MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** The title carries a score the shelf can print (>= 50 votes, rated). */
export function hasRealRating(item: Pick<MediaItem, 'rating' | 'voteCount'>): boolean {
  return ratingPresentation(item.rating, item.voteCount).rated;
}

/** The hero bar, as one predicate. */
export function isHeroEligible(item: MediaItem, now: number = Date.now()): boolean {
  return isHeroContentEligible(item, now);
}

/**
 * The carousel.
 *
 * Order is editorial first (the server's featured pick), then the rest of the
 * daily chart by position, so the first slide is deliberate and later slides are
 * timely. Nothing here relaxes a rule to fill a slot: a short carousel is better
 * than an unreleased or weakly-rated headline.
 */
export function curateHero(
  input: { featured?: readonly MediaItem[]; trending?: readonly MediaItem[] },
  options: { limit?: number; now?: number } = {}
): MediaItem[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? HERO_RULE.limit;
  const pool = uniqueById([...(input.featured ?? []), ...(input.trending ?? [])]);
  return pool.filter((item) => isHeroEligible(item, now)).slice(0, limit);
}

/**
 * Top 10 today: the daily chart, released only, in chart order. The rank is the
 * position in the rendered list, so the shelf never shows #1, #3, #4.
 */
export function curateTopTen(
  trending: readonly MediaItem[],
  options: { limit?: number; now?: number } = {}
): MediaItem[] {
  const now = options.now ?? Date.now();
  return uniqueById(trending)
    .filter((item) => isShelfEligible(item, now))
    .slice(0, options.limit ?? 10);
}

/**
 * Popular right now: released titles whose rating is real, de-duplicated against
 * whatever the page already showed. Inputs arrive in priority order — a known
 * market's popular list first, then the global charts.
 */
export function curatePopular(
  pool: readonly MediaItem[],
  options: { limit?: number; now?: number; exclude?: Iterable<string> } = {}
): MediaItem[] {
  const now = options.now ?? Date.now();
  const excluded = new Set(options.exclude ?? []);
  return uniqueById(pool)
    .filter((item) => !excluded.has(keyOf(item)))
    .filter((item) => isShelfEligible(item, now) && hasRealRating(item))
    .slice(0, options.limit ?? 14);
}

/**
 * Coming soon: only titles with a known future date, in popularity order. A title without a verified upcoming theatrical date is omitted.
 */
export function curateComingSoon(
  pool: readonly MediaItem[],
  options: { limit?: number; now?: number } = {}
): MediaItem[] {
  const now = options.now ?? Date.now();
  return uniqueById(pool)
    .filter((item) => item.type === 'movie' && isComingSoonEligible(item, now) && Boolean(item.theatricalRegion) && isComingSoonEligible({ ...item, releaseDate: item.theatricalReleaseDate }, now))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, options.limit ?? 8);
}

/* ============================================================================
   Genres: artwork cards first, chips for the rest
   ============================================================================ */

export const GENRE_CARD_COUNT = 8;

/** Where a genre card and a genre chip both lead. */
export function genreHref(genre: string): string {
  return genre === 'Documentary'
    ? '/documentaries'
    : `/movies?genre=${encodeURIComponent(genre)}`;
}

export interface GenreCard {
  genre: string;
  href: string;
  /** Backdrop of the strongest title in that genre, when one is in the pool. */
  imageUrl: string | null;
}

/**
 * The eight genres with the most to show get artwork; the rest stay chips.
 *
 * The backdrop is the *top title's* own artwork — the title a visitor would find
 * if they opened the genre — so the picture is a promise the destination keeps.
 * Genres with nothing in the pool keep a gradient-only card rather than a
 * borrowed image.
 */
export function genreCards(input: {
  genres: readonly string[];
  pool: readonly MediaItem[];
  backdrops?: Record<string, { imageUrl: string }>;
  top?: number;
}): { cards: GenreCard[]; chips: string[] } {
  const top = Math.max(0, Math.min(input.top ?? GENRE_CARD_COUNT, input.genres.length));
  const ranked = [...input.genres].sort((a, b) => {
    const count = (genre: string) => input.pool.filter((item) => item.genres.includes(genre)).length;
    return count(b) - count(a);
  });

  const cards = ranked.slice(0, top).map((genre) => {
    const best = input.pool
      .filter((item) => item.genres.includes(genre) && Boolean(item.backdropThumbUrl || item.backdropUrl))
      .sort((a, b) => b.voteCount - a.voteCount || b.rating - a.rating)[0];
    return {
      genre,
      href: genreHref(genre),
      imageUrl: best?.backdropThumbUrl || best?.backdropUrl || input.backdrops?.[genre]?.imageUrl || null,
    };
  });

  // Chips keep the catalogue's own genre order, not the ranking above.
  const cardGenres = new Set(cards.map((card) => card.genre));
  return {
    cards,
    chips: input.genres.filter((genre) => !cardGenres.has(genre)),
  };
}
