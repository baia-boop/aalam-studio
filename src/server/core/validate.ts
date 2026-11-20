import { badRequest } from './errors';
import type { MediaType } from '@/types/media';

/**
 * `?a=1&a=2` or structured values must never reach places that expect a
 * single scalar. Returns the first non-empty string, or undefined.
 */
export function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0] || undefined;
  return undefined;
}

export function parseIntParam(
  raw: string | null | undefined,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback?: number }
): number {
  if (raw === null || raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${name} is required`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function parseMediaType(raw: unknown, name = 'type'): MediaType {
  if (raw === 'movie' || raw === 'tv') return raw;
  throw badRequest(`${name} must be "movie" or "tv"`);
}

export function parseTmdbId(raw: unknown, name = 'id'): number {
  const value = typeof raw === 'string' ? Number(/^\d+/.exec(raw)?.[0]) : Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 100_000_000) {
    throw badRequest(`${name} must be a positive TMDB id`);
  }
  return value;
}

export function parseEnum<T extends string>(raw: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  if ((raw === undefined || raw === null || raw === '') && fallback !== undefined) return fallback;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function finiteNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** `movie:550` → { mediaType, tmdbId }; non-numeric (sample catalogue) keys are ignored. */
export function parseItemKey(key: unknown): { mediaType: MediaType; tmdbId: number } | null {
  if (typeof key !== 'string' || key.length > 40) return null;
  const match = /^(movie|tv):(\d{1,9})$/.exec(key);
  if (!match) return null;
  const tmdbId = Number(match[2]);
  return tmdbId > 0 ? { mediaType: match[1] as MediaType, tmdbId } : null;
}
