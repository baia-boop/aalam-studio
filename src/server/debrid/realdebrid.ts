import { isIP } from 'node:net';
import { getConfig } from '../core/config';
import { ApiError } from '../core/errors';
import { logger } from '../core/logger';
import { sleep } from '../core/concurrency';
import { buildMagnet, isInfoHash } from '@/lib/torrentio';

/**
 * Minimal Real-Debrid REST client (https://api.real-debrid.com).
 *
 * Real-Debrid does not send CORS headers for browser apps, so AALAM relays a
 * small, fixed set of calls. The user's token arrives per request, is used
 * only for the upstream call and is never stored, cached or logged. Every
 * call is bounded by a timeout; torrent preparation is a short server-side
 * flow (find or add magnet → select the episode/movie file → unrestrict) and
 * the browser polls again while Real-Debrid downloads uncached torrents.
 */

export const REALDEBRID_API = 'https://api.real-debrid.com/rest/1.0';

const VIDEO_EXTENSIONS = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mts|wmv|mpg|mpeg|flv|ogm|divx|3gp)$/i;
const ARCHIVE_EXTENSIONS = /\.(rar|zip|7z|tar|gz|iso)$/i;
const SAMPLE = /(^|[\W_])(sample|trailer|featurette|extras?)([\W_]|$)/i;
const READY = new Set(['downloaded', 'dead']);
const DOWNLOADING = new Set(['downloading', 'queued', 'uploading', 'compressing']);
const FAILED = new Set(['error', 'magnet_error', 'virus']);
const TORRENT_ID = /^[A-Za-z0-9]{6,32}$/;
const OPEN_POLLS = 8;
const OPEN_POLL_MS = 1000;
const FIND_LIMIT = 50;

export interface RealDebridFile {
  id: number;
  path: string;
  bytes: number;
  selected: number | boolean;
}

export interface RealDebridTorrent {
  id: string;
  filename: string;
  hash: string;
  bytes?: number;
  status: string;
  progress?: number;
  speed?: number;
  seeders?: number;
  files?: RealDebridFile[];
  links?: string[];
}

interface Unrestricted {
  id: string;
  filename: string;
  mimeType?: string;
  filesize?: number;
  download: string;
  streamable?: number;
}

export interface RealDebridAccount {
  username: string;
  premium: boolean;
  /** ISO timestamp the premium subscription ends (absent for free accounts). */
  expiration: string | null;
  premiumDaysLeft: number;
  points: number;
}

export interface ResolveRequest {
  infoHash: string;
  fileIdx?: number | null;
  filename?: string | null;
  releaseName?: string | null;
  trackers?: string[];
  season?: number;
  episode?: number;
  /** Re-check a torrent added by an earlier resolve call. */
  torrentId?: string | null;
}

/** RD's own transcodes: browser-safe H.264/AAC MP4, HLS (Safari) and WebM. */
export type TranscodeLinks = { mp4?: string; hls?: string; webm?: string } | null;

export type ResolveResult =
  | {
      status: 'ready';
      torrentId: string;
      file: { name: string; bytes: number };
      stream: { url: string; filename: string; mimeType: string | null; filesize: number | null; streamable: boolean };
      transcode: TranscodeLinks;
    }
  | {
      status: 'downloading';
      torrentId: string;
      progress: number;
      speedBytes: number | null;
      seeders: number | null;
      phase: string;
    }
  | { status: 'failed'; torrentId: string | null; reason: 'magnet_error' | 'no_video' | 'archive' | 'error'; message: string };

export class RealDebridApiError extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string) {
    super(message);
    this.name = 'RealDebridApiError';
  }
}

