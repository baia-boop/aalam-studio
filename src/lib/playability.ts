import {
  AUTOMATIC_EMBED_SOURCES,
  buildEmbedSourceUrl,
  supportsEmbedSourceMediaType,
  type EmbedSourceOption,
} from '@/lib/embed-sources';
import type { PlaybackAudioCode } from '@/lib/playback-localization';
import type { MediaType } from '@/types/media';
import { isReleased, releaseTime } from '@/lib/release';

/**
 * Playback route eligibility, independent of the operator’s title-level grants.
 *
 * Before this module every Play surface tested `sourcesCount > 0` directly.
 * That value is a registry constant (`released ? 8 : 0`) computed in
 * `lib/tmdb.ts`, so it says nothing about the title itself: sample records with
 * no TMDB id and titles no route can resolve both looked playable, and the
 * player then fell back to a simulated preview.
 *
 * The rules below are what the registry can actually stand behind without a
 * network probe. `Playback` never claims more than that:
 *
 *  - a placeholder/sample record has no TMDB id, so no route can resolve it;
 *  - an unreleased title carries no playable sources;
 *  - a media type no automatic route supports cannot be played.
 *
 * Route *reachability* is a runtime concern: `/api/streams/detect` probes the
 * registry per title and `WatchView` fails over inside the approved set. This
 * module only decides whether offering Play is honest in the first place.
 */

export type PlayabilityReason =
  | 'playable'
  /** Placeholder/sample record: no TMDB id, so nothing can resolve it. */
  | 'unidentified'
  /** Not released yet (the data layer reports no playable sources). */
  | 'unreleased'
  | 'unknown-release'
  /** No automatic route supports this media type. */
  | 'no-route'
  /** A route can address this TMDB ID, but no authorized source is known. */
  | 'not-authorized';

export interface Playability {
  playable: boolean;
  reason: PlayabilityReason;
  /** Automatic routes that could serve this media type. */
  routes: number;
}

export type PlayabilityInput = {
  tmdbId?: number | null;
  type: MediaType;
  sourcesCount: number;
  /**
   * ISO release date, when the catalogue knows one. A known date on or before today is required before offering Play. See lib/release.ts.
   */
  releaseDate?: string | null;
};

/**
 * Count the routes the automatic player may select for a media type. Manual-only
 * records are excluded on purpose: they are never auto-selected or failed over,
 * so they cannot back a Play promise.
 */
export function eligiblePlaybackRouteCount(type: MediaType): number {
  return AUTOMATIC_EMBED_SOURCES.filter((source) =>
    supportsEmbedSourceMediaType(source, type)
  ).length;
}

export function resolvePlayability(item: PlayabilityInput): Playability {
  const routes = eligiblePlaybackRouteCount(item.type);

  if (!item.tmdbId || !Number.isSafeInteger(item.tmdbId) || item.tmdbId <= 0) {
    return { playable: false, reason: 'unidentified', routes };
  }

  // Release state first: an unreleased title is not playable whatever a stale
  // source count claims.
  if (releaseTime(item) === null) return { playable: false, reason: 'unknown-release', routes };
  if (!isReleased(item)) {
    return { playable: false, reason: 'unreleased', routes };
  }

  if (!Number.isFinite(item.sourcesCount) || item.sourcesCount <= 0) {
    return { playable: false, reason: 'unreleased', routes };
  }

  if (routes === 0) {
    return { playable: false, reason: 'no-route', routes };
  }

  return { playable: true, reason: 'playable', routes };
}

/** Compatibility check only. UI actions must also check deployment grants. */
export function isPlayable(item: PlayabilityInput): boolean {
  return resolvePlayability(item).playable;
}

/**
 * Honest short label for a non-playable title. `null` when the title is
 * playable, so callers can render the normal Play affordance.
 */
export function playabilityNotice(
  reason: PlayabilityReason
): string | null {
  switch (reason) {
    case 'playable':
      return null;
    case 'unreleased':
      return 'Not yet released';
    case 'unknown-release':
      return 'Release date unavailable';
    case 'unidentified':
    case 'no-route':
    case 'not-authorized':
      return 'Can’t play this yet';
  }
}

