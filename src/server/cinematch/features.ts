import type { MediaType } from '@/types/media';
import { getOrSet } from '../cache';
import { tmdbGet } from '../tmdb/gateway';
import { canonicalGenres } from './catalog';
import type { TitleFeatures } from './types';

interface DetailResponse {
  id?: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  original_language?: string;
  genres?: Array<{ id?: number }>;
  keywords?: { keywords?: Array<{ id?: number }>; results?: Array<{ id?: number }> };
  credits?: {
    cast?: Array<{ id?: number; name?: string }>;
    crew?: Array<{ id?: number; name?: string; job?: string }>;
  };
  created_by?: Array<{ id?: number; name?: string }>;
}

export function featuresFromDetail(mediaType: MediaType, data: DetailResponse): TitleFeatures | null {
  if (!data?.id) return null;
  const year = Number((data.release_date || data.first_air_date || '').slice(0, 4));
  const keywordList = data.keywords?.keywords || data.keywords?.results || [];
  const people: TitleFeatures['people'] = [];
  for (const member of (data.credits?.cast || []).slice(0, 5)) {
    if (member.id && member.name) people.push({ id: member.id, name: member.name, role: 'cast' });
  }
  const directors = [
    ...(data.credits?.crew || []).filter((c) => c.job === 'Director'),
    ...(data.created_by || []),
  ];
  for (const director of directors.slice(0, 2)) {
    if (director.id && director.name && !people.some((p) => p.id === director.id)) {
      people.push({ id: director.id, name: director.name, role: 'director' });
    }
  }
  return {
    tmdbId: data.id,
    mediaType,
    title: data.title || data.name || '',
    genreIds: canonicalGenres((data.genres || []).map((g) => g.id).filter((id): id is number => Number.isInteger(id))),
    keywordIds: keywordList.map((k) => k.id).filter((id): id is number => Number.isInteger(id)).slice(0, 20),
    people,
    language: data.original_language || '',
    decade: year > 1900 ? Math.floor(year / 10) * 10 : null,
  };
}

/** Compact, long-lived title features (genres, keywords, people, language, decade). */
export async function getTitleFeatures(mediaType: MediaType, tmdbId: number): Promise<TitleFeatures | null> {
  const { value } = await getOrSet<TitleFeatures | null>(
    `cm:feat:v1:${mediaType}:${tmdbId}`,
    async () => {
      const { data } = await tmdbGet<DetailResponse>(`${mediaType}/${tmdbId}`, {
        append_to_response: 'keywords,credits',
        language: 'en-US',
      });
      return featuresFromDetail(mediaType, data);
    },
    { ttl: 24 * 60 * 60, swr: 7 * 24 * 60 * 60, cacheIf: (v) => v !== null }
  );
  return value;
}
