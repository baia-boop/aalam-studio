import { categoriesFor, canonicalGenres } from './catalog';
import type { SeedTitle, SignalKind, TitleFeatures, TitleSignal, UserProfile } from './types';

/**
 * Builds a taste profile from preference signals.
 *
 * Unlike an append-only weight sum, signals are first collapsed per title:
 * the latest explicit choice (like / dislike / clear) wins, implicit signals
 * (watch progress, watchlist, views) provide a floor. Un-liking a title truly
 * removes its influence instead of leaving the original "like" in the sum.
 * Weights then decay with age (45-day half-life) before being projected onto
 * genre / keyword / people / decade / language vectors normalised to [-1, 1].
 */

const HALF_LIFE_DAYS = 45;
const EXPLICIT_DECAY_FLOOR = 0.35;
export const MAX_FEATURE_TITLES = 14;

export function watchWeight(progress: number | undefined): number {
  if (progress === undefined) return 0.35;
  if (progress >= 0.85) return 1.0;
  if (progress >= 0.5) return 0.8;
  if (progress >= 0.2) return 0.45;
  return 0.15;
}

const IMPLICIT: Partial<Record<SignalKind, number>> = { watchlist: 0.6, view: 0.12, onboarding: 0.9 };

export interface CollapsedTitle {
  key: string;
  tmdbId: number;
  mediaType: TitleSignal['mediaType'];
  weight: number;
  /** Most recent event time. */
  at: number;
  explicit: 'like' | 'dislike' | null;
  watched: boolean;
  saved: boolean;
  title?: string;
  genreIds?: number[];
}

export function collapseSignals(signals: readonly TitleSignal[]): CollapsedTitle[] {
  const byKey = new Map<string, { list: TitleSignal[] }>();
  for (const signal of signals) {
    const key = `${signal.mediaType}:${signal.tmdbId}`;
    const entry = byKey.get(key) ?? { list: [] };
    entry.list.push(signal);
    byKey.set(key, entry);
  }

  const out: CollapsedTitle[] = [];
  for (const [key, { list }] of byKey) {
    list.sort((a, b) => a.at - b.at);
    let explicit: CollapsedTitle['explicit'] = null;
    let implicit = 0;
    let watched = false;
    let saved = false;
    let title: string | undefined;
    let genreIds: number[] | undefined;
    for (const s of list) {
      if (s.kind === 'like' || s.kind === 'onboarding') explicit = 'like';
      else if (s.kind === 'dislike') explicit = 'dislike';
      else if (s.kind === 'clear') explicit = null;
      if (s.kind === 'watch') {
        watched = watched || (s.progress ?? 0) >= 0.1 || s.progress === undefined;
        implicit = Math.max(implicit, watchWeight(s.progress));
      } else if (IMPLICIT[s.kind] !== undefined && s.kind !== 'onboarding') {
        implicit = Math.max(implicit, IMPLICIT[s.kind]!);
      }
      if (s.kind === 'watchlist') saved = true;
      title = s.title || title;
      if (s.genreIds?.length) genreIds = s.genreIds;
    }
    const weight = explicit === 'dislike' ? -1 : explicit === 'like' ? Math.max(0.9, implicit) : implicit;
    if (weight === 0) continue;
    const last = list[list.length - 1];
    out.push({ key, tmdbId: last.tmdbId, mediaType: last.mediaType, weight, at: last.at, explicit, watched, saved, title, genreIds });
  }
  return out;
}

export function decayFactor(at: number, explicit: boolean, now = Date.now()): number {
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  const decay = Math.exp((-ageDays * Math.LN2) / HALF_LIFE_DAYS);
  return explicit ? Math.max(EXPLICIT_DECAY_FLOOR, decay) : decay;
}

/** Which titles deserve a feature lookup: strongest effective signals first. */
export function titlesForFeatures(collapsed: readonly CollapsedTitle[], now = Date.now()): CollapsedTitle[] {
  return [...collapsed]
    .sort((a, b) => Math.abs(b.weight * decayFactor(b.at, !!b.explicit, now)) - Math.abs(a.weight * decayFactor(a.at, !!a.explicit, now)))
    .slice(0, MAX_FEATURE_TITLES);
}

