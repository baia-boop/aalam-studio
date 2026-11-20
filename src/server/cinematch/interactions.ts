import type { SupabaseClient } from '@supabase/supabase-js';
import type { MediaType } from '@/types/media';
import { badRequest, tooManyRequests, unavailable } from '../core/errors';
import { finiteNumber, isRecord } from '../core/validate';
import { logger } from '../core/logger';
import { watchWeight } from './profile';
import type { CollaborativeRow } from './sources';
import type { SignalKind, TitleSignal } from './types';

/**
 * Interaction telemetry: validated, weighted, persisted under RLS.
 *
 * Events are written with the caller's own JWT, so Postgres policies (not
 * this code) guarantee a user can only ever write or read their own history.
 */

export const EVENT_TYPES = ['view', 'watch', 'like', 'dislike', 'clear', 'watchlist', 'onboarding'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface InteractionEvent {
  tmdbId: number;
  mediaType: MediaType;
  type: EventType;
  progress?: number;
  /** 0-based slot where the title was shown (for position-bias analysis). */
  position?: number;
  /** Rail/source that displayed it, e.g. `cinematch:recommendations`. */
  source?: string;
}

export const MAX_BATCH = 50;
const SOURCE_RE = /^[a-z0-9:_-]{1,48}$/;

export function eventWeight(type: EventType, progress?: number): number {
  switch (type) {
    case 'watch':
      return watchWeight(progress);
    case 'like':
    case 'onboarding':
      return 0.9;
    case 'watchlist':
      return 0.6;
    case 'view':
      return 0.12;
    case 'dislike':
      return -1;
    case 'clear':
      return 0;
  }
}

export function parseInteractionBatch(body: unknown): InteractionEvent[] {
  const events = isRecord(body) ? body.events : undefined;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH) {
    throw badRequest(`events must be an array of 1–${MAX_BATCH} items`);
  }
  return events.map((raw, index) => {
    if (!isRecord(raw)) throw badRequest(`events[${index}] must be an object`);
    const tmdbId = Number(raw.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0 || tmdbId > 100_000_000) throw badRequest(`events[${index}].tmdbId is invalid`);
    if (raw.mediaType !== 'movie' && raw.mediaType !== 'tv') throw badRequest(`events[${index}].mediaType must be movie or tv`);
    if (typeof raw.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(raw.type)) {
      throw badRequest(`events[${index}].type must be one of: ${EVENT_TYPES.join(', ')}`);
    }
    const progress = raw.progress === undefined ? undefined : finiteNumber(raw.progress, 0, 1);
    if (raw.progress !== undefined && progress === undefined) throw badRequest(`events[${index}].progress must be between 0 and 1`);
    const position = raw.position === undefined ? undefined : finiteNumber(raw.position, 0, 500);
    const source = typeof raw.source === 'string' && SOURCE_RE.test(raw.source) ? raw.source : undefined;
    return {
      tmdbId,
      mediaType: raw.mediaType,
      type: raw.type as EventType,
      ...(progress !== undefined ? { progress: Math.round(progress * 1000) / 1000 } : {}),
      ...(position !== undefined ? { position: Math.round(position) } : {}),
      ...(source ? { source } : {}),
    };
  });
}

function dbError(error: { message?: string; code?: string }, action: string): never {
  // 42P01: table missing → migration not applied yet.
  if (error.code === '42P01' || /relation .* does not exist/i.test(error.message || '')) {
    throw unavailable('MIGRATION_REQUIRED', 'Apply supabase/migrations/202611140001_cinematch_backend.sql to enable this feature.');
  }
  // P0429: per-account write budget enforced by the database trigger.
  if (error.code === 'P0429' || /too many events/i.test(error.message || '')) throw tooManyRequests(60);
  logger.error('Interaction storage failed', { action, code: error.code, error: error.message });
  throw unavailable('STORAGE_UNAVAILABLE', 'Could not save activity right now.');
}

export async function recordInteractions(client: SupabaseClient, userId: string, events: InteractionEvent[]): Promise<number> {
  const rows = events.map((e) => ({
    user_id: userId,
    tmdb_id: e.tmdbId,
    media_type: e.mediaType,
    event_type: e.type,
    weight: eventWeight(e.type, e.progress),
    progress: e.progress ?? null,
    position: e.position ?? null,
    source: e.source ?? null,
  }));
  const { error } = await client.from('user_interactions').insert(rows).abortSignal(AbortSignal.timeout(8000));
  if (error) dbError(error, 'insert');
  return rows.length;
}

interface InteractionRow {
  tmdb_id: number;
  media_type: MediaType;
  event_type: SignalKind;
  progress: number | null;
  created_at: string;
}

/** Most recent 400 events within 365 days, as engine signals. */
export async function loadUserSignals(client: SupabaseClient, userId: string): Promise<TitleSignal[]> {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const { data, error } = await client
    .from('user_interactions')
    .select('tmdb_id, media_type, event_type, progress, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(400)
    .abortSignal(AbortSignal.timeout(8000));
  if (error) dbError(error, 'select');
  return ((data || []) as InteractionRow[]).map((row) => ({
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    kind: row.event_type,
    at: Date.parse(row.created_at),
    ...(row.progress !== null ? { progress: row.progress } : {}),
  }));
}

export async function countUserInteractions(client: SupabaseClient, userId: string): Promise<{ total: number; lastAt: string | null }> {
  const { data, count, error } = await client
    .from('user_interactions')
    .select('created_at', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .abortSignal(AbortSignal.timeout(8000));
  if (error) dbError(error, 'count');
  return { total: count ?? 0, lastAt: (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null };
}

export async function deleteUserHistory(client: SupabaseClient, userId: string): Promise<void> {
  const { error } = await client.from('user_interactions').delete().eq('user_id', userId).abortSignal(AbortSignal.timeout(10000));
  if (error) dbError(error, 'delete');
}

/**
 * Item-to-item collaborative candidates computed in Postgres. The function
 * returns only titles liked by several distinct peers and never exposes who
 * they are (see the migration). Failures yield [] — it is an optional source.
 */
export async function loadCollaborative(client: SupabaseClient): Promise<CollaborativeRow[]> {
  const { data, error } = await client.rpc('cinematch_collaborative', { p_limit: 40 }).abortSignal(AbortSignal.timeout(2500));
  if (error || !Array.isArray(data)) return [];
  return (data as Array<{ tmdb_id: number; media_type: MediaType; score: number }>)
    .filter((row) => Number.isInteger(row.tmdb_id) && (row.media_type === 'movie' || row.media_type === 'tv'))
    .map((row) => ({ tmdbId: row.tmdb_id, mediaType: row.media_type, score: Number(row.score) || 0 }));
}
