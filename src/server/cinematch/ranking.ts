import { hashString, seededRandom } from '../core/concurrency';
import { GENRE_NAMES } from './catalog';
import { SOURCE_WEIGHTS } from './fusion';
import type { Candidate, ScoreBreakdown, ScoredCandidate, SourceName, UserProfile } from './types';

/* ----------------------------------------------------------------------------
   Dynamic weights — how much each signal matters depends on how much we know.
   ------------------------------------------------------------------------- */

export interface RankingWeights {
  genre: number;
  keyword: number;
  people: number;
  decade: number;
  language: number;
  popularity: number;
  freshness: number;
  quality: number;
  fusion: number;
}

export function weightsFor(profile: UserProfile): RankingWeights {
  if (profile.stage === 'cold') {
    return { genre: 0.1, keyword: 0, people: 0, decade: 0, language: 0, popularity: 0.32, freshness: 0.22, quality: 0.28, fusion: 0.08 };
  }
  if (profile.stage === 'warming') {
    // Few signals: lean hard on genre to segment the user quickly.
    return { genre: 0.42, keyword: 0.08, people: 0.06, decade: 0.03, language: 0.07, popularity: 0.1, freshness: 0.07, quality: 0.12, fusion: 0.15 };
  }
  const richKeywords = Object.keys(profile.keyword).length > 40 ? 0.04 : 0;
  const richPeople = Object.keys(profile.people).length > 25 ? 0.04 : 0;
  return {
    genre: 0.28,
    keyword: 0.12 + richKeywords,
    people: 0.1 + richPeople,
    decade: 0.05,
    language: 0.08,
    popularity: 0.1 - (richKeywords + richPeople) / 2,
    freshness: 0.08,
    quality: 0.13,
    fusion: 0.15,
  };
}

/* ----------------------------------------------------------------------------
   Individual signals (each roughly in [-1, 1] or [0, 1]).
   ------------------------------------------------------------------------- */

const MAX_LOG_POP = Math.log1p(2000);
export const popularityScore = (p: number) => Math.min(1, Math.log1p(Math.max(0, p)) / MAX_LOG_POP);

/** Exponential decay with a 4-year half-life; undated titles are neutral. */
export function freshnessScore(releaseDate: string, now = Date.now()): number {
  const t = Date.parse(releaseDate);
  if (!releaseDate || Number.isNaN(t)) return 0.3;
  const years = Math.max(0, (now - t) / (365.25 * 86_400_000));
  return Math.exp((-years * Math.LN2) / 4);
}

/** Bayesian-shrunk rating: few votes pull the score towards a 6.5 prior. */
export function qualityScore(voteAverage: number, voteCount: number): number {
  const prior = 6.5;
  const m = 300;
  const shrunk = (voteAverage * voteCount + prior * m) / (voteCount + m);
  return Math.max(0, Math.min(1, (shrunk - 4) / 5));
}

function meanAffinity(ids: readonly number[] | undefined, vector: Record<number, number>): number {
  if (!ids?.length) return 0;
  let sum = 0;
  let hits = 0;
  for (const id of ids) {
    const w = vector[id];
    if (w !== undefined) {
      sum += w;
      hits += 1;
    }
  }
  if (!hits) return 0;
  // Coverage-weighted mean: one matching keyword of twenty counts for less.
  return (sum / hits) * Math.min(1, hits / Math.min(ids.length, 3));
}

function maxAffinity(ids: readonly number[] | undefined, vector: Record<number, number>): number {
  if (!ids?.length) return 0;
  let best = 0;
  for (const id of ids) {
    const w = vector[id] ?? 0;
    if (Math.abs(w) > Math.abs(best)) best = w;
  }
  return best;
}

/** Negative evidence is amplified: one strong dislike outweighs a mild like. */
const amplify = (v: number) => Math.max(-1.5, v < 0 ? v * 1.5 : v * 1.15);

const SOURCE_PRIORITY: SourceName[] = [
  'collaborative', 'recommendations', 'similar', 'people', 'keyword', 'language', 'genre', 'trending', 'acclaimed', 'explore',
];

