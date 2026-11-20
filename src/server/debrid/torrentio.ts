import { getConfig } from '../core/config';
import { ApiError } from '../core/errors';
import { logger } from '../core/logger';
import { cacheSet, getOrSet, type CacheStatus } from '../cache';
import {
  buildTorrentioUrl,
  parseTorrentioStreams,
  torrentioResourceId,
  type TorrentioQuery,
  type TorrentioStream,
} from '@/lib/torrentio';

/**
 * Server-side Torrentio client.
 *
 *  - The request URL can contain AALAM's server-side Real-Debrid token; it is
 *    never logged or returned, and resolve URLs are stripped during parsing.
 *  - Torrentio's "[RD+]" markers come from its global availability cache;
 *    keyed results are cached per title (without the token) and shared by all
 *    AALAM Premium members.
 *  - Empty results are cached briefly so a missing title is not re-fetched on
 *    every page view, but not long enough to hide newly indexed releases.
 */

export interface TorrentioResult {
  streams: TorrentioStream[];
  /** True when availability markers are known (a debrid key was used). */
  debridMarkers: boolean;
  fetchedAt: string;
}

const FRESH_SECONDS = 15 * 60;
const STALE_SECONDS = 60 * 60;
const EMPTY_SECONDS = 2 * 60;

async function fetchTorrentio(query: TorrentioQuery, token: string | null): Promise<TorrentioResult> {
  const { torrentioBaseUrl, torrentioOptions, torrentioTimeoutMs } = getConfig().debrid;
  const url = buildTorrentioUrl(query, {
    baseUrl: torrentioBaseUrl,
    options: torrentioOptions,
    realDebridToken: token,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), torrentioTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'AALAM/1.0 (+stream discovery)' },
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = (error as Error)?.name === 'AbortError';
    logger.warn('Torrentio request failed', { timedOut, resource: torrentioResourceId(query) });
    throw timedOut
      ? new ApiError(504, 'TORRENTIO_TIMEOUT', 'Torrentio did not respond in time. Please retry.')
      : new ApiError(502, 'TORRENTIO_UNREACHABLE', 'Torrentio could not be reached from this server.');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new ApiError(503, 'TORRENTIO_BUSY', 'Torrentio is rate limiting requests. Please retry shortly.', {
      headers: { 'Retry-After': '30' },
    });
  }
  if (!response.ok) {
    logger.warn('Torrentio returned an error', { status: response.status, resource: torrentioResourceId(query) });
    throw new ApiError(502, 'TORRENTIO_ERROR', 'Torrentio returned an unexpected response.');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, 'TORRENTIO_ERROR', 'Torrentio returned an unreadable response.');
  }
  return {
    streams: parseTorrentioStreams(payload, { keyed: Boolean(token) }),
    debridMarkers: Boolean(token),
    fetchedAt: new Date().toISOString(),
  };
}

export function torrentioCacheKey(query: TorrentioQuery, keyed: boolean): string {
  return `torrentio:v1:${keyed ? 'rd' : 'plain'}:${query.type}:${torrentioResourceId(query)}`;
}

export async function getTorrentioStreams(
  query: TorrentioQuery,
  { realDebridToken = null }: { realDebridToken?: string | null } = {}
): Promise<{ value: TorrentioResult; status: CacheStatus }> {
  const keyed = Boolean(realDebridToken);
  const key = torrentioCacheKey(query, keyed);
  const result = await getOrSet(key, () => fetchTorrentio(query, realDebridToken), {
    ttl: FRESH_SECONDS,
    swr: STALE_SECONDS,
    cacheIf: (value) => (value as TorrentioResult).streams.length > 0,
  });
  if (!result.value.streams.length && result.status === 'MISS') {
    // Short negative cache so repeated views of an unindexed title stay cheap.
    cacheSet(key, result.value, { ttl: EMPTY_SECONDS, shared: false });
  }
  return result;
}
