/**
 * Torrentio (Stremio addon) helpers shared by the server proxy and the client.
 *
 * Pure functions only: URL building, response parsing and ranking. Nothing in
 * here performs I/O, so it is safe to import from client components and easy
 * to unit test against recorded payloads.
 *
 * Torrentio stream shape (see TheBeastLT/torrentio-scraper, `stream_info.rs`):
 *   name:  "Torrentio\n1080p"            (keyless)
 *          "[RD+] Torrentio\n4k DV | HDR" (cached on Real-Debrid)
 *          "[RD download] Torrentio\n720p"
 *   title: "<torrent title>\n[<file title>\n]👤 12 💾 1.5 GB ⚙️ ThePirateBay[\n<flags>]"
 *   infoHash / fileIdx / sources / behaviorHints.filename on plain streams;
 *   debrid streams only carry `url` = …/resolve/realdebrid/<key>/<hash>/<entry>/<idx>/<file>.
 */

export type StreamMediaKind = 'movie' | 'tv';
export type DebridAvailability = 'cached' | 'download' | 'unknown';

export interface TorrentioStream {
  /** Stable key: `<infoHash>:<fileIdx|x>`. */
  id: string;
  infoHash: string;
  /** 0-based index of the file inside the torrent, when Torrentio knows it. */
  fileIdx: number | null;
  filename: string | null;
  releaseName: string;
  fileTitle: string | null;
  /** Torrentio's quality label, e.g. "4k", "1080p", "720p", "SCR". */
  quality: string;
  /** Vertical resolution used for filtering/ranking (0 when unknown). */
  resolution: number;
  /** HDR / Dolby Vision / 3D flags from the quality line. */
  flags: string[];
  sizeLabel: string | null;
  sizeBytes: number | null;
  seeders: number | null;
  provider: string | null;
  /** Language flags/labels exactly as Torrentio printed them. */
  languages: string | null;
  trackers: string[];
  availability: DebridAvailability;
  isCam: boolean;
  /** Best guess from the release name; browsers rarely decode HEVC/AC3/DTS. */
  codec: 'hevc' | 'avc' | 'av1' | null;
}

export interface TorrentioQuery {
  type: StreamMediaKind;
  imdbId: string;
  season?: number;
  episode?: number;
}

export const DEFAULT_TORRENTIO_BASE_URL = 'https://torrentio.strem.fun';
/** Excludes cam/screener rips by default; everything else is left to Torrentio. */
export const DEFAULT_TORRENTIO_OPTIONS = 'qualityfilter=scr,cam';
export const MAX_TORRENTIO_STREAMS = 80;

const IMDB_ID = /^tt\d{5,10}$/;
const INFO_HASH = /^[a-f0-9]{40}$/i;
/** Real-Debrid API tokens are 52 upper-case alphanumerics; leave headroom. */
const DEBRID_TOKEN = /^[A-Za-z0-9]{16,128}$/;
const OPTION_PAIR = /^[a-z]{2,20}=[A-Za-z0-9,._-]{1,200}$/;
const CREDENTIAL_KEYS = new Set([
  'realdebrid', 'premiumize', 'alldebrid', 'debridlink', 'easydebrid', 'offcloud', 'torbox', 'putio', 'highway',
]);
const CAM_QUALITIES = new Set(['cam', 'telesync', 'telecine', 'scr']);

export function isImdbId(value: unknown): value is string {
  return typeof value === 'string' && IMDB_ID.test(value);
}

export function isInfoHash(value: unknown): value is string {
  return typeof value === 'string' && INFO_HASH.test(value);
}

export function isDebridToken(value: unknown): value is string {
  return typeof value === 'string' && DEBRID_TOKEN.test(value);
}

/**
 * Validates `key=value|key=value` addon options. Credentials are rejected here;
 * the AALAM-owned service token is appended explicitly on the server only.
 */
export function sanitizeTorrentioOptions(raw: string | undefined | null): string {
  const pairs = (raw ?? '')
    .split('|')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .filter((pair) => OPTION_PAIR.test(pair))
    .filter((pair) => !CREDENTIAL_KEYS.has(pair.split('=')[0]));
  return Array.from(new Set(pairs)).join('|');
}

