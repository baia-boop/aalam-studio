import { getAuthorizedPlaybackGrants } from '@/server/playback/grants';
import { apiRoute } from '@/server/core/api';
import { ApiError, badRequest } from '@/server/core/errors';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { getOrSet } from '@/server/cache';
import {
  AUTOMATIC_EMBED_SOURCES,
  buildEmbedSourceUrl,
  orderForAudioPreference,
} from '@/lib/embed-sources';
import {
  getDocumentedUrlAudioRequest,
  getPlaybackLocalization,
  localizationScore,
  normalizePlaybackAudioPreference,
} from '@/lib/playback-localization';
import { DEFAULT_WATCH_REGION, isWatchRegion } from '@/lib/watch-regions';
import { parseWatchCoordinate } from '@/lib/episode-navigation';
import { grantedPlaybackRoutes } from '@/lib/playability';
import type { MediaType } from '@/types/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 2200;
const DETECT_CACHE_TTL_SEC = 5 * 60;

interface ProbeResult {
  /** Opaque internal route identifier used only by automatic client failover. */
  id: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  /** False only when a response explicitly denies being framed. */
  frameAllowed: boolean;
  /** `client-frame` means provider docs reject scripted/direct probe requests. */
  probe: 'http' | 'client-frame';
}

/**
 * A successful HTTP response is not enough for an iframe. Catch explicit
 * X-Frame-Options / frame-ancestors denials here so an auto-selected route
 * does not get stuck in a preview/sandbox that the provider will never allow.
 */
function responseAllowsEmbedding(headers: Headers): boolean {
  const xFrameOptions = headers.get('x-frame-options')?.toLowerCase() || '';
  if (/\bdeny\b|\bsameorigin\b/.test(xFrameOptions)) return false;

  const csp = headers.get('content-security-policy') || '';
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => /^frame-ancestors\b/i.test(part));
  if (!directive) return true;

  const values = directive
    .replace(/^frame-ancestors\b/i, '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (values.includes("'none'")) return false;
  // A standalone 'self' means only the embed provider's own origin can frame
  // it. Mixed policies can include the AALAM deployment, so do not reject
  // those optimistically without an exact deployment-origin comparison.
  return !(values.length === 1 && values[0] === "'self'");
}

async function probeSource(
  source: (typeof AUTOMATIC_EMBED_SOURCES)[number],
  tmdbId: number,
  type: MediaType,
  season: number,
  episode: number,
  localization: ReturnType<typeof getPlaybackLocalization>
): Promise<ProbeResult> {
  const url = buildEmbedSourceUrl(source, {
    tmdbId,
    type,
    season,
    episode,
    audio: getDocumentedUrlAudioRequest(source, localization) || undefined,
    region: localization.region,
  });
  // Some reviewed providers intentionally return an error when an embed URL is
  // opened or fetched by script. Treating that documented behavior as an outage
  // would permanently hide a playable iframe, and following it server-side is
  // both inaccurate and unsafe. The browser frame + documented telemetry is the
  // authoritative check for those records.
  if (source.probeMode === 'iframe-only') {
    return {
      id: source.id,
      ok: true,
      status: null,
      latencyMs: 0,
      frameAllowed: true,
      probe: 'client-frame',
    };
  }

  const started = performance.now();
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      // Treat redirects as a reachable route but never follow a third-party
      // redirect from this server-side health check. The browser iframe may
      // follow its own navigation; this avoids turning a provider redirect into
      // an origin-side SSRF hop.
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AALAM-StreamCheck/1.1)',
        Accept: 'text/html,*/*;q=0.8',
      },
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AALAM-StreamCheck/1.1)',
          Accept: 'text/html,*/*;q=0.8',
        },
      });
    }
    const latencyMs = Math.round(performance.now() - started);
    const frameAllowed = responseAllowsEmbedding(res.headers);
    // 2xx / 3xx / 403-bot-shield from browser-only embeds still indicate a
    // live host. Explicit anti-framing headers always win over host health.
    const hostReachable =
      (res.status >= 200 && res.status < 400) || res.status === 403;
    return {
      id: source.id,
      ok: hostReachable && frameAllowed,
      status: res.status,
      latencyMs,
      frameAllowed,
      probe: 'http',
    };
  } catch {
    return {
      id: source.id,
      ok: false,
      status: null,
      latencyMs: Math.round(performance.now() - started),
      frameAllowed: true,
      probe: 'http',
    };
  }
}

