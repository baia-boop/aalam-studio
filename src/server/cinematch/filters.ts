import { normalizeTmdbItem } from '@/lib/tmdb';
import { isRecommendationEligible } from '@/lib/content-eligibility';
import { categoriesFor } from './catalog';
import type { Candidate, UserProfile } from './types';

/** Fewer than this many dislikes in a category never throttles it. */
export const CATEGORY_THROTTLE_START = 3;
export const CATEGORY_THROTTLE_FLOOR = 0.1;

/** Fraction of a category's candidates to keep after `dislikes` dislikes. */
export function categoryKeepRatio(dislikes: number): number {
  if (dislikes < CATEGORY_THROTTLE_START) return 1;
  return Math.max(CATEGORY_THROTTLE_FLOOR, Math.exp(-(dislikes - CATEGORY_THROTTLE_START + 1) * 0.35));
}

export function isLowQuality(c: Candidate): boolean {
  if (!c.hasPoster) return true;
  if (c.voteCount > 0 && c.voteCount < 25 && !c.sources.includes('collaborative')) return true;
  if (c.voteAverage > 0 && c.voteAverage < 5.2) return true;
  return false;
}

export function isUnreleased(c: Candidate, today = new Date().toISOString().slice(0, 10)): boolean {
  return Boolean(c.releaseDate) && c.releaseDate > today;
}

/**
 * Soft category throttle: repeated dislikes in a category progressively
 * shrink its share of candidates instead of hard-banning it, so one bad
 * horror film does not erase a whole genre.
 */
export function throttleCategories(candidates: Candidate[], profile: UserProfile): Candidate[] {
  const ratios: Record<string, number> = {};
  for (const [category, count] of Object.entries(profile.categoryDislikes)) {
    const ratio = categoryKeepRatio(count);
    if (ratio < 1) ratios[category] = ratio;
  }
  if (!Object.keys(ratios).length) return candidates;

  const worst = (c: Candidate) => {
    let pick: string | null = null;
    for (const category of categoriesFor(c.genreIds)) {
      if (category in ratios && (pick === null || ratios[category] < ratios[pick])) pick = category;
    }
    return pick;
  };
  const totals: Record<string, number> = {};
  for (const c of candidates) {
    const category = worst(c);
    if (category) totals[category] = (totals[category] ?? 0) + 1;
  }
  const kept: Record<string, number> = {};
  return candidates.filter((c) => {
    const category = worst(c);
    if (!category) return true;
    const quota = Math.floor(totals[category] * ratios[category]);
    if ((kept[category] ?? 0) >= quota) return false;
    kept[category] = (kept[category] ?? 0) + 1;
    return true;
  });
}

export function applyFilters(candidates: Candidate[], profile: UserProfile): Candidate[] {
  const today = new Date().toISOString().slice(0, 10);
  const eligible = candidates.filter(
    (c) => {
      const item = normalizeTmdbItem(c.raw as Parameters<typeof normalizeTmdbItem>[0], c.mediaType);
      return !profile.excluded.has(c.key) && !profile.disliked.has(c.key) && !isLowQuality(c) && !isUnreleased(c, today) && Boolean(item && isRecommendationEligible(item));
    }
  );
  return throttleCategories(eligible, profile);
}
