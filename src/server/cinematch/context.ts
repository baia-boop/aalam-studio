import type { MediaType } from '@/types/media';
import { badRequest } from '../core/errors';
import { finiteNumber, isRecord, parseItemKey } from '../core/validate';
import type { TitleSignal } from './types';

/**
 * The browser keeps AALAM's taste state locally (guests) or in the cloud
 * library (accounts). It can send that state with a recommendation request so
 * guests receive the same server-side engine. The payload is used only to
 * compute the response: it is not stored or logged.
 */

export interface TasteContext {
  signals: TitleSignal[];
  genreWeights: Record<number, number>;
  limit?: number;
}

const LIMITS = { seeds: 30, liked: 200, disliked: 300, watchlist: 200, watched: 60, genreWeights: 40 };

function list(value: unknown, name: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest(`${name} must be an array`);
  if (value.length > max) throw badRequest(`${name} may contain at most ${max} items`);
  return value;
}

function cleanTitle(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, 160) || undefined : undefined;
}

function cleanGenres(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((g): g is number => Number.isInteger(g) && g > 0 && g < 100000).slice(0, 10);
}

function idAndType(raw: Record<string, unknown>): { tmdbId: number; mediaType: MediaType } | null {
  const tmdbId = Number(raw.tmdbId);
  const mediaType = raw.mediaType ?? raw.type;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || tmdbId > 100_000_000) return null;
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;
  return { tmdbId, mediaType };
}

export function parseTasteContext(body: unknown, now = Date.now()): TasteContext {
  if (body === undefined || body === null) return { signals: [], genreWeights: {} };
  if (!isRecord(body)) throw badRequest('Body must be a JSON object');
  const signals: TitleSignal[] = [];

  for (const raw of list(body.seeds, 'seeds', LIMITS.seeds)) {
    if (!isRecord(raw)) continue;
    const id = idAndType(raw);
    if (id) signals.push({ ...id, kind: 'onboarding', at: now, title: cleanTitle(raw.title), genreIds: cleanGenres(raw.genreIds) });
  }
  for (const [field, kind, max] of [
    ['liked', 'like', LIMITS.liked],
    ['disliked', 'dislike', LIMITS.disliked],
    ['watchlist', 'watchlist', LIMITS.watchlist],
  ] as const) {
    for (const key of list(body[field], field, max)) {
      const parsed = parseItemKey(key);
      if (parsed) signals.push({ ...parsed, kind, at: now });
    }
  }
  for (const raw of list(body.watched, 'watched', LIMITS.watched)) {
    if (!isRecord(raw)) continue;
    const id = idAndType(raw);
    if (!id) continue;
    const updatedAt = finiteNumber(raw.updatedAt, now - 2 * 365 * 86_400_000, now + 60_000);
    const progress = finiteNumber(raw.progress, 0, 1);
    signals.push({
      ...id,
      kind: 'watch',
      at: updatedAt ?? now,
      ...(progress !== undefined ? { progress } : {}),
      title: cleanTitle(raw.title),
      genreIds: cleanGenres(raw.genreIds),
    });
  }

  const genreWeights: Record<number, number> = {};
  if (body.genreWeights !== undefined) {
    if (!isRecord(body.genreWeights)) throw badRequest('genreWeights must be an object');
    const entries = Object.entries(body.genreWeights);
    if (entries.length > LIMITS.genreWeights) throw badRequest('genreWeights has too many entries');
    for (const [id, value] of entries) {
      const genreId = Number(id);
      const weight = finiteNumber(value, -1000, 1000);
      if (Number.isInteger(genreId) && genreId > 0 && weight !== undefined && weight > 0) genreWeights[genreId] = weight;
    }
  }

  const limit = body.limit === undefined ? undefined : finiteNumber(body.limit, 10, 60);
  if (body.limit !== undefined && limit === undefined) throw badRequest('limit must be between 10 and 60');
  return { signals, genreWeights, ...(limit !== undefined ? { limit: Math.round(limit) } : {}) };
}
