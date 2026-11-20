import { createHash } from 'node:crypto';
import type { MediaType } from '@/types/media';
import type { RawTmdbQualityRow } from '@/lib/title-quality';
import { isRedisConfigured, redisPipeline } from '../cache/redis';

/**
 * Honest <lastmod> values for title sitemaps.
 *
 * TMDB list payloads carry no modification timestamp, so AALAM derives one:
 * each title's *material* fields (the ones that change what its page says to
 * a searcher — title, synopsis, poster, release date, genres) are hashed into
 * a fingerprint, and the time a fingerprint change is first observed becomes
 * the title's lastmod. Volatile fields such as popularity, vote count and
 * rating are excluded on purpose: they change daily and would make every
 * lastmod meaningless.
 *
 * Rules:
 *  - First sighting records a baseline only. We do not know when the title
 *    last changed before we started watching, so no lastmod is claimed.
 *  - A later fingerprint change sets lastmod = observation time.
 *  - The state lives in Redis (Upstash) with no expiry. Without a durable
 *    store no lastmod is emitted at all — an in-memory store would "change"
 *    every title on each cold start, which is exactly the false signal that
 *    teaches search engines to ignore lastmod.
 *
 * The same mechanism tracks each shard's URL membership so the sitemap index
 * can carry a truthful per-file <lastmod>.
 */

const FINGERPRINT_VERSION = 'v1';
const TITLE_KEY = (type: MediaType) => `aalam:seo:${FINGERPRINT_VERSION}:title-fp:${type}`;
const SHARD_KEY = `aalam:seo:${FINGERPRINT_VERSION}:shard`;
const READ_CHUNK = 1000;
const WRITE_CHUNK = 500;

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 20);
}

/** Hash of the fields whose change materially alters a title page. */
export function materialFingerprint(row: RawTmdbQualityRow, type: MediaType): string {
  const genres = Array.isArray(row.genre_ids)
    ? [...row.genre_ids]
    : Array.isArray(row.genres)
      ? row.genres.map((g) => Number(g.id || 0))
      : [];
  return sha1(
    JSON.stringify([
      String(row.title || row.name || row.original_title || row.original_name || '').trim(),
      String(row.overview || '').replace(/\s+/g, ' ').trim(),
      row.poster_path || '',
      (type === 'movie' ? row.release_date : row.first_air_date) || '',
      genres.filter(Boolean).sort((a, b) => a - b),
    ])
  );
}

interface StoredState {
  hash: string;
  lastmod: string;
}

function parseState(raw: unknown): StoredState | null {
  if (typeof raw !== 'string') return null;
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  return { hash: raw.slice(0, sep), lastmod: raw.slice(sep + 1) };
}

function serialiseState(state: StoredState): string {
  return `${state.hash}|${state.lastmod}`;
}

async function hmget(key: string, fields: string[]): Promise<Array<unknown> | undefined> {
  const out: unknown[] = [];
  for (let i = 0; i < fields.length; i += READ_CHUNK) {
    const chunk = fields.slice(i, i + READ_CHUNK);
    const result = await redisPipeline([['HMGET', key, ...chunk]]);
    if (!result || !Array.isArray(result[0])) return undefined;
    out.push(...(result[0] as unknown[]));
  }
  return out;
}

async function hset(key: string, pairs: Array<[string, string]>): Promise<void> {
  for (let i = 0; i < pairs.length; i += WRITE_CHUNK) {
    const chunk = pairs.slice(i, i + WRITE_CHUNK);
    await redisPipeline([['HSET', key, ...chunk.flat()]]);
  }
}

export interface FingerprintedTitle {
  id: number;
  fingerprint: string;
}

export interface LastmodReconciliation {
  /** id → lastmod, only for titles with an observed material change. */
  lastmods: Map<number, string>;
  /** Latest of: any title lastmod in the shard, or a membership change. */
  shardLastmod?: string;
  /** False when no durable store is available (no lastmods are emitted). */
  durable: boolean;
}

/**
 * Compares a freshly built shard against the stored fingerprints, records
 * changes, and returns the lastmods to publish.
 */
export async function reconcileShardLastmods(
  type: MediaType,
  shardId: string,
  titles: readonly FingerprintedTitle[],
  now: Date = new Date()
): Promise<LastmodReconciliation> {
  const empty: LastmodReconciliation = { lastmods: new Map(), durable: false };
  if (!isRedisConfigured()) return empty;

  const nowIso = now.toISOString();
  const fields = titles.map((t) => String(t.id));
  const stored = fields.length ? await hmget(TITLE_KEY(type), fields) : [];
  if (!stored) return empty; // Redis unreachable: publish no lastmods this round.

  const lastmods = new Map<number, string>();
  const writes: Array<[string, string]> = [];
  titles.forEach((title, index) => {
    const previous = parseState(stored[index]);
    if (!previous) {
      writes.push([String(title.id), serialiseState({ hash: title.fingerprint, lastmod: '' })]);
      return;
    }
    if (previous.hash !== title.fingerprint) {
      writes.push([String(title.id), serialiseState({ hash: title.fingerprint, lastmod: nowIso })]);
      lastmods.set(title.id, nowIso);
      return;
    }
    if (previous.lastmod) lastmods.set(title.id, previous.lastmod);
  });
  if (writes.length) await hset(TITLE_KEY(type), writes);

  // Shard membership: adding or removing URLs modifies the sitemap file.
  const membership = sha1(fields.slice().sort().join(','));
  const shardField = `${type}:${shardId}`;
  const previousShard = parseState((await hmget(SHARD_KEY, [shardField]))?.[0]);
  let membershipLastmod = previousShard?.lastmod || '';
  if (previousShard && previousShard.hash !== membership) membershipLastmod = nowIso;

  let shardLastmod: string | undefined = membershipLastmod || undefined;
  for (const value of lastmods.values()) if (!shardLastmod || value > shardLastmod) shardLastmod = value;

  if (!previousShard || previousShard.hash !== membership || (shardLastmod ?? '') !== previousShard.lastmod) {
    await hset(SHARD_KEY, [[shardField, serialiseState({ hash: membership, lastmod: shardLastmod ?? '' })]]);
  }

  return { lastmods, shardLastmod, durable: true };
}

/** `${type}:${shardId}` → lastmod for every shard with a known modification. */
export async function readShardLastmods(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isRedisConfigured()) return out;
  const result = await redisPipeline([['HGETALL', SHARD_KEY]]);
  const flat = result?.[0];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const state = parseState(flat[i + 1]);
    if (state?.lastmod) out.set(String(flat[i]), state.lastmod);
  }
  return out;
}
