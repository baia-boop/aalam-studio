import type { EpisodeItem, SeasonSummary } from '@/types/media';

export interface EpisodePosition {
  season: number;
  episode: number;
}

function sortSeasons(seasons: readonly SeasonSummary[]): SeasonSummary[] {
  return [...seasons].sort((a, b) => a.seasonNumber - b.seasonNumber);
}

export function getNextEpisodePosition(
  { season, episode }: EpisodePosition,
  seasons: readonly SeasonSummary[],
  episodesInCurrentSeason: number
): EpisodePosition | null {
  const sorted = sortSeasons(seasons);
  const currentIdx = sorted.findIndex((s) => s.seasonNumber === season);

  if (!sorted.length || currentIdx === -1) {
    return episode < episodesInCurrentSeason
      ? { season, episode: episode + 1 }
      : null;
  }

  if (episode < episodesInCurrentSeason) {
    return { season, episode: episode + 1 };
  }

  const nextSeason = sorted[currentIdx + 1];
  return nextSeason
    ? { season: nextSeason.seasonNumber, episode: 1 }
    : null;
}

export function getPreviousEpisodePosition(
  { season, episode }: EpisodePosition,
  seasons: readonly SeasonSummary[]
): EpisodePosition | null {
  const sorted = sortSeasons(seasons);
  const currentIdx = sorted.findIndex((s) => s.seasonNumber === season);

  if (!sorted.length || currentIdx === -1) {
    return episode > 1 ? { season, episode: episode - 1 } : null;
  }

  if (episode > 1) {
    return { season, episode: episode - 1 };
  }

  const prevSeason = sorted[currentIdx - 1];
  if (!prevSeason) return null;
  return {
    season: prevSeason.seasonNumber,
    episode: Math.max(1, prevSeason.episodeCount || 1),
  };
}

/** Suppress an explicitly future episode even when the series is granted. */
export function isEpisodePublished(episode: Pick<EpisodeItem, 'airDate'>, today = new Date().toISOString().slice(0, 10)): boolean {
  return !episode.airDate || episode.airDate <= today;
}

const COORDINATE_MAX = { season: 200, episode: 2000 } as const;

export function parseWatchCoordinate(raw: string | null | undefined, kind: keyof typeof COORDINATE_MAX): number | null {
  if (raw == null) return 1;
  if (!/^[1-9]\d{0,3}$/.test(raw)) return null;
  const number = Number(raw);
  return number <= COORDINATE_MAX[kind] ? number : null;
}