export function torrentioResourceId(query: TorrentioQuery): string {
  if (!isImdbId(query.imdbId)) throw new Error('A valid IMDb id (tt…) is required');
  if (query.type === 'movie') return query.imdbId;
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (!Number.isInteger(season) || season < 0 || season > 10000) throw new Error('Invalid season');
  if (!Number.isInteger(episode) || episode < 1 || episode > 10000) throw new Error('Invalid episode');
  return `${query.imdbId}:${season}:${episode}`;
}

export function buildTorrentioUrl(
  query: TorrentioQuery,
  {
    baseUrl = DEFAULT_TORRENTIO_BASE_URL,
    options = DEFAULT_TORRENTIO_OPTIONS,
    realDebridToken,
  }: { baseUrl?: string; options?: string; realDebridToken?: string | null } = {}
): string {
  const parts = sanitizeTorrentioOptions(options).split('|').filter(Boolean);
  if (realDebridToken) {
    if (!isDebridToken(realDebridToken)) throw new Error('Invalid Real-Debrid token');
    parts.push(`realdebrid=${realDebridToken}`);
  }
  const kind = query.type === 'movie' ? 'movie' : 'series';
  const config = parts.length ? `/${parts.join('|')}` : '';
  return `${baseUrl.replace(/\/+$/, '')}${config}/stream/${kind}/${encodeURIComponent(torrentioResourceId(query))}.json`;
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

export function parseSizeLabel(label: string | null | undefined): number | null {
  const match = /([\d.]+)\s*(b|kb|mb|gb|tb)\b/i.exec(label ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  const unit = SIZE_UNITS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : null;
}

export function resolutionFromQuality(quality: string, releaseName = ''): number {
  const q = quality.toLowerCase();
  if (q === '4k' || q === '2160p' || /\b(2160p|4k|uhd)\b/i.test(releaseName)) return 2160;
  const explicit = /(\d{3,4})p/.exec(q) || /\b(\d{3,4})p\b/i.exec(releaseName);
  if (explicit) return Number(explicit[1]);
  return 0;
}

export function codecFromName(name: string): TorrentioStream['codec'] {
  if (/\b(x265|h\.?265|hevc)\b/i.test(name)) return 'hevc';
  if (/\bav1\b/i.test(name)) return 'av1';
  if (/\b(x264|h\.?264|avc)\b/i.test(name)) return 'avc';
  return null;
}

interface RawStream {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  infoHash?: unknown;
  fileIdx?: unknown;
  url?: unknown;
  sources?: unknown;
  behaviorHints?: { filename?: unknown } | null;
}

const RESOLVE_URL = /\/resolve\/realdebrid\/[^/]+\/([a-fA-F0-9]{40})\/[^/]+\/(\d+|undefined|null)(?:\/|$)/;
const STATS_LINE = /👤|💾|⚙/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseOne(raw: RawStream, keyed: boolean): TorrentioStream | null {
  const name = text(raw.name);
  const description = text(raw.title) || text(raw.description);
  let infoHash = text(raw.infoHash).toLowerCase();
  let fileIdx: number | null =
    typeof raw.fileIdx === 'number' && Number.isInteger(raw.fileIdx) && raw.fileIdx >= 0 ? raw.fileIdx : null;

  const resolved = RESOLVE_URL.exec(text(raw.url));
  if (!infoHash && resolved) {
    infoHash = resolved[1].toLowerCase();
    fileIdx = /^\d+$/.test(resolved[2]) ? Number(resolved[2]) : null;
  }
  if (!isInfoHash(infoHash)) return null; // error/info streams carry no hash

  const [nameHead = '', qualityLine = ''] = name.split('\n');
  const availability: DebridAvailability = /\[RD\+\]/.test(nameHead)
    ? 'cached'
    : keyed
      ? 'download'
      : 'unknown';
  const [quality = '', ...flags] = qualityLine.trim().split(/\s+(?:\|\s+)?/).filter(Boolean);

  const lines = description.split('\n').map((line) => line.trim()).filter(Boolean);
  const statsIndex = lines.findIndex((line) => STATS_LINE.test(line));
  const head = statsIndex >= 0 ? lines.slice(0, statsIndex) : lines.slice(0, 2);
  const stats = statsIndex >= 0 ? lines[statsIndex] : '';
  const languages = statsIndex >= 0 ? lines.slice(statsIndex + 1).join(' ') || null : null;
  const releaseName = head[0] || text(raw.behaviorHints?.filename) || 'Unnamed release';
  const fileTitle = head[1] || null;

  const seedersMatch = /👤\s*(\d+)/.exec(stats);
  const sizeMatch = /💾\s*([\d.]+\s*[kMGT]?B)/i.exec(stats);
  const providerMatch = /⚙\uFE0F?\s*(.+)$/.exec(stats);
  const filename = text(raw.behaviorHints?.filename) || null;
  const trackers = Array.isArray(raw.sources)
    ? raw.sources
        .filter((source): source is string => typeof source === 'string' && source.startsWith('tracker:'))
        .map((source) => source.slice('tracker:'.length))
        .filter((tracker) => /^(udp|https?|wss?):\/\//i.test(tracker))
        .slice(0, 30)
    : [];

  return {
    id: `${infoHash}:${fileIdx ?? 'x'}`,
    infoHash,
    fileIdx,
    filename,
    releaseName,
    fileTitle,
    quality: quality || 'Unknown',
    resolution: resolutionFromQuality(quality, releaseName),
    flags,
    sizeLabel: sizeMatch ? sizeMatch[1].replace(/\s+/, ' ') : null,
    sizeBytes: sizeMatch ? parseSizeLabel(sizeMatch[1]) : null,
    seeders: seedersMatch ? Number(seedersMatch[1]) : null,
    provider: providerMatch ? providerMatch[1].trim() : null,
    languages,
    trackers,
    availability,
    isCam: CAM_QUALITIES.has(quality.toLowerCase()),
    codec: codecFromName(`${releaseName} ${fileTitle ?? ''}`),
  };
}

const AVAILABILITY_RANK: Record<DebridAvailability, number> = { cached: 0, unknown: 1, download: 1 };

/**
 * Normalises a Torrentio `/stream` payload. `keyed` = the request carried a
 * debrid key, so unmarked streams are known to need a Real-Debrid download.
 * Duplicates (plain + "[RD download]" copies) are merged, the best
 * availability wins, Torrentio's quality ordering is otherwise preserved and
 * instantly playable streams are moved to the front.
 */
export function parseTorrentioStreams(payload: unknown, { keyed = false } = {}): TorrentioStream[] {
  const streams = (payload as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) return [];
  const merged = new Map<string, { stream: TorrentioStream; order: number }>();
  streams.forEach((raw, order) => {
    if (!raw || typeof raw !== 'object') return;
    const parsed = parseOne(raw as RawStream, keyed);
    if (!parsed) return;
    const existing = merged.get(parsed.id);
    if (!existing) {
      merged.set(parsed.id, { stream: parsed, order });
      return;
    }
    const better = AVAILABILITY_RANK[parsed.availability] < AVAILABILITY_RANK[existing.stream.availability];
    const base = better ? parsed : existing.stream;
    const other = better ? existing.stream : parsed;
    merged.set(parsed.id, {
      order: Math.min(order, existing.order),
      stream: {
        ...base,
        filename: base.filename ?? other.filename,
        fileTitle: base.fileTitle ?? other.fileTitle,
        trackers: base.trackers.length ? base.trackers : other.trackers,
      },
    });
  });
  return Array.from(merged.values())
    .sort((a, b) => AVAILABILITY_RANK[a.stream.availability] - AVAILABILITY_RANK[b.stream.availability] || a.order - b.order)
    .slice(0, MAX_TORRENTIO_STREAMS)
    .map(({ stream }) => stream);
}

export type ResolutionBucket = 'all' | '2160' | '1080' | '720' | 'sd';

export function matchesResolutionBucket(stream: TorrentioStream, bucket: ResolutionBucket): boolean {
  switch (bucket) {
    case 'all':
      return true;
    case '2160':
      return stream.resolution >= 2160;
    case '1080':
      return stream.resolution >= 1080 && stream.resolution < 2160;
    case '720':
      return stream.resolution >= 720 && stream.resolution < 1080;
    case 'sd':
      return stream.resolution < 720;
  }
}

/** A magnet link with the torrent name and the trackers Torrentio listed. */
export function buildMagnet(infoHash: string, name?: string | null, trackers: string[] = []): string {
  if (!isInfoHash(infoHash)) throw new Error('Invalid info hash');
  const parts = [`xt=urn:btih:${infoHash.toLowerCase()}`];
  if (name) parts.push(`dn=${encodeURIComponent(name).replace(/%20/g, '+')}`);
  for (const tracker of trackers.slice(0, 30)) parts.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${parts.join('&')}`;
}
