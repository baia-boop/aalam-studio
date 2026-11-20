import type { MediaItem } from '@/types/media';
import { getConfig } from '../core/config';
import { hashString, mapConcurrent, withTimeout } from '../core/concurrency';
import { unavailable } from '../core/errors';
import { logger } from '../core/logger';
import { getOrSet, type CacheStatus } from '../cache';
import { isTmdbConfigured } from '../tmdb/gateway';
import { getTitleFeatures } from './features';
import { applyFilters } from './filters';
import { fuse } from './fusion';
import { buildProfile, collapseSignals, titlesForFeatures } from './profile';
import { diversify, injectExploration, scoreCandidates } from './ranking';
import { buildSections, toMediaItem } from './sections';
import {
  acclaimedSource, collaborativeSource, genreSource, keywordSource, languageSource, peopleSource,
  recommendationsSource, similarSource, trendingSource, type CollaborativeRow,
} from './sources';
import {
  ENGINE_VERSION, type Candidate, type RecommendationResult, type SourceName, type SourceReport,
  type TitleFeatures, type TitleSignal, type UserProfile,
} from './types';

/**
 * CineMatch orchestration:
 *
 *   signals ─► features ─► profile ─► sources (parallel, time-boxed)
 *     ─► weighted RRF fusion ─► filters ─► feature hydration ─► scoring
 *     ─► MMR diversity ─► exploration ─► sections ─► MediaItem[]
 *
 * Every stage degrades rather than fails: missing features fall back to
 * genres, slow sources are dropped at their deadline, and the whole result is
 * cached (cold-start feed globally, personal feeds per profile fingerprint).
 */

export interface RecommendInput {
  /** `guest` or `u:<id>`; part of the cache key. */
  scope: string;
  signals: TitleSignal[];
  genreWeights?: Record<number, number>;
  collaborative?: () => Promise<CollaborativeRow[]>;
  limit?: number;
}

const engineStats = { runs: 0, totalMs: 0, sourceTimeouts: 0, sourceErrors: 0, failures: 0 };
const HYDRATE_TOP = 18;

async function timedSource(
  name: SourceName,
  task: () => Promise<Candidate[]>,
  timeoutMs: number,
  reports: Partial<Record<SourceName, SourceReport>>
): Promise<{ source: SourceName; candidates: Candidate[] }> {
  const started = performance.now();
  let ok = true;
  const TIMEOUT = Symbol('timeout');
  const result = await withTimeout<Candidate[] | typeof TIMEOUT>(
    task().catch((error) => {
      ok = false;
      engineStats.sourceErrors += 1;
      logger.warn('CineMatch source failed', { source: name, error });
      return [];
    }),
    timeoutMs,
    TIMEOUT
  );
  if (result === TIMEOUT) {
    engineStats.sourceTimeouts += 1;
    ok = false;
  }
  const candidates = result === TIMEOUT ? [] : result;
  reports[name] = { count: candidates.length, ms: Math.round(performance.now() - started), ok };
  return { source: name, candidates };
}

async function loadFeatures(keys: Array<{ mediaType: Candidate['mediaType']; tmdbId: number }>, budgetMs: number) {
  const map = new Map<string, TitleFeatures>();
  await withTimeout(
    mapConcurrent(keys, 6, async ({ mediaType, tmdbId }) => {
      try {
        const f = await getTitleFeatures(mediaType, tmdbId);
        if (f) map.set(`${mediaType}:${tmdbId}`, f);
      } catch {
        // Unknown or unavailable titles simply contribute their genres only.
      }
    }),
    budgetMs,
    undefined
  );
  return map;
}

function sourcePlan(profile: UserProfile, collaborative?: RecommendInput['collaborative']): Array<[SourceName, () => Promise<Candidate[]>]> {
  if (profile.stage === 'cold') {
    return [['trending', trendingSource], ['acclaimed', acclaimedSource]];
  }
  const plan: Array<[SourceName, () => Promise<Candidate[]>]> = [
    ['recommendations', () => recommendationsSource(profile)],
    ['similar', () => similarSource(profile)],
    ['genre', () => genreSource(profile)],
    ['keyword', () => keywordSource(profile)],
    ['people', () => peopleSource(profile)],
    ['language', () => languageSource(profile)],
    ['trending', trendingSource],
  ];
  if (profile.stage === 'warming') plan.push(['acclaimed', acclaimedSource]);
  if (collaborative) plan.push(['collaborative', () => collaborativeSource(collaborative)]);
  return plan;
}

