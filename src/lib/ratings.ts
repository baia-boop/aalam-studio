import { MIN_SOCIAL_PROOF_VOTES } from '@/lib/content-eligibility';

const compactVotes = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const exactVotes = new Intl.NumberFormat('en-US');

/**
 * Minimum TMDB votes before a title may appear in a "Top rated" list. A 9.4
 * from 12 votes is noise, not acclaim; series collect fewer votes than films.
 */
export const TOP_RATED_MIN_VOTES = { movie: 500, tv: 300 } as const;

/**
 * Below this many votes the average is too thin to show a score. Cards drop the
 * badge entirely and show year and genre instead; detail pages say "No rating yet".
 */
export const RATING_MIN_VOTES = MIN_SOCIAL_PROOF_VOTES;

export function isTopRatedEligible(type: 'movie' | 'tv', voteCount: number | undefined): boolean {
  return typeof voteCount === 'number' && voteCount >= TOP_RATED_MIN_VOTES[type];
}

/** True when the vote count is known and too small for the score to mean much. */
export function hasTooFewVotes(voteCount: number | undefined): boolean {
  return typeof voteCount === 'number' && Number.isSafeInteger(voteCount) && voteCount >= 0 && voteCount < RATING_MIN_VOTES;
}

/** Presentation context only: vote volume is not a statistical confidence score. */
export function ratingPresentation(rating: number, voteCount?: number) {
  if (typeof voteCount !== 'number' || !Number.isSafeInteger(voteCount) || voteCount < RATING_MIN_VOTES) {
    return {
      rated: false,
      limitedRatings: true,
      value: 'No rating yet',
      voteLabel: null,
      accessibleLabel: typeof voteCount === 'number' && Number.isSafeInteger(voteCount) && voteCount >= 0 ? `No rating yet: fewer than ${RATING_MIN_VOTES} votes so far` : 'Rating unavailable: vote count unknown',
    };
  }
  const rated = Number.isFinite(rating) && rating > 0 && rating <= 10;
  const votes = typeof voteCount === 'number' && Number.isSafeInteger(voteCount) && voteCount > 0 ? voteCount : null;
  const voteLabel = votes === null ? null : compactVotes.format(votes);
  const exactLabel = votes === null ? 'no vote count available' : `${exactVotes.format(votes)} ${votes === 1 ? 'vote' : 'votes'}`;
  return {
    rated,
    limitedRatings: false,
    value: rated ? rating.toFixed(1) : 'No rating yet',
    voteLabel: rated ? voteLabel : null,
    accessibleLabel: rated ? `Rated ${rating.toFixed(1)} out of 10 on TMDB, ${exactLabel}` : 'No rating yet',
  };
}
