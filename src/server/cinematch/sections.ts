import { isRecommendationEligible } from '@/lib/content-eligibility';
import type { MediaItem } from '@/types/media';
import { normalizeTmdbItem } from '@/lib/tmdb';
import { GENRE_NAMES } from './catalog';
import { topEntries } from './profile';
import type { RecommendationSection, ScoredCandidate, SourceName, UserProfile } from './types';

const MIN_SECTION = 5;
const MAX_SECTION = 20;
const MAX_SECTIONS = 6;

export function toMediaItem(c: ScoredCandidate): MediaItem | null {
  // Passing the raw TMDB record through the app's own normaliser keeps image
  // URLs, genre labels and certification logic identical to every other rail.
  const item = normalizeTmdbItem(c.raw as Parameters<typeof normalizeTmdbItem>[0], c.mediaType);
  if (!item || !isRecommendationEligible(item)) return null;
  return {
    ...item,
    ...(c.matchPct !== undefined ? { matchPct: c.matchPct } : {}),
    recommendationReason: c.reason,
  };
}

function section(id: string, title: string, source: SourceName, items: ScoredCandidate[], reasonOverride?: (c: ScoredCandidate) => string): RecommendationSection | null {
  const unique = new Map<string, ScoredCandidate>();
  for (const c of items) if (!unique.has(c.key)) unique.set(c.key, c);
  const media = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SECTION)
    .map((c) => toMediaItem(reasonOverride ? { ...c, reason: reasonOverride(c) } : c))
    .filter((m): m is MediaItem => m !== null);
  return media.length >= MIN_SECTION ? { id, title, source, items: media } : null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

/** Themed rails ("Because you liked X", "More Thrillers", "Hidden gems"…). */
export function buildSections(pool: ScoredCandidate[], profile: UserProfile): RecommendationSection[] {
  const out: Array<RecommendationSection | null> = [];

  if (profile.stage === 'cold') {
    out.push(section('trending', 'Trending this week', 'trending', pool.filter((c) => c.sources.includes('trending'))));
    out.push(section('acclaimed', 'Top rated', 'acclaimed', pool.filter((c) => c.sources.includes('acclaimed'))));
    return out.filter((s): s is RecommendationSection => s !== null);
  }

  for (const seed of profile.seeds.slice(0, 3)) {
    const items = pool.filter((c) => c.seeds.recommendations === seed.title || c.seeds.similar === seed.title);
    out.push(section(`because-${seed.mediaType}-${seed.tmdbId}`, `Because you liked ${seed.title}`, 'recommendations', items, () => `Because you liked ${seed.title}`));
  }

  const [topGenre] = topEntries(profile.genre, 1, 0.4);
  if (topGenre) {
    const genreId = Number(topGenre[0]);
    const name = GENRE_NAMES[genreId];
    if (name) out.push(section(`genre-${genreId}`, `More ${name} for you`, 'genre', pool.filter((c) => c.genreIds.includes(genreId))));
  }

  const people = new Map<string, ScoredCandidate[]>();
  for (const c of pool) {
    const person = c.seeds.people;
    if (person) people.set(person, [...(people.get(person) || []), c]);
  }
  const [bestPerson] = [...people.entries()].sort((a, b) => b[1].length - a[1].length);
  if (bestPerson) out.push(section(`people-${slug(bestPerson[0])}`, `From ${bestPerson[0]}`, 'people', bestPerson[1]));

  const language = pool.filter((c) => c.sources.includes('language'));
  const label = language[0]?.seeds.language;
  if (label) out.push(section(`language-${slug(label)}`, `${label} picks for you`, 'language', language));

  out.push(section('collaborative', 'Similar viewing patterns', 'collaborative', pool.filter((c) => c.sources.includes('collaborative'))));
  out.push(section('hidden-gems', 'Less widely known picks', 'genre', pool.filter((c) => c.breakdown.quality > 0.62 && c.breakdown.popularity < 0.45 && c.breakdown.genre > 0), () => 'Highly rated with lower popularity'));
  out.push(section('trending-for-you', 'Trending, picked for you', 'trending', pool.filter((c) => c.sources.includes('trending') && c.breakdown.genre > 0.1)));

  return out.filter((s): s is RecommendationSection => s !== null).slice(0, MAX_SECTIONS);
}