async function compute(input: RecommendInput, limit: number): Promise<RecommendationResult> {
  const started = performance.now();
  const { sourceTimeoutMs, pipelineBudgetMs } = getConfig().engine;
  const reports: Partial<Record<SourceName, SourceReport>> = {};

  const collapsed = collapseSignals(input.signals);
  const featureTargets = titlesForFeatures(collapsed).map((t) => ({ mediaType: t.mediaType, tmdbId: t.tmdbId }));
  const features = await loadFeatures(featureTargets, Math.min(2500, pipelineBudgetMs / 2));
  const profile = buildProfile(input.signals, features, { genreWeights: input.genreWeights });

  const lists = await Promise.all(
    sourcePlan(profile, input.collaborative).map(([name, task]) => timedSource(name, task, sourceTimeoutMs, reports))
  );
  const fused = applyFilters(fuse(lists), profile);

  if (profile.stage !== 'cold') {
    const toHydrate = fused.slice(0, HYDRATE_TOP);
    const hydrated = await loadFeatures(toHydrate.map((c) => ({ mediaType: c.mediaType, tmdbId: c.tmdbId })), 1500);
    for (const c of toHydrate) {
      const f = hydrated.get(c.key);
      if (!f) continue;
      c.keywordIds = f.keywordIds;
      c.peopleIds = f.people.map((p) => p.id);
      c.decade = f.decade;
      if (!c.genreIds.length) c.genreIds = f.genreIds;
    }
  }

  const scored = scoreCandidates(fused, profile).sort((a, b) => b.score - a.score);
  const diversified = diversify(scored, limit);
  const picked = new Set(diversified.map((c) => c.key));
  const ranked = injectExploration(diversified, scored.filter((c) => !picked.has(c.key)), profile, input.scope);

  const items = ranked.map(toMediaItem).filter((m): m is MediaItem => m !== null);
  const ms = Math.round(performance.now() - started);
  engineStats.runs += 1;
  engineStats.totalMs += ms;

  return {
    personalized: profile.stage !== 'cold',
    stage: profile.stage,
    items,
    sections: buildSections(scored, profile),
    computedAt: new Date().toISOString(),
    engine: { version: ENGINE_VERSION, ms, candidates: fused.length, sources: reports },
  };
}

/** Stable fingerprint of what the result depends on. */
export function profileFingerprint(input: RecommendInput, limit: number): string {
  const signals = [...input.signals]
    .map((s) => `${s.kind}:${s.mediaType}:${s.tmdbId}:${s.progress ?? ''}:${Math.floor(s.at / 3_600_000)}`)
    .sort()
    .join('|');
  const weights = Object.entries(input.genreWeights || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
  return `${hashString(signals).toString(36)}${hashString(weights).toString(36)}${limit}`;
}

export async function recommend(input: RecommendInput): Promise<{ result: RecommendationResult; cache: CacheStatus }> {
  if (!isTmdbConfigured()) {
    throw unavailable('CATALOGUE_UNAVAILABLE', 'Recommendations need the server TMDB key (TMDB_API_KEY).');
  }
  const limit = Math.min(60, Math.max(10, input.limit ?? 40));
  const isCold = input.signals.length === 0 && !Object.values(input.genreWeights || {}).some((v) => v > 0);
  const key = isCold ? `cm:${ENGINE_VERSION}:cold:${limit}` : `cm:${ENGINE_VERSION}:${input.scope}:${profileFingerprint(input, limit)}`;

  try {
    const { value, status } = await getOrSet(key, () => compute(input, limit), {
      ttl: isCold ? 30 * 60 : 10 * 60,
      swr: isCold ? 2 * 60 * 60 : 0,
      // Never cache a degraded (all sources failed) result.
      cacheIf: (v) => (v as RecommendationResult).items.length >= 5,
    });
    return { result: value, cache: status };
  } catch (error) {
    engineStats.failures += 1;
    throw error;
  }
}

export function getEngineStats() {
  return {
    version: ENGINE_VERSION,
    ...engineStats,
    avgMs: engineStats.runs ? Math.round(engineStats.totalMs / engineStats.runs) : 0,
  };
}
