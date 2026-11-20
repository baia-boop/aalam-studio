import { isShelfEligible } from '@/lib/content-eligibility';
import { DISCOVERY_LANGUAGE, SUBSCRIPTION_TYPE } from '@/lib/service-catalogue';
import type { WatchRegion } from '@/lib/watch-regions';
import type { MediaItem, MediaType } from '@/types/media';

export interface RegionalFeed {
  movies: MediaItem[];
  series: MediaItem[];
  popular: MediaItem[];
  /** One or more requests failed. Never replace these rows with a different market. */
  partial: boolean;
}

/** Same policy for every market. Origin stays broad (not a single language),
 * while the market chart includes international titles listed for subscription. */
export const REGIONAL_DISCOVERY = {
  railSize: 12,
  originRailSize: 8,
  marketCandidateLimit: 24,
  leadGenreLimit: 3,
  minHomeRailSize: 1,
} as const;

export function marketDiscoverParams(region: WatchRegion, type: MediaType, mode: 'origin' | 'market', today = new Date().toISOString().slice(0, 10)) {
  return {
    language: DISCOVERY_LANGUAGE,
    include_adult: 'false',
    page: 1,
    sort_by: 'popularity.desc',
    [type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte']: today,
    ...(mode === 'origin'
      ? { with_origin_country: region }
      : { watch_region: region, with_watch_monetization_types: SUBSCRIPTION_TYPE }),
  };
}

/** Choose from TMDB's popularity-ordered pool while allowing smaller markets
 * to fill their rail even if the result set has limited genre diversity. */
export function regionalPicks(items: MediaItem[], limit: number = REGIONAL_DISCOVERY.railSize): MediaItem[] {
  const genres = new Map<string, number>();
  const picks: MediaItem[] = [];
  const overflow: MediaItem[] = [];
  for (const item of items) {
    if (!isShelfEligible(item)) continue;
    const genre = item.genres[0] || '';
    const count = genres.get(genre) ?? 0;
    if (genre && count >= REGIONAL_DISCOVERY.leadGenreLimit) overflow.push(item);
    else {
      picks.push(item);
      genres.set(genre, count + 1);
      if (picks.length === limit) return picks;
    }
  }
  return [...picks, ...overflow].slice(0, limit);
}

/** Preserve rank within each format and interleave to avoid an all-movie chart. */
export function blendRegionalMedia(movies: MediaItem[], series: MediaItem[]): MediaItem[] {
  const items: MediaItem[] = [];
  for (let i = 0; i < Math.max(movies.length, series.length); i++) {
    if (movies[i]) items.push(movies[i]);
    if (series[i]) items.push(series[i]);
  }
  return items;
}
