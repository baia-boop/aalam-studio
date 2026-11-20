import type { Candidate, SourceName } from './types';

/**
 * Weighted Reciprocal Rank Fusion.
 *
 *   fusion(d) = Σ_sources  w_s / (K + rank_s(d))
 *
 * RRF needs no score calibration between sources (TMDB similarity, genre
 * discovery, peers …) and rewards consensus: a title surfaced by three
 * sources at rank 10 beats one surfaced by a single source at rank 1.
 */
export const RRF_K = 60;

export const SOURCE_WEIGHTS: Record<SourceName, number> = {
  recommendations: 1.15,
  similar: 1.1,
  collaborative: 1.1,
  people: 1.0,
  keyword: 1.0,
  genre: 0.95,
  language: 0.95,
  trending: 0.8,
  acclaimed: 0.75,
  explore: 0.5,
};

export function fuse(lists: Array<{ source: SourceName; candidates: Candidate[] }>): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const { source, candidates } of lists) {
    const seenInList = new Set<string>();
    candidates.forEach((candidate, rank) => {
      if (seenInList.has(candidate.key)) return;
      seenInList.add(candidate.key);
      const contribution = SOURCE_WEIGHTS[source] / (RRF_K + rank + 1);
      const existing = merged.get(candidate.key);
      if (!existing) {
        merged.set(candidate.key, {
          ...candidate,
          sources: [source],
          seeds: candidate.seeds[source] ? { [source]: candidate.seeds[source] } : {},
          fusion: contribution,
        });
        return;
      }
      existing.fusion += contribution;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (candidate.seeds[source] && !existing.seeds[source]) existing.seeds[source] = candidate.seeds[source];
      // List endpoints sometimes omit genres; keep the richest record.
      if (!existing.genreIds.length && candidate.genreIds.length) existing.genreIds = candidate.genreIds;
    });
  }
  return [...merged.values()].sort((a, b) => b.fusion - a.fusion);
}
