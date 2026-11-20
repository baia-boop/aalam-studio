import { apiRoute } from '@/server/core/api';
import { badRequest } from '@/server/core/errors';
import { isRecord } from '@/server/core/validate';
import { resolveStream } from '@/server/debrid/realdebrid';
import { requireDebridEntitlement } from '@/server/debrid/access';
import { requireDebridServiceToken } from '@/server/debrid/request';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { isInfoHash } from '@/lib/torrentio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * C0 control characters are rejected outright: they would otherwise be copied
 * verbatim into log lines and into the upstream Real-Debrid request.
 *
 * Written as a scan rather than `/[\u0000-\u001f]/` because that literal trips
 * `no-control-regex`, which exists to catch control characters that slipped into
 * a pattern by accident. Here they are the subject of the check, not a typo, and
 * the loop makes the exact accepted range (0x00–0x1f) obvious at the call site.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || hasControlCharacter(value)) {
    throw badRequest(`${name} must be a string of at most ${max} characters`);
  }
  return value;
}

/**
 * POST /api/debrid/realdebrid/resolve  (AALAM session required)
 * { infoHash, fileIdx?, filename?, releaseName?, trackers?, season?, episode?, torrentId? }
 *
 * The shared service token stays on the server. Returns `ready` with a direct Real-Debrid link (plus optional transcodes),
 * `downloading` with progress for uncached torrents (poll again with the
 * returned torrentId), or `failed` with a reason.
 */
export const POST = apiRoute({ name: 'debrid.resolve', auth: 'required', rateLimit: RATE_LIMITS.debrid }, async ({ readJson, clientIp, session }) => {
  const token = requireDebridServiceToken();
  await requireDebridEntitlement(session);
  const body = await readJson<unknown>(16 * 1024);
  if (!isRecord(body)) throw badRequest('Expected a JSON object');
  if (!isInfoHash(body.infoHash)) throw badRequest('infoHash must be a 40-character hex hash');
  const trackers = Array.isArray(body.trackers)
    ? body.trackers
        .filter((tracker): tracker is string => typeof tracker === 'string' && tracker.length <= 300 && /^(udp|https?|wss?):\/\//i.test(tracker))
        .slice(0, 30)
    : [];
  const torrentId = optionalString(body.torrentId, 'torrentId', 32);
  if (torrentId && !/^[A-Za-z0-9]{6,32}$/.test(torrentId)) throw badRequest('torrentId is invalid');

  const result = await resolveStream(
    token,
    {
      infoHash: body.infoHash,
      fileIdx: optionalInt(body.fileIdx, 'fileIdx', 0, 100000) ?? null,
      filename: optionalString(body.filename, 'filename', 400) ?? null,
      releaseName: optionalString(body.releaseName, 'releaseName', 400) ?? null,
      trackers,
      season: optionalInt(body.season, 'season', 0, 10000),
      episode: optionalInt(body.episode, 'episode', 1, 10000),
      torrentId: torrentId ?? null,
    },
    clientIp
  );
  return { result };
});