/** RD error codes → stable, user-safe API errors (codes from RD's API docs). */
export function toApiError(error: RealDebridApiError): ApiError {
  const code = error.code;
  if (error.status === 401 || code === 8) {
    return new ApiError(503, 'DEBRID_SERVICE_AUTH_FAILED', 'AALAM Premium could not authenticate with Real-Debrid. Please contact support.');
  }
  if (code === 9 || code === 20 || code === 14 || code === 15) {
    return new ApiError(403, 'DEBRID_FORBIDDEN', 'This Real-Debrid account cannot do that (premium required or account restricted).');
  }
  if (code === 22) return new ApiError(403, 'DEBRID_IP_BLOCKED', 'Real-Debrid does not allow requests from this IP address.');
  if (code === 35) return new ApiError(451, 'DEBRID_BLOCKED_FILE', 'Real-Debrid has blocked this file. Pick another stream.');
  if (code === 21 || code === 23 || code === 26 || code === 36) {
    return new ApiError(429, 'DEBRID_LIMIT', 'Real-Debrid limits reached (active downloads or traffic). Remove old torrents or try later.');
  }
  if (code === 29) return new ApiError(422, 'DEBRID_TOO_BIG', 'This torrent is too big for Real-Debrid.');
  if (error.status === 429 || code === 34 || code === 5) {
    return new ApiError(429, 'DEBRID_BUSY', 'Real-Debrid is rate limiting requests. Wait a few seconds and retry.', {
      headers: { 'Retry-After': '5' },
    });
  }
  if (error.status === 404 || code === 7) return new ApiError(404, 'DEBRID_NOT_FOUND', 'Real-Debrid could not find that torrent.');
  if (error.status === 504) return new ApiError(504, 'DEBRID_TIMEOUT', 'Real-Debrid did not respond in time.');
  if (code === 25 || error.status === 503) return new ApiError(503, 'DEBRID_UNAVAILABLE', 'Real-Debrid is temporarily unavailable.');
  return new ApiError(502, 'DEBRID_ERROR', 'Real-Debrid returned an unexpected error.');
}

/** Only real, routable client IPs are forwarded (RD ties links to the viewer's IP). */
export function forwardableIp(ip: string | null | undefined): string | null {
  const value = (ip || '').trim();
  const family = isIP(value);
  if (!family) return null;
  if (family === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
    return value;
  }
  const lower = value.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return null;
  return value;
}

type FormValues = Record<string, string | undefined>;