/* ============================================================================
   Playable content: a catalogued title vs. a resolved playback source
   ============================================================================

   A TMDB record is *catalogue metadata*. It is not playable media, and neither
   is its poster or backdrop. What makes a title playable is a **resolved
   playback source**: an approved route plus the concrete player URL that route
   serves for this exact title/season/episode.

   `resolvePlaybackSources()` materialises that distinction. `MediaItem` stays
   catalogue data; a compatibility match is never an authorized Play offer.

   The member-only debrid pipeline is deliberately absent here: it resolves
   server-side against a verified entitlement (`/api/debrid/realdebrid/resolve`)
   and can never be promised to an anonymous visitor, so counting it would make
   Play dishonest for everyone who has not subscribed.
   ========================================================================== */

export interface EmbedPlaybackSource {
  kind: 'embed';
  /** Registry id, the only value automatic failover accepts. */
  routeId: string;
  /** Registry label, diagnostic only — never shown as a provider choice. */
  label: string;
  /** Absolute URL that plays this title/episode on the route. */
  url: string;
  quality: string;
  sandboxed: boolean;
  seekSupport: EmbedSourceOption['seekSupport'];
}

export type PlaybackSource = EmbedPlaybackSource;

export type PlaybackSourceRequest = {
  type: MediaType;
  tmdbId?: number | null;
  season?: number;
  episode?: number;
  /** Advisory audio request, forwarded only where a route documents it. */
  audio?: PlaybackAudioCode;
};

function isValidTmdbId(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Candidate URLs in automatic-selection order. They establish compatibility,
 * not permission or that a stream actually exists. Never offer these directly
 * without a deployment grant.
 *
 * Route resolution answers "does an approved route address these coordinates?",
 * not "does media exist yet?". Release state is judged by `resolvePlayability`,
 * which must also pass before a title may be promoted or played.
 */
export function resolvePlaybackSources(
  request: PlaybackSourceRequest
): PlaybackSource[] {
  if (!isValidTmdbId(request.tmdbId)) return [];

  return AUTOMATIC_EMBED_SOURCES.filter((source) =>
    supportsEmbedSourceMediaType(source, request.type)
  ).map((source) => {
    const url = buildEmbedSourceUrl(source, {
      tmdbId: request.tmdbId as number,
      type: request.type,
      season: request.season,
      episode: request.episode,
      audio: request.audio,
    });
    return {
      kind: 'embed' as const,
      routeId: source.id,
      label: source.label,
      url,
      quality: source.quality,
      // `unsandboxed` is an explicit product exception; expose the effective
      // state so callers never have to re-derive it from the registry flag.
      sandboxed: !source.unsandboxed,
      seekSupport: source.seekSupport,
    };
  });
}

export type PlaybackGrants = Readonly<Record<string, readonly string[]>>;

const NO_ROUTES: readonly string[] = Object.freeze([]);
const DEFAULT_AUTOMATIC_ROUTES: readonly string[] = Object.freeze(
  AUTOMATIC_EMBED_SOURCES.map((source) => source.id)
);

export function grantedPlaybackRoutes(grants: PlaybackGrants, type: MediaType, tmdbId?: number | null): readonly string[] {
  if (!isValidTmdbId(tmdbId)) return NO_ROUTES;
  if (Object.keys(grants).length === 0) return DEFAULT_AUTOMATIC_ROUTES;
  return grants[`${type}:${tmdbId}`] ?? NO_ROUTES;
}

/** A generated frame URL (or a TMDB subscription match) cannot grant Play. */
export function resolveDiscoveryPlayability(item: PlayabilityInput, grants: PlaybackGrants): Playability {
  const candidate = resolvePlayability(item);
  if (!candidate.playable) return candidate;
  const allowed = grantedPlaybackRoutes(grants, item.type, item.tmdbId);
  const routes = AUTOMATIC_EMBED_SOURCES.filter((source) => allowed.includes(source.id) && supportsEmbedSourceMediaType(source, item.type)).length;
  return routes > 0 ? { playable: true, reason: 'playable', routes } : { playable: false, reason: 'not-authorized', routes: 0 };
}

export function isEligibleForPromotion(item: PlayabilityInput, grants: PlaybackGrants): boolean {
  return resolveDiscoveryPlayability(item, grants).playable;
}

/** Playable first, preserving the relative order of both sets. */
export function orderPlayableFirst<T extends PlayabilityInput>(items: readonly T[], grants: PlaybackGrants): T[] {
  const playable: T[] = [];
  const catalogueOnly: T[] = [];
  for (const item of items) (isEligibleForPromotion(item, grants) ? playable : catalogueOnly).push(item);
  return [...playable, ...catalogueOnly];
}
