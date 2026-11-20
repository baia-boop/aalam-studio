import type { MediaItem } from '@/types/media';
import { isReleased, isUpcoming } from '@/lib/release';

// Exact normalized names, not a blanket ban on numeric titles (e.g. 1917).
const BLOCKED_TITLES = new Set(['12 12 12', 'untitled']);
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'via']);

/** Fix sentence-case titles without flattening acronyms or intentionally mixed case. */
export function normalizeDisplayTitle(value: string): string {
  const clean = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  // Preserve all-caps and intentionally styled titles rather than guessing.
  const letters = clean.match(/\p{L}/gu) || [];
  if (letters.length && letters.every(c => c === c.toUpperCase() && c !== c.toLowerCase())) return clean;
  let word = 0;
  return clean.replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (part, offset: number) => {
    const index = word++;
    if (part !== part.toLowerCase()) return part;
    const afterColon = /[:!?]\s*$/.test(clean.slice(0, offset));
    if (index > 0 && !afterColon && SMALL_WORDS.has(part)) return part;
    return part.replace(/^\p{L}/u, c => c.toUpperCase());
  });
}

export function isClean(item: Pick<MediaItem, 'title'>): boolean {
  const title = normalizeDisplayTitle(item.title || '');
  const key = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return Boolean(key) && !BLOCKED_TITLES.has(key);
}

export const MIN_SOCIAL_PROOF_VOTES = 50;
export function hasSocialProof(item: Pick<MediaItem, 'voteCount'>, minimum = MIN_SOCIAL_PROOF_VOTES): boolean {
  return Number.isFinite(item.voteCount) && item.voteCount >= minimum;
}

/** Reject generated placeholders; both distinct artwork roles must be present. */
export function hasArtwork(item: Pick<MediaItem, 'posterUrl' | 'backdropUrl'>): boolean {
  const real = (url: string) => Boolean(url && !/^(?:data:|blob:)/i.test(url) && !/placeholder/i.test(url));
  return real(item.posterUrl) && real(item.backdropUrl);
}

export { isReleased, isUpcoming };
export function isShelfEligible(item: MediaItem, now = Date.now()): boolean {
  return isClean(item) && hasArtwork(item) && isReleased(item, now);
}
export function isHeroContentEligible(item: MediaItem, now = Date.now()): boolean {
  return isShelfEligible(item, now) && hasSocialProof(item, 500) && Number.isFinite(item.rating) && item.rating >= 7;
}
export function isRecommendationEligible(item: MediaItem, now = Date.now()): boolean {
  return isShelfEligible(item, now) && hasSocialProof(item, 300) && Number.isFinite(item.rating) && item.rating >= 6.5;
}
export function isComingSoonEligible(item: MediaItem, now = Date.now()): boolean {
  // No vote threshold: most future releases have not yet accumulated votes.
  return isClean(item) && hasArtwork(item) && isUpcoming(item, now);
}