function primarySource(c: Candidate): SourceName {
  return SOURCE_PRIORITY.find((s) => c.sources.includes(s)) ?? c.sources[0];
}

export function reasonFor(source: SourceName, seed: string | undefined, breakdown: ScoreBreakdown, c: Candidate, profile: UserProfile): string {
  switch (source) {
    case 'recommendations':
      return seed ? `Because you liked ${seed}` : 'Recommended from titles you liked';
    case 'similar':
      return seed ? `Similar to ${seed}` : 'Similar to titles you watched';
    case 'collaborative':
      return 'Viewers with similar taste loved this';
    case 'people':
      return seed ? `From ${seed}, whose work you enjoy` : 'From creators you enjoy';
    case 'keyword':
      return seed ? `Shares themes with ${seed}` : 'Matches themes you enjoy';
    case 'language':
      return seed ? `Popular ${seed}-language pick` : 'From a language you watch';
    case 'genre': {
      const top = c.genreIds.find((g) => (profile.genre[g] ?? 0) > 0.3);
      return `${GENRE_NAMES[top ?? -1] || seed || 'Genre'} pick with strong ratings`;
    }
    case 'explore':
      return 'Something different you might enjoy';
    case 'trending':
      return breakdown.genre > 0.3 ? 'Trending this week and fits your taste' : 'Trending this week';
    case 'acclaimed':
      return 'Highly rated on TMDB';
  }
}

/**
 * Honest match percentage from taste affinity only (not popularity), shown
 * only once the profile has signals. Range 50–98.
 */
export function matchPercent(b: ScoreBreakdown, profile: UserProfile): number | undefined {
  if (profile.stage === 'cold') return undefined;
  const affinity = 0.55 * b.genre + 0.18 * b.keyword + 0.15 * b.people + 0.12 * b.language;
  const scaled = 1 / (1 + Math.exp(-4 * affinity)); // 0.5 at neutral
  return Math.round(Math.min(98, Math.max(50, 50 + 96 * (scaled - 0.5) + 10 * b.quality)));
}

export function scoreCandidates(candidates: Candidate[], profile: UserProfile, now = Date.now()): ScoredCandidate[] {
  const weights = weightsFor(profile);
  const maxFusion = Math.max(1e-9, ...candidates.map((c) => c.fusion));
  const recent = new Set(profile.recentGenres);
  const momentumScale = profile.stage === 'warming' ? 2 : 1;

  return candidates.map((c) => {
    const breakdown: ScoreBreakdown = {
      genre: amplify(meanAffinity(c.genreIds, profile.genre)),
      keyword: amplify(meanAffinity(c.keywordIds, profile.keyword)),
      people: amplify(maxAffinity(c.peopleIds, profile.people)),
      decade: c.decade ? amplify(profile.decade[c.decade] ?? 0) : 0,
      language: c.language ? amplify(profile.language[c.language] ?? 0) : 0,
      popularity: popularityScore(c.popularity),
      freshness: freshnessScore(c.releaseDate, now),
      quality: qualityScore(c.voteAverage, c.voteCount),
      fusion: c.fusion / maxFusion,
      momentum: 0,
    };
    if (recent.size && c.genreIds.length) {
      const overlap = c.genreIds.filter((g) => recent.has(g)).length / c.genreIds.length;
      breakdown.momentum = 0.08 * overlap * momentumScale;
    }
    const base =
      weights.genre * breakdown.genre +
      weights.keyword * breakdown.keyword +
      weights.people * breakdown.people +
      weights.decade * breakdown.decade +
      weights.language * breakdown.language +
      weights.popularity * breakdown.popularity +
      weights.freshness * breakdown.freshness +
      weights.quality * breakdown.quality +
      weights.fusion * breakdown.fusion +
      breakdown.momentum;
    const source = primarySource(c);
    // Mild prior for the strongest contributing source.
    const score = base * (0.92 + 0.08 * SOURCE_WEIGHTS[source]);
    return {
      ...c,
      score,
      breakdown,
      primarySource: source,
      reason: reasonFor(source, c.seeds[source], breakdown, c, profile),
      matchPct: matchPercent(breakdown, profile),
    };
  });
}

