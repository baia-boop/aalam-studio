import type { AnimeFeedData, HomeFeedData, MediaItem } from '@/types/media';

/**
 * Above-the-fold / below-the-fold split for the long discovery pages.
 *
 * The cached (ISR) document only carries what a visitor sees first — the hero
 * carousel plus the two key rails — so the HTML and the inline RSC payload stay
 * small. The remaining rails are served from a separately cached JSON feed
 * (`/api/feeds/<name>`) that the client fetches when idle and renders when the
 * section approaches the viewport.
 */

export const DEFERRED_FEEDS = ['home-below', 'anime-below', 'home-full', 'home-editorial'] as const;
export type DeferredFeedName = (typeof DEFERRED_FEEDS)[number];

export function isDeferredFeedName(value: string): value is DeferredFeedName {
  return (DEFERRED_FEEDS as readonly string[]).includes(value);
}

export interface HomeBelowFold {
  /** The whole "Popular right now" shelf (released, rated). */
  popularNow: MediaItem[];
  trendingWeek: MediaItem[];
  topRated: MediaItem[];
  popularMovies: MediaItem[];
  popularSeries: MediaItem[];
  readyToPlay: MediaItem[];
  collectionStacks: HomeFeedData['collectionStacks'];
  topRatedPick: MediaItem | null;
  worldBackdrops: HomeFeedData['worldBackdrops'];
  isLive: boolean;
}

export interface AnimeBelowFold {
  topRated: MediaItem[];
  newReleases: MediaItem[];
  isLive: boolean;
}

export function splitHomeFeed(feed: HomeFeedData): {
  above: HomeFeedData;
  below: HomeBelowFold;
} {
  return {
    above: {
      featured: feed.featured,
      trendingToday: feed.trendingToday,
      // The two shelves that open the page below the hero: the chart and the
      // popular shelf. Both are small (10 + 14) and both must exist in the
      // first response, or the page's order would change as they arrive.
      popularNow: feed.popularNow,
      comingSoon: feed.comingSoon,
      // One timely rail is enough for the anonymous first response: weekly
      // trending and every generic editorial rail arrive with the deferred
      // feed (see docs/performance.md and the homepage hierarchy notes).
      trendingWeek: [],
      topRated: [],
      popularMovies: [],
      popularSeries: [],
      readyToPlay: [],
      collectionStacks: [],
      topRatedPick: null,
      worldBackdrops: {},
      isLive: feed.isLive,
    },
    below: {
      popularNow: feed.popularNow,
      trendingWeek: feed.trendingWeek,
      topRated: feed.topRated,
      popularMovies: feed.popularMovies,
      popularSeries: feed.popularSeries,
      readyToPlay: feed.readyToPlay,
      collectionStacks: feed.collectionStacks,
      topRatedPick: feed.topRatedPick,
      worldBackdrops: feed.worldBackdrops,
      isLive: feed.isLive,
    },
  };
}

export function splitAnimeFeed(feed: AnimeFeedData): {
  above: AnimeFeedData;
  below: AnimeBelowFold;
} {
  return {
    above: {
      featured: feed.featured,
      popularSeries: feed.popularSeries,
      animeMovies: feed.animeMovies,
      topRated: [],
      newReleases: [],
      isLive: feed.isLive,
    },
    below: {
      topRated: feed.topRated,
      newReleases: feed.newReleases,
      isLive: feed.isLive,
    },
  };
}

/** True when the home feed still lacks its deferred lower rails. */
export function homeBelowFoldMissing(feed: HomeFeedData): boolean {
  return (
    feed.trendingWeek.length === 0 &&
    feed.topRated.length === 0 &&
    feed.popularMovies.length === 0 &&
    feed.popularSeries.length === 0 &&
    feed.topRatedPick === null
  );
}

export function animeBelowFoldMissing(feed: AnimeFeedData): boolean {
  return feed.topRated.length === 0 && feed.newReleases.length === 0;
}
