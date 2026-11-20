import 'server-only';

import type { MediaType } from '@/types/media';
import {
  assessTitleQuality,
  signalsFromTmdbRow,
  titleIndexMinVotes,
  type RawTmdbQualityRow,
} from '@/lib/title-quality';
import { canonicalUrl } from '@/lib/seo-url';
import { genreLandings } from '@/lib/genres';
import { getOrSet } from '../cache';
import { Semaphore } from '../core/concurrency';
import { logger } from '../core/logger';
import { isTmdbConfigured, tmdbGet } from '../tmdb/gateway';
import { materialFingerprint, readShardLastmods, reconcileShardLastmods } from './lastmod-store';
import { SITEMAP_MAX_URLS } from './sitemap-xml';

/**
 * Sitemap index layout
 *
 *   /sitemap.xml                 sitemap index (referenced from robots.txt)
 *   /sitemap-static.xml          hub + catalogue landing pages
 *   /sitemap-movies-{n}.xml      indexable movie title pages
 *   /sitemap-series-{n}.xml      indexable series title pages
 *
 * Title shards are fixed release-date windows numbered oldest-first, so a
 * shard's number — and its URL — never changes; a new calendar year simply
 * appends a shard. Each shard lists every title in its window that passes the
 * shared indexing predicate (src/lib/title-quality.ts), i.e. exactly the
 * title pages that render `index, follow`.
 */

export type SitemapKind = 'movies' | 'series';

export const SITEMAP_KINDS: Record<SitemapKind, MediaType> = { movies: 'movie', series: 'tv' };

export function sitemapKindForType(type: MediaType): SitemapKind {
  return type === 'movie' ? 'movies' : 'series';
}

export interface ReleaseWindow {
  shard: number;
  /** Inclusive ISO bounds; `from` is absent for the open-ended first window. */
  from?: string;
  to: string;
}

const FIRST_YEARLY_SHARD_YEAR = 1990;
const FIXED_WINDOWS: ReadonlyArray<[number | undefined, number]> = [
  [undefined, 1929],
  [1930, 1939],
  [1940, 1949],
  [1950, 1959],
  [1960, 1969],
  [1970, 1974],
  [1975, 1979],
  [1980, 1984],
  [1985, 1989],
];

/**
 * Release windows in shard order. Earlier decades are sparse enough to share
 * a file; from 1990 there is one shard per year, which keeps every shard far
 * below TMDB's 500-page discover cap (10,000 rows) at the default vote floor.
 */
export function releaseWindows(now: Date = new Date()): ReleaseWindow[] {
  const windows: ReleaseWindow[] = FIXED_WINDOWS.map(([from, to], index) => ({
    shard: index + 1,
    ...(from ? { from: `${from}-01-01` } : {}),
    to: `${to}-12-31`,
  }));
  const currentYear = now.getUTCFullYear();
  for (let year = FIRST_YEARLY_SHARD_YEAR; year <= currentYear; year++) {
    windows.push({ shard: windows.length + 1, from: `${year}-01-01`, to: `${year}-12-31` });
  }
  return windows;
}

export function findReleaseWindow(shard: number, now: Date = new Date()): ReleaseWindow | undefined {
  return releaseWindows(now).find((w) => w.shard === shard);
}

/* ------------------------------------------------------------------------ */

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!process.env[name] || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

let lane: Semaphore | null = null;

/**
 * Sitemap scans share one small lane on top of the gateway's global limiter,
 * so a crawler fetching many shards at once cannot crowd out user traffic.
 */
function sitemapLane(): Semaphore {
  if (!lane) lane = new Semaphore(intEnv('SITEMAP_TMDB_CONCURRENCY', 3, 1, 16));
  return lane;
}

export function resetSitemapLaneForTests(): void {
  lane = null;
}

interface DiscoverPage {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: RawTmdbQualityRow[];
}

function discoverParams(type: MediaType, window: ReleaseWindow, now: Date, page: number) {
  const today = now.toISOString().slice(0, 10);
  const to = window.to < today ? window.to : today;
  const minVotes = titleIndexMinVotes();
  const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
  return {
    language: 'en-US', // same locale as the title page → same title → same slug
    include_adult: 'false',
    ...(type === 'movie' ? { include_video: 'false' } : { include_null_first_air_dates: 'false' }),
    // Release-date order is stable between page requests, unlike popularity.
    sort_by: `${dateField}.asc`,
    ...(window.from ? { [`${dateField}.gte`]: window.from } : {}),
    [`${dateField}.lte`]: to,
    ...(minVotes > 0 ? { 'vote_count.gte': minVotes } : {}),
    page,
  };
}

/* ------------------------------------------------------------------------ */

export interface ShardUrl {
  /** Canonical path, e.g. /title/movie/27205-inception */
  path: string;
  lastmod?: string;
}

export interface TitleShard {
  kind: SitemapKind;
  shard: number;
  urls: ShardUrl[];
  /** Discover rows scanned and rows rejected by the quality predicate. */
  scanned: number;
  rejected: number;
  lastmod?: string;
  generatedAt: string;
}

const SHARD_TTL = 6 * 60 * 60;
const SHARD_SWR = 24 * 60 * 60;