async function rd<T>(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  { query, form, timeoutMs }: { query?: Record<string, string>; form?: FormValues; timeoutMs?: number } = {}
): Promise<T> {
  const url = new URL(`${REALDEBRID_API}/${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const body = form
    ? new URLSearchParams(Object.entries(form).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? getConfig().debrid.realDebridTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = (error as Error)?.name === 'AbortError';
    throw new RealDebridApiError(timedOut ? 504 : 502, null, timedOut ? 'timeout' : 'network error');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!response.ok) {
    const payload = (data ?? {}) as { error?: unknown; error_code?: unknown };
    const code = typeof payload.error_code === 'number' ? payload.error_code : null;
    logger.warn('Real-Debrid error', { path: path.replace(/\/[A-Za-z0-9]{6,}$/, '/:id'), status: response.status, code });
    throw new RealDebridApiError(response.status, code, typeof payload.error === 'string' ? payload.error : 'error');
  }
  return data as T;
}

/** Wraps RD calls so route handlers only ever see ApiError. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RealDebridApiError) throw toApiError(error);
    throw error;
  }
}

export function getAccount(token: string): Promise<RealDebridAccount> {
  return guarded(async () => {
    const user = await rd<{ username?: string; type?: string; premium?: number; expiration?: string; points?: number }>(token, 'GET', 'user');
    const premium = user?.type === 'premium';
    return {
      username: String(user?.username || 'Real-Debrid user').slice(0, 80),
      premium,
      expiration: premium && typeof user?.expiration === 'string' ? user.expiration : null,
      premiumDaysLeft: premium && typeof user?.premium === 'number' ? Math.max(0, Math.floor(user.premium / 86400)) : 0,
      points: typeof user?.points === 'number' ? user.points : 0,
    };
  });
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.test(path);
}

function baseName(path: string): string {
  return path.split('/').pop()?.toLowerCase() ?? '';
}

function episodeMatcher(season?: number, episode?: number): RegExp | null {
  if (!season || !episode) return null;
  const s = String(season);
  const e = String(episode);
  return new RegExp(`(?:s0*${s}[ ._-]*e0*${e}(?!\\d))|(?:(?<!\\d)0*${s}x0*${e}(?!\\d))`, 'i');
}

/**
 * Picks the file to play. Torrentio's `fileIdx` is the torrent file index and
 * Real-Debrid file ids are 1-based in the same order (`id = fileIdx + 1`);
 * fall back to the file name, then the requested episode, then the largest
 * non-sample video.
 */
export function pickTargetFile(files: RealDebridFile[], request: Pick<ResolveRequest, 'fileIdx' | 'filename' | 'season' | 'episode'>): RealDebridFile | null {
  const videos = files.filter((file) => isVideoPath(file.path));
  if (!videos.length) return null;
  if (typeof request.fileIdx === 'number') {
    const byIndex = videos.find((file) => file.id === request.fileIdx! + 1);
    if (byIndex) return byIndex;
  }
  if (request.filename) {
    const wanted = request.filename.toLowerCase();
    const byName = videos.find((file) => baseName(file.path) === wanted);
    if (byName) return byName;
  }
  const matcher = episodeMatcher(request.season, request.episode);
  if (matcher) {
    const byEpisode = videos.filter((file) => matcher.test(baseName(file.path)) && !SAMPLE.test(baseName(file.path)));
    if (byEpisode.length) return byEpisode.sort((a, b) => b.bytes - a.bytes)[0];
  }
  const main = videos.filter((file) => !SAMPLE.test(baseName(file.path)));
  return (main.length ? main : videos).slice().sort((a, b) => b.bytes - a.bytes)[0];
}

const isSelected = (file: RealDebridFile) => file.selected === 1 || file.selected === true;

/** RD returns one link per selected file, in file order. */
export function linkForFile(torrent: RealDebridTorrent, target: RealDebridFile): string | null {
  const links = torrent.links ?? [];
  if (links.length === 1) return links[0];
  const position = (torrent.files ?? []).filter(isSelected).findIndex((file) => file.id === target.id);
  return position >= 0 ? links[position] ?? null : null;
}

async function info(token: string, id: string): Promise<RealDebridTorrent> {
  return rd<RealDebridTorrent>(token, 'GET', `torrents/info/${encodeURIComponent(id)}`);
}

async function waitForFiles(token: string, id: string): Promise<RealDebridTorrent> {
  let torrent = await info(token, id);
  for (let poll = 0; torrent.status === 'magnet_conversion' && poll < OPEN_POLLS; poll += 1) {
    await sleep(OPEN_POLL_MS);
    torrent = await info(token, id);
  }
  return torrent;
}

/**
 * Looks for an already-added copy of this release on the shared account.
 *
 * KNOWN LIMITS — accepted deliberately, documented rather than papered over:
 *
 *  - Only the newest `FIND_LIMIT` (50) torrents are inspected, page 1 only.
 *    The account is shared by every AALAM user, so on a busy deployment older
 *    torrents fall off page 1 while still being alive on Real-Debrid. When that
 *    happens the release is added a second time, spending another of the
 *    account's finite torrent slots on something it already had.
 *  - Matching is by infoHash alone. A second visitor who picks a different
 *    file in the same release settles on the first visitor's torrent, and
 *    `settle` calls `selectFiles`, which *replaces* the shared selection. The
 *    earlier visitor's already-unrestricted link keeps working, but a later
 *    resolve for the original file re-selects it again — so two users watching
 *    different files of one release make each other re-select.
 *
 * Both are tolerable while the account is lightly used: Real-Debrid expires
 * idle torrents, and the cost is a redundant slot or an extra selectFiles
 * round trip, never a wrong or unplayable link. Fixing them properly needs
 * state the process does not have — either paginating the whole account list
 * (unbounded API cost) or a durable (infoHash, fileIdx) → torrentId index
 * shared across replicas. If slot exhaustion or selection thrash shows up in
 * practice, that index is the fix; do not raise FIND_LIMIT as a substitute,
 * it only moves the cliff.
 */
async function findExisting(token: string, infoHash: string): Promise<RealDebridTorrent[]> {
  const list = await rd<RealDebridTorrent[] | undefined>(token, 'GET', 'torrents', { query: { limit: String(FIND_LIMIT), page: '1' } });
  return (Array.isArray(list) ? list : []).filter(
    (torrent) => torrent.hash?.toLowerCase() === infoHash && !FAILED.has(torrent.status)
  );
}

async function addMagnet(token: string, request: ResolveRequest, ip: string | null): Promise<string> {
  const magnet = buildMagnet(request.infoHash, request.releaseName, request.trackers ?? []);
  const added = await rd<{ id?: string }>(token, 'POST', 'torrents/addMagnet', { form: { magnet, ip: ip ?? undefined } });
  if (!added?.id || !TORRENT_ID.test(added.id)) throw new RealDebridApiError(502, null, 'addMagnet returned no id');
  return added.id;
}

async function transcodeLinks(token: string, unrestrictedId: string): Promise<TranscodeLinks> {
  try {
    const data = await rd<Record<string, { full?: unknown } | undefined>>(token, 'GET', `streaming/transcode/${encodeURIComponent(unrestrictedId)}`, { timeoutMs: 4000 });
    const pick = (key: string) => {
      const full = data?.[key]?.full;
      return typeof full === 'string' && /^https:\/\//.test(full) ? full : undefined;
    };
    const links = { mp4: pick('liveMP4'), hls: pick('apple'), webm: pick('h264WebM') };
    return links.mp4 || links.hls || links.webm ? links : null;
  } catch {
    return null; // Transcoding is optional; direct playback still works.
  }
}

function progressOf(torrent: RealDebridTorrent): ResolveResult {
  return {
    status: 'downloading',
    torrentId: torrent.id,
    progress: Math.max(0, Math.min(100, Number(torrent.progress) || 0)),
    speedBytes: typeof torrent.speed === 'number' ? torrent.speed : null,
    seeders: typeof torrent.seeders === 'number' ? torrent.seeders : null,
    phase: torrent.status,
  };
}

async function settle(token: string, torrent: RealDebridTorrent, request: ResolveRequest, ip: string | null): Promise<ResolveResult | 'reselect'> {
  if (FAILED.has(torrent.status)) {
    return {
      status: 'failed',
      torrentId: torrent.id,
      reason: torrent.status === 'magnet_error' ? 'magnet_error' : 'error',
      message: torrent.status === 'magnet_error' ? 'Real-Debrid could not open this magnet.' : 'Real-Debrid could not download this torrent.',
    };
  }
  if (torrent.status === 'magnet_conversion') return progressOf({ ...torrent, progress: 0 });

  if (torrent.status === 'waiting_files_selection') {
    const target = pickTargetFile(torrent.files ?? [], request);
    if (!target) return { status: 'failed', torrentId: torrent.id, reason: 'no_video', message: 'This torrent has no playable video file.' };
    await rd(token, 'POST', `torrents/selectFiles/${encodeURIComponent(torrent.id)}`, { form: { files: String(target.id), ip: ip ?? undefined } });
    const updated = await info(token, torrent.id);
    if (updated.status === 'waiting_files_selection') return progressOf({ ...updated, status: 'queued', progress: 0 });
    return settle(token, updated, request, ip);
  }

  if (DOWNLOADING.has(torrent.status)) return progressOf(torrent);

  if (READY.has(torrent.status)) {
    const files = torrent.files ?? [];
    const target = pickTargetFile(files, request);
    if (!target) return { status: 'failed', torrentId: torrent.id, reason: 'no_video', message: 'This torrent has no playable video file.' };
    if (!isSelected(target)) return 'reselect';
    const link = linkForFile(torrent, target);
    if (!link) return 'reselect';
    const unrestricted = await rd<Unrestricted>(token, 'POST', 'unrestrict/link', { form: { link, remote: '0', ip: ip ?? undefined } });
    if (!unrestricted?.download || !/^https:\/\//.test(unrestricted.download)) {
      return { status: 'failed', torrentId: torrent.id, reason: 'error', message: 'Real-Debrid returned no playable link.' };
    }
    if (ARCHIVE_EXTENSIONS.test(new URL(unrestricted.download).pathname)) {
      return { status: 'failed', torrentId: torrent.id, reason: 'archive', message: 'Real-Debrid only offers an archive for this torrent. Pick another stream.' };
    }
    return {
      status: 'ready',
      torrentId: torrent.id,
      file: { name: target.path.split('/').pop() || target.path, bytes: target.bytes },
      stream: {
        url: unrestricted.download,
        filename: unrestricted.filename || target.path.split('/').pop() || 'video',
        mimeType: unrestricted.mimeType || null,
        filesize: typeof unrestricted.filesize === 'number' ? unrestricted.filesize : null,
        streamable: unrestricted.streamable === 1,
      },
      transcode: unrestricted.id ? await transcodeLinks(token, unrestricted.id) : null,
    };
  }
  return { status: 'failed', torrentId: torrent.id, reason: 'error', message: `Unexpected Real-Debrid status: ${torrent.status}` };
}

/**
 * Find-or-add → select → unrestrict. Reuses a torrent already in the account
 * when it has the wanted file selected; otherwise adds a fresh copy (RD allows
 * the same hash more than once with different file selections).
 */
export function resolveStream(token: string, request: ResolveRequest, clientIp?: string | null): Promise<ResolveResult> {
  return guarded(async () => {
    if (!isInfoHash(request.infoHash)) throw new ApiError(400, 'BAD_REQUEST', 'infoHash must be a 40-character hex hash');
    const ip = forwardableIp(clientIp);
    const infoHash = request.infoHash.toLowerCase();
    const normalized = { ...request, infoHash };

    if (request.torrentId && TORRENT_ID.test(request.torrentId)) {
      try {
        const known = await info(token, request.torrentId);
        if (known.hash?.toLowerCase() === infoHash) {
          const outcome = await settle(token, known, normalized, ip);
          if (outcome !== 'reselect') return outcome;
        }
      } catch (error) {
        if (!(error instanceof RealDebridApiError) || (error.status !== 404 && error.code !== 7)) throw error;
      }
    }

    for (const candidate of await findExisting(token, infoHash)) {
      const detailed = await info(token, candidate.id);
      const outcome = await settle(token, detailed, normalized, ip);
      if (outcome !== 'reselect' && !(outcome.status === 'failed' && outcome.reason === 'error')) return outcome;
    }

    const id = await addMagnet(token, normalized, ip);
    const opened = await waitForFiles(token, id);
    const outcome = await settle(token, opened, normalized, ip);
    if (outcome === 'reselect') {
      return { status: 'failed', torrentId: id, reason: 'error', message: 'Real-Debrid did not prepare the selected file.' };
    }
    return outcome;
  });
}

export function deleteTorrent(token: string, torrentId: string): Promise<void> {
  return guarded(async () => {
    if (!TORRENT_ID.test(torrentId)) throw new ApiError(400, 'BAD_REQUEST', 'Invalid torrent id');
    await rd(token, 'DELETE', `torrents/delete/${encodeURIComponent(torrentId)}`);
  });
}