export const GET = apiRoute(
  {
    name: 'streams-detect',
    rateLimit: RATE_LIMITS.streams,
    cacheControl: 'private, no-store',
  },
  async (ctx) => {
    const rawType = ctx.url.searchParams.get('type') || 'movie';
    if (rawType !== 'movie' && rawType !== 'tv') {
      throw badRequest('type must be movie or tv');
    }
    const tmdbId = Number(ctx.url.searchParams.get('id') || '0');
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || tmdbId > 50_000_000) {
      throw badRequest('id must be a positive TMDB integer');
    }
    const season = rawType === 'tv' ? parseWatchCoordinate(ctx.url.searchParams.get('s'), 'season') : 1;
    const episode = rawType === 'tv' ? parseWatchCoordinate(ctx.url.searchParams.get('e'), 'episode') : 1;
    if (season === null || episode === null) throw badRequest('Invalid season or episode.');

    const regionHint = ctx.url.searchParams.get('region')?.trim().toUpperCase();
    if (regionHint !== undefined && !isWatchRegion(regionHint)) throw badRequest('Choose a valid ISO country code.');
    const region = regionHint ?? DEFAULT_WATCH_REGION;
    const regionSource = regionHint ? 'content-market' : 'default';
    const audioPreference = normalizePlaybackAudioPreference(
      ctx.url.searchParams.get('audio')
    );
    // Accept-Language is already attached by the browser request. We reduce it
    // to the small, documented playback-candidate set before ranking/caching;
    // raw language headers are neither persisted nor returned to the client.
    const localization = getPlaybackLocalization(
      region,
      audioPreference,
      ctx.req.headers.get('accept-language')
    );

    const grants = grantedPlaybackRoutes(getAuthorizedPlaybackGrants(), rawType, tmdbId);
    const candidates = AUTOMATIC_EMBED_SOURCES.filter((source) => grants.includes(source.id));
    if (!candidates.length) throw new ApiError(403, 'PLAYBACK_NOT_AUTHORIZED', 'No player is available for this title.');

    const cacheKey = [
      'streams:detect',
      candidates.map((source) => source.id).join(','),
      rawType,
      tmdbId,
      season,
      episode,
      localization.region,
      regionSource,
      audioPreference,
      localization.audioCandidates.join(','),
    ].join(':');
    const { value } = await getOrSet(
      cacheKey,
      async () => {
        const sourceById = new Map(
          candidates.map((source) => [source.id, source])
        );
        // Registry order is only a deterministic tiebreaker. It must not drown
        // out a reviewed audio-default capability after health has been checked.
        const orderBonus = new Map(
          candidates.map((source, index) => [source.id, index * 12])
        );
        const results = await Promise.all(
          candidates.map((source) =>
            probeSource(source, tmdbId, rawType, season, episode, localization)
          )
        );

        const scored = [...results].sort((a, b) => {
          if (a.ok !== b.ok) return a.ok ? -1 : 1;
          // A successful HTTP frame probe is stronger reachability evidence than
          // a route whose provider intentionally forbids probes. The latter is
          // still eligible for automatic client-side fallback, never discarded.
          if (a.ok && a.probe !== b.probe) {
            return a.probe === 'http' ? -1 : 1;
          }
          const sourceA = sourceById.get(a.id);
          const sourceB = sourceById.get(b.id);
          const sourcePenalty = (result: ProbeResult) =>
            result.probe === 'client-frame' ? 80 : 0;
          const scoreA =
            a.latencyMs +
            (orderBonus.get(a.id) || 0) +
            sourcePenalty(a) -
            (sourceA ? localizationScore(sourceA, localization) : 0);
          const scoreB =
            b.latencyMs +
            (orderBonus.get(b.id) || 0) +
            sourcePenalty(b) -
            (sourceB ? localizationScore(sourceB, localization) : 0);
          return scoreA - scoreB;
        });

        // The Hindi Server leads for a Hindi-first visitor (explicit choice or
        // a Hindi-first region default) as long as its host answered; for
        // everyone else it is only the final fallback. Health still wins:
        // an unreachable Hindi Server never outranks a working route.
        const firstAudio = localization.audioCandidates[0];
        const byId = new Map(scored.map((result) => [result.id, result]));
        const audioOrdered = orderForAudioPreference(
          scored.map((result) => result.id),
          firstAudio
        ).map((id) => byId.get(id)!);
        const ranked = [
          ...audioOrdered.filter((result) => result.ok),
          ...audioOrdered.filter((result) => !result.ok),
        ];

        const best = ranked.find((result) => result.ok);
        return {
          // Nothing answered: keep the audio-aware order (Hindi Server first
          // for Hindi-first visitors) instead of a fixed default.
          bestServerId: best ? best.id : ranked[0].id,
          detected: Boolean(best),
          ranked,
          region: localization.region,
          regionSource,
          audio: {
            code: localization.audio,
            label: localization.label,
            candidates: localization.audioCandidates,
            source: localization.source,
            explicit: localization.isExplicit,
          },
        };
      },
      { ttl: DETECT_CACHE_TTL_SEC, swr: 60, cacheIf: (v) => Boolean(v) }
    );
    return value;
  }
);