async function scanShard(kind: SitemapKind, window: ReleaseWindow, now: Date): Promise<TitleShard> {
  const type = SITEMAP_KINDS[kind];
  const run = sitemapLane();
  const fetchPage = (page: number) =>
    run.run(() =>
      tmdbGet<DiscoverPage>(`discover/${type}`, discoverParams(type, window, now, page), { cache: false })
    );

  const first = (await fetchPage(1)).data;
  const maxPages = intEnv('SITEMAP_MAX_PAGES_PER_SHARD', 500, 1, 500);
  const totalPages = Math.min(maxPages, Math.max(1, Number(first.total_pages || 1)));
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2).then((r) => r.data))
  );

  const accepted = new Map<number, { path: string; fingerprint: string }>();
  let scanned = 0;
  let rejected = 0;
  for (const page of [first, ...rest]) {
    for (const row of page.results || []) {
      scanned += 1;
      const quality = assessTitleQuality(signalsFromTmdbRow(row, type), { now });
      const id = Number(row.id);
      if (!quality.indexable || !quality.canonicalPath) {
        rejected += 1;
        continue;
      }
      if (!accepted.has(id)) {
        accepted.set(id, { path: quality.canonicalPath, fingerprint: materialFingerprint(row, type) });
      }
    }
  }

  const entries = Array.from(accepted.entries()).slice(0, SITEMAP_MAX_URLS);
  const { lastmods, shardLastmod } = await reconcileShardLastmods(
    type,
    String(window.shard),
    entries.map(([id, e]) => ({ id, fingerprint: e.fingerprint })),
    now
  );

  return {
    kind,
    shard: window.shard,
    urls: entries.map(([id, e]) => ({ path: e.path, ...(lastmods.has(id) ? { lastmod: lastmods.get(id) } : {}) })),
    scanned,
    rejected,
    ...(shardLastmod ? { lastmod: shardLastmod } : {}),
    generatedAt: now.toISOString(),
  };
}

/**
 * One title shard, cached per instance (6 h fresh, 24 h stale-while-
 * revalidate). Throws when the shard does not exist or TMDB cannot be read —
 * callers answer 404 / 503 rather than publishing an empty or partial list.
 */
export async function getTitleShard(kind: SitemapKind, shard: number, now: Date = new Date()): Promise<TitleShard> {
  const window = findReleaseWindow(shard, now);
  if (!window) throw new RangeError('Unknown sitemap shard');
  const key = `seo:sitemap:v1:${kind}:${shard}:${titleIndexMinVotes()}`;
  const { value } = await getOrSet(key, () => scanShard(kind, window, now), {
    ttl: SHARD_TTL,
    swr: SHARD_SWR,
    // Shards can be large; keep them out of Redis and let the CDN share them.
    shared: false,
  });
  return value;
}

/* ------------------------------------------------------------------------ */

export interface SitemapIndexShard {
  kind: SitemapKind;
  shard: number;
  lastmod?: string;
}

/**
 * Non-empty title shards for the index. One cheap page-1 probe per window
 * (served from the shared TMDB cache), so the index never advertises a
 * window with no candidate titles.
 */
async function probeShards(now: Date): Promise<Array<Omit<SitemapIndexShard, 'lastmod'>>> {
  const run = sitemapLane();
  const windows = releaseWindows(now);
  const probes = (Object.keys(SITEMAP_KINDS) as SitemapKind[]).flatMap((kind) =>
    windows.map((window) => ({ kind, window }))
  );
  const results = await Promise.all(
    probes.map(({ kind, window }) =>
      run
        .run(() => tmdbGet<DiscoverPage>(`discover/${SITEMAP_KINDS[kind]}`, discoverParams(SITEMAP_KINDS[kind], window, now, 1)))
        .then(({ data }) => ({ kind, shard: window.shard, count: Number(data.total_results || 0) }))
    )
  );
  return results.filter((r) => r.count > 0).map(({ kind, shard }) => ({ kind, shard }));
}

export async function listTitleShards(now: Date = new Date()): Promise<SitemapIndexShard[]> {
  if (!isTmdbConfigured()) return [];
  const { value: shards } = await getOrSet(
    `seo:sitemap-index:v1:${now.getUTCFullYear()}:${titleIndexMinVotes()}`,
    () => probeShards(now),
    { ttl: SHARD_TTL, swr: SHARD_SWR }
  );
  const lastmods = await readShardLastmods().catch((error) => {
    logger.warn('Could not read sitemap shard lastmods', { error });
    return new Map<string, string>();
  });
  return shards.map((s) => {
    const lastmod = lastmods.get(`${SITEMAP_KINDS[s.kind]}:${s.shard}`);
    return { ...s, ...(lastmod ? { lastmod } : {}) };
  });
}

/* ------------------------------------------------------------------------ */

const STATIC_PATHS = ['/', '/browse', '/movies', '/series', '/anime', '/documentaries', '/trending', '/privacy'] as const;

/**
 * Indexable non-title pages: hubs plus the semantic genre landings that the
 * listing SEO policy (catalogueSeo() in src/lib/catalogue-seo.ts) marks
 * indexable and self-canonical. Every loc is built with the
 * same canonicalUrl() helper the pages use, so sitemap and canonical match
 * byte for byte. No lastmod: these listings are live TMDB views with no
 * meaningful single modification time.
 */
export function staticSitemapUrls(origin: string): string[] {
  const urls: string[] = [];
  for (const path of STATIC_PATHS) {
    const url = canonicalUrl(origin, path);
    if (url) urls.push(url);
  }
  const landings: Array<[string, MediaType]> = [['/movies', 'movie'], ['/series', 'tv']];
  for (const [path, type] of landings) {
    for (const genre of genreLandings(type)) {
      const url = canonicalUrl(origin, path, `?genre=${encodeURIComponent(genre)}`);
      if (url) urls.push(url);
    }
  }
  return urls;
}

export function shardSitemapPath(kind: SitemapKind, shard: number): string {
  return `/sitemap-${kind}-${shard}.xml`;
}
