import type { MediaItem, MediaType } from '@/types/media';
import { isRecommendationEligible } from '@/lib/content-eligibility';

/** Date-aware cutoff; when only a year is known, compare years without inventing a day. */
export function isOlderThanFortyYears(date: string | undefined, year: string, now: number = Date.now()): boolean {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(parsed)) {
      const cutoff = new Date(now);
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 40);
      return parsed < cutoff.getTime();
    }
  }
  return /^\d{4}$/.test(year) && Number(year) < new Date(now).getUTCFullYear() - 40;
}

/** Quality and type checks apply equally to recommendations, similar and editorial fallbacks. */
export function eligibleTitleRecommendation(
  item: MediaItem,
  type: MediaType,
  now: number = Date.now()
): boolean {
  return item.type === type && isRecommendationEligible(item, now);
}

/** Prioritize TMDB recommendations, then similar, then matching authored titles. */
export function selectTitleRecommendations(
  seed: Pick<MediaItem, 'id' | 'type' | 'genres' | 'genreIds'>,
  recommendations: readonly MediaItem[],
  similar: readonly MediaItem[],
  curated: readonly MediaItem[] = [],
  now: number = Date.now(),
  limit = 12
): MediaItem[] {
  const seen = new Set([`${seed.type}:${seed.id}`]);
  const selected: MediaItem[] = [];
  const add = (items: readonly MediaItem[], requireGenre: boolean) => {
    for (const item of items) {
      const key = `${item.type}:${item.id}`;
      const sharesGenre = item.genreIds?.some((id) => seed.genreIds?.includes(id)) ||
        item.genres.some((genre) => seed.genres.includes(genre));
      if (seen.has(key) || !eligibleTitleRecommendation(item, seed.type, now) || (requireGenre && !sharesGenre)) continue;
      seen.add(key);
      selected.push(item);
      if (selected.length >= limit) break;
    }
  };
  add(recommendations, false);
  if (selected.length < 8) add(similar, false);
  if (selected.length < 8) add(curated, true);
  return selected.slice(0, limit);
}