/* ----------------------------------------------------------------------------
   Diversity — greedy Maximal Marginal Relevance.
   ------------------------------------------------------------------------- */

function genreSimilarity(a: ScoredCandidate, b: ScoredCandidate): number {
  if (!a.genreIds.length || !b.genreIds.length) return 0;
  const setB = new Set(b.genreIds);
  const intersection = a.genreIds.filter((g) => setB.has(g)).length;
  const union = new Set([...a.genreIds, ...b.genreIds]).size;
  let sim = intersection / union;
  const seedA = a.seeds[a.primarySource];
  if (seedA && seedA === b.seeds[b.primarySource]) sim = Math.min(1, sim + 0.25);
  if (a.mediaType !== b.mediaType) sim *= 0.85;
  return sim;
}

/**
 * Picks items maximising  λ·relevance − (1−λ)·max-similarity-to-picked, so the
 * top of the list spans genres and seeds instead of ten near-duplicates.
 * Hidden gems (high quality, low popularity) get a small serendipity bonus.
 */
export function diversify(scored: ScoredCandidate[], limit: number, lambda = 0.78): ScoredCandidate[] {
  const pool = scored.map((c) => {
    const gem = c.breakdown.quality > 0.62 && c.breakdown.popularity < 0.45 ? 0.03 : 0;
    return { ...c, score: c.score + gem };
  });
  pool.sort((a, b) => b.score - a.score);
  if (!pool.length) return [];
  const minScore = pool[pool.length - 1].score;
  const range = Math.max(1e-9, pool[0].score - minScore);
  const picked: ScoredCandidate[] = [];
  const remaining = pool.slice(0, Math.max(limit * 3, 60));

  while (picked.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const relevance = (remaining[i].score - minScore) / range;
      let maxSim = 0;
      for (const p of picked.slice(-12)) maxSim = Math.max(maxSim, genreSimilarity(remaining[i], p));
      const value = lambda * relevance - (1 - lambda) * maxSim;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    picked.push(remaining.splice(bestIndex, 1)[0]);
  }
  return picked;
}

/* ----------------------------------------------------------------------------
   Exploration — deterministic wildcard injection.
   ------------------------------------------------------------------------- */

/**
 * For established profiles, moves up to two high-quality titles from outside
 * the user's dominant genres into the first screenful. The RNG is seeded by
 * profile + day, so a user sees a stable list within a day (cache-friendly,
 * testable) but fresh exploration across days.
 */
export function injectExploration(
  ranked: ScoredCandidate[],
  tail: ScoredCandidate[],
  profile: UserProfile,
  seedKey: string,
  day = new Date().toISOString().slice(0, 10)
): ScoredCandidate[] {
  if (profile.stage !== 'warm' || ranked.length < 12) return ranked;
  const dominant = new Set(
    Object.entries(profile.genre).filter(([, w]) => w > 0.5).map(([id]) => Number(id))
  );
  const inRanked = new Set(ranked.map((c) => c.key));
  const wildcards = tail
    .filter((c) => !inRanked.has(c.key) && c.breakdown.quality > 0.6 && c.breakdown.genre > -0.2)
    .filter((c) => c.genreIds.length > 0 && c.genreIds.every((g) => !dominant.has(g)))
    .slice(0, 2);
  if (!wildcards.length) return ranked;

  const random = seededRandom(hashString(`${seedKey}:${day}`));
  const out = [...ranked];
  for (const wildcard of wildcards) {
    const position = 4 + Math.floor(random() * 8);
    out.splice(position, 0, {
      ...wildcard,
      primarySource: 'explore',
      sources: [...wildcard.sources, 'explore'],
      reason: reasonFor('explore', undefined, wildcard.breakdown, wildcard, profile),
    });
    out.pop();
  }
  return out;
}