function add<K extends string | number>(vector: Record<K, number>, key: K, amount: number) {
  vector[key] = (vector[key] ?? 0) + amount;
}

function normalize<K extends string | number>(vector: Record<K, number>): Record<K, number> {
  const values = Object.values(vector) as number[];
  const max = Math.max(1e-9, ...values.map(Math.abs));
  const out = {} as Record<K, number>;
  for (const [key, value] of Object.entries(vector) as Array<[K, number]>) {
    const n = value / max;
    if (Math.abs(n) >= 0.02) out[key] = Math.round(n * 1000) / 1000;
  }
  return out;
}

export function buildProfile(
  signals: readonly TitleSignal[],
  features: ReadonlyMap<string, TitleFeatures>,
  options: { genreWeights?: Record<number, number>; now?: number } = {}
): UserProfile {
  const now = options.now ?? Date.now();
  const collapsed = collapseSignals(signals);
  const genre: Record<number, number> = {};
  const keyword: Record<number, number> = {};
  const people: Record<number, number> = {};
  const decade: Record<number, number> = {};
  const language: Record<string, number> = {};
  const personNames: Record<number, string> = {};
  const excluded = new Set<string>();
  const disliked = new Set<string>();
  const categoryDislikes: Record<string, number> = {};
  const seeds: SeedTitle[] = [];
  let positiveCount = 0;

  for (const title of collapsed) {
    const effective = title.weight * decayFactor(title.at, !!title.explicit, now);
    if (title.weight < 0) disliked.add(title.key);
    // Anything rated, saved or actually watched is not re-recommended. Views are.
    if (title.explicit || title.watched || title.saved) excluded.add(title.key);
    if (title.weight > 0) positiveCount += 1;

    const f = features.get(title.key);
    const genres = f?.genreIds ?? canonicalGenres(title.genreIds ?? []);
    for (const g of genres) add(genre, g, effective);
    if (title.weight < 0) for (const c of categoriesFor(genres)) categoryDislikes[c] = (categoryDislikes[c] ?? 0) + 1;
    const seedTitle = f?.title || title.title;
    if (title.weight > 0 && seedTitle) {
      seeds.push({ tmdbId: title.tmdbId, mediaType: title.mediaType, title: seedTitle, weight: effective });
    }
    if (!f) continue;
    for (const k of f.keywordIds) add(keyword, k, effective * 0.8);
    for (const p of f.people) {
      add(people, p.id, effective * (p.role === 'director' ? 1.2 : 0.7));
      personNames[p.id] = p.name;
    }
    if (f.decade) add(decade, f.decade, effective * 0.5);
    if (f.language) add(language, f.language, effective);
  }

  // The browser's coarse genre counters (onboarding, likes) add a weak prior.
  const prior = options.genreWeights || {};
  const priorMax = Math.max(1e-9, ...Object.values(prior).filter((v) => v > 0));
  for (const [id, value] of Object.entries(prior)) {
    if (value > 0) for (const g of canonicalGenres([Number(id)])) add(genre, g, (0.5 * value) / priorMax);
  }

  const recentGenres = [...collapsed]
    .filter((t) => t.weight > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3)
    .flatMap((t) => features.get(t.key)?.genreIds ?? canonicalGenres(t.genreIds ?? []));

  const hasTaste = positiveCount > 0 || Object.values(genre).some((v) => v > 0);
  return {
    genre: normalize(genre),
    keyword: normalize(keyword),
    people: normalize(people),
    decade: normalize(decade),
    language: normalize(language),
    personNames,
    excluded,
    disliked,
    categoryDislikes,
    seeds: seeds.sort((a, b) => b.weight - a.weight).slice(0, 6),
    recentGenres: [...new Set(recentGenres)],
    positiveCount,
    stage: !hasTaste ? 'cold' : positiveCount <= 5 ? 'warming' : 'warm',
  };
}

export function topEntries<K extends string | number>(vector: Record<K, number>, n: number, minWeight = 0.05): Array<[K, number]> {
  return (Object.entries(vector) as Array<[K, number]>)
    .filter(([, w]) => w >= minWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
