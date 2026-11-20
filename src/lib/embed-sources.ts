import { MediaType } from '@/types/media';
import type { PlaybackAudioCode } from '@/lib/playback-localization';

/**
 * How the provider's documented audio control works. `url-language` means the
 * provider documents an audio-preference URL parameter (with either language
 * codes or provider labels); it is a request, never proof that a particular
 * title has that dubbed track.
 */
export type EmbedAudioSelection =
  | {
      kind: 'url-language';
      parameter: string;
      /**
       * The provider can accept ISO-639-1 values directly or its own documented
       * labels (for example, `hindi`). An unlisted code must never be sent just
       * because it is a valid-looking language tag.
       */
      valueFormat: 'iso-639-1' | 'provider-label';
      /** Values demonstrated by the provider's integration documentation. */
      documentedLanguages: readonly PlaybackAudioCode[];
      /**
       * Provider-specific values for documented audio codes. Omitted only when
       * the documented value is the ISO-639-1 code itself.
       */
      values?: Readonly<Partial<Record<PlaybackAudioCode, string>>>;
    };

export interface EmbedSourceOption {
  id: string;
  /** Short internal diagnostic label. */
  name: string;
  label: string;
  /** Provider name shown in the manual testing dropdown. */
  providerName: string;
  /**
   * Manual-only records are available through the player dropdown but are
   * never origin-probed, auto-selected, or included in automatic failover.
   */
  manualOnly?: boolean;
  /**
   * A short, non-promissory explanation shown beside a manual-test option.
   * It must describe the known constraint, not assert that playback works.
   */
  manualTestLabel?: string;
  /**
   * Manual tests never trigger automatic failover. When the provider offers no
   * trustworthy playback signal, this timeout only replaces an endless host UI
   * spinner with an honest "not confirmed" notice; it never declares success
   * or failure inside the cross-origin player.
   */
  manualTestTimeoutMs?: number;
  /** Omit when the reviewed route supports both movies and TV. */
  supportedMediaTypes?: readonly MediaType[];
  quality: string;
  seekSupport: 'excellent' | 'good' | 'medium';
  description: string;
  kind: 'embed' | 'trailer';
  reportsPlayback?: boolean;
  taggedProgressMessages?: boolean;
  /**
   * Documented message families. An envelope alone does not establish playback;
   * the caller validates origin, frame and the contents of the event.
   */
  playbackStartMessageTypes?: readonly string[];
  /** Exact, documented origins allowed to send player messages. */
  messageOrigins?: readonly string[];
  /** Primary frame origin, retained with the reviewed provider metadata. */
  frameOrigin: string;
  /**
   * Extra frame-src entries for players that redirect or hop between their
   * own subdomains (CSP checks every redirect target of the iframe).
   */
  extraFrameOrigins?: readonly string[];
  /**
   * Opt out of the iframe sandbox. Only for players that are documented to
   * break under any sandbox (StreamVault's 2026-11-12 playback test). These
   * frames get StreamVault's permission list and an `origin` referrer because
   * the providers check the embedding domain. In-frame ads and popups are
   * possible; this was an explicit product decision.
   */
  unsandboxed?: boolean;
  /**
   * A server whose purpose is one dubbed audio language (the Hindi Server).
   * It is tried first when that language is the visitor's first audio
   * preference, and only as a last resort otherwise.
   */
  dedicatedAudio?: PlaybackAudioCode;
  /** Short badge shown in the server menu (e.g. "4K", "Hindi"). */
  badge?: string;
  /**
   * ISO-639-1 tracks specifically documented for this integration. Omit when
   * the provider documents only a selector, an in-player menu, or nothing.
   * Absence means unknown—not English only.
   */
  audioLanguages?: readonly PlaybackAudioCode[];
  /** Documented audio selection/default mechanism, if any. */
  audioSelection?: EmbedAudioSelection;
  /** Countries for which this integration has an explicitly configured route. */
  regionHints?: readonly string[];
  /**
   * HTTP probing is the normal health check. iframe-only is for providers that
   * explicitly reject scripted/direct fetches; the client frame is then the
   * only meaningful reachability check.
   */
  probeMode?: 'http' | 'iframe-only';
  buildUrl: (params: {
    tmdbId: number;
    type: MediaType;
    season?: number;
    episode?: number;
  }) => string;
}

export type EmbedUrlParams = {
  tmdbId: number;
  type: MediaType;
  season?: number;
  episode?: number;
  /** Advisory only: providers may fall back when a title lacks that track. */
  audio?: PlaybackAudioCode;
  region?: string;
};

/**
 * Keep sandbox-compatible external players constrained without granting popups,
 * top-level navigation, payment, geolocation, notification, clipboard, camera,
 * or microphone permissions. This cannot remove in-frame ads. Every reviewed
 * route uses this policy; only records marked `unsandboxed` opt out.
 */
export const PLAYER_IFRAME_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-presentation',
].join(' ');

/**
 * Wildcard feature delegation is required so nested/redirected player iframes
 * retain fullscreen and media rights. Deliberately no clipboard, camera,
 * microphone, geolocation, payment, or popup capability is delegated.
 */
export const PLAYER_IFRAME_ALLOW = [
  'autoplay *',
  'encrypted-media *',
  'picture-in-picture *',
  'fullscreen *',
].join('; ');

export const PLAYER_IFRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * Third-party external embed registry (2026-11-17 revision).
 * AALAM does not host media and cannot verify stream availability, resolution,
 * ads, title availability, licensing, or a title-specific audio track.
 *
 * Naming: every server carries a gemstone name, most brilliant first, so the
 * best-tested route always gets the most precious name (Sapphire, AALAM's
 * brand blue, is the default). The provider's own name is diagnostic only.
 * The Hindi Server is deliberately named for what it does instead.
 *
 * Lineup and order follow StreamVault's real-playback test (2026-11-12,
 * nine titles across Hollywood, anime, Japanese and Indian cinema and TV):
 *   Sapphire  Vidy        4K/1080p, posts MEDIA_DATA ~1/s
 *   Ruby      VidFast     1080p/4K, posts PLAYER_EVENT / MEDIA_DATA
 *   Emerald   VidSpark    1080p, AALAM's reviewed, sandboxed route
 *   Topaz     VidLink     1080p, posts PLAYER_EVENT / MEDIA_DATA
 *   Amethyst  VidZee      480p–1080p, posts PLAYER_EVENT / MEDIA_DATA
 *   Opal      VidSrc.pk   720p–1080p, no telemetry (stalled 5/17 runs)
 *   Onyx      VidCore     480p–1080p, AALAM's reviewed, sandboxed last resort
 *   Pearl     Videasy     manual desktop test (Android TV issue reported)
 *
 * Sandbox: the StreamVault-sourced players refuse any sandboxed frame, so
 * they are `unsandboxed` (an explicit product decision that accepts possible
 * popup/redirect ads). The Hindi Server (ScreenScape) is also unsandboxed by
 * explicit decision; Emerald, Onyx and Pearl keep the restrictive sandbox.
 *
 * Dropped by StreamVault and intentionally absent here: 111movies (redirects
 * to vidmario), player.videasy.to (self-signed certificate), vidsrc.pm (404),
 * nontongo.win (dead Play button), vidrock (scam ad on first click) and
 * vidup.to (failed 3/9 titles). Embed.su, AutoEmbed and MovieAPI remain
 * removed after timeout/DNS reports.
 */
const STREAMVAULT_FRAME = { unsandboxed: true, kind: 'embed' as const };

export const THIRD_PARTY_SOURCES: EmbedSourceOption[] = [
  {
    id: 'screenscape',
    name: 'Hindi Server',
    label: 'Hindi Server · Hindi audio',
    providerName: 'ScreenScape',
    badge: 'Hindi',
    dedicatedAudio: 'hi',
    // No telemetry: a manual pick shows an honest "not confirmed" note
    // instead of an endless spinner (never a playback verdict).
    manualTestTimeoutMs: 15000,
    // Unsandboxed by explicit product decision (like the StreamVault players):
    // the sandbox was the likely cause of ScreenScape hanging on load.
    unsandboxed: true,
    quality: 'HD',
    seekSupport: 'good',
    description:
      'Hindi dubbed audio when available',
    kind: 'embed',
    frameOrigin: 'https://web.screenscape.fun',
    extraFrameOrigins: ['https://*.screenscape.fun'],
    audioSelection: {
      kind: 'url-language',
      parameter: 'lan',
      valueFormat: 'provider-label',
      documentedLanguages: ['hi', 'en', 'fr'],
      values: { hi: 'hindi', en: 'eng', fr: 'french' },
    },
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://web.screenscape.fun/embed?tmdb=${tmdbId}&type=movie`
        : `https://web.screenscape.fun/embed?tmdb=${tmdbId}&type=tv&s=${season}&e=${episode}`,
  },
  {
    id: 'vidy',
    name: 'Sapphire',
    label: 'Sapphire · 4K',
    providerName: 'Vidy',
    badge: '4K',
    ...STREAMVAULT_FRAME,
    quality: '4K / 1080p',
    seekSupport: 'excellent',
    description: 'Most reliable · up to 4K',
    playbackStartMessageTypes: ['MEDIA_DATA', 'PLAYER_EVENT'],
    messageOrigins: ['https://www.vidy.st', 'https://vidy.st'],
    frameOrigin: 'https://www.vidy.st',
    extraFrameOrigins: ['https://vidy.st', 'https://*.vidy.st'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://www.vidy.st/movie/${tmdbId}?autoplay=true&color=2563EB`
        : `https://www.vidy.st/tv/${tmdbId}/${season}/${episode}?autoplay=true&color=2563EB`,
  },
  {
    id: 'vidfast',
    name: 'Ruby',
    label: 'Ruby · 1080p',
    providerName: 'VidFast',
    ...STREAMVAULT_FRAME,
    quality: '1080p / 4K',
    seekSupport: 'excellent',
    description: 'Fast start · 1080p',
    playbackStartMessageTypes: ['MEDIA_DATA', 'PLAYER_EVENT'],
    messageOrigins: ['https://vidfast.vc'],
    frameOrigin: 'https://vidfast.vc',
    extraFrameOrigins: ['https://*.vidfast.vc'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://vidfast.vc/movie/${tmdbId}?autoPlay=true`
        : `https://vidfast.vc/tv/${tmdbId}/${season}/${episode}?autoPlay=true`,
  },
  {
    id: 'vidspark',
    name: 'Emerald',
    label: 'Emerald · 1080p',
    providerName: 'VidSpark',
    ...STREAMVAULT_FRAME,
    quality: '1080p',
    seekSupport: 'excellent',
    description: 'Reliable 1080p',
    taggedProgressMessages: true,
    messageOrigins: ['https://vidspark.to'],
    frameOrigin: 'https://vidspark.to',
    extraFrameOrigins: ['https://*.vidspark.to'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://vidspark.to/movie/${tmdbId}`
        : `https://vidspark.to/tv/${tmdbId}/${season}/${episode}`,
  },
  {
    id: 'vidlink',
    name: 'Topaz',
    label: 'Topaz · 1080p',
    providerName: 'VidLink',
    ...STREAMVAULT_FRAME,
    quality: '1080p',
    seekSupport: 'excellent',
    description: 'Dependable 1080p, good for series',
    playbackStartMessageTypes: ['MEDIA_DATA', 'PLAYER_EVENT'],
    messageOrigins: ['https://vidlink.pro'],
    frameOrigin: 'https://vidlink.pro',
    extraFrameOrigins: ['https://*.vidlink.pro'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://vidlink.pro/movie/${tmdbId}?autoplay=true`
        : `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}?autoplay=true`,
  },
  {
    id: 'vidzee',
    name: 'Amethyst',
    label: 'Amethyst · up to 1080p',
    providerName: 'VidZee',
    ...STREAMVAULT_FRAME,
    quality: '480p–1080p',
    seekSupport: 'good',
    description: 'Wide catalogue, mixed quality',
    playbackStartMessageTypes: ['MEDIA_DATA', 'PLAYER_EVENT'],
    messageOrigins: ['https://player.vidzee.wtf'],
    frameOrigin: 'https://player.vidzee.wtf',
    extraFrameOrigins: ['https://*.vidzee.wtf'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://player.vidzee.wtf/embed/movie/${tmdbId}`
        : `https://player.vidzee.wtf/embed/tv/${tmdbId}/${season}/${episode}`,
  },
  {
    id: 'vidsrcpk',
    name: 'Opal',
    label: 'Opal · up to 1080p',
    providerName: 'VidSrc.pk',
    ...STREAMVAULT_FRAME,
    quality: '720p–1080p',
    seekSupport: 'good',
    description: 'Backup option · may stall',
    frameOrigin: 'https://embed.vidsrc.pk',
    extraFrameOrigins: ['https://*.vidsrc.pk', 'https://*.embed.vidsrc.pk'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://embed.vidsrc.pk/movie/${tmdbId}`
        : `https://embed.vidsrc.pk/tv/${tmdbId}/${season}/${episode}`,
  },
  {
    id: 'vidcore',
    name: 'Onyx',
    label: 'Onyx · last resort',
    providerName: 'VidCore',
    ...STREAMVAULT_FRAME,
    quality: '480p–1080p',
    seekSupport: 'good',
    description: 'Try only if others fail',
    frameOrigin: 'https://vidcore.org',
    extraFrameOrigins: ['https://*.vidcore.org'],
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://vidcore.org/embed/movie/${tmdbId}`
        : `https://vidcore.org/embed/tv/${tmdbId}/${season}/${episode}`,
  },
  {
    id: 'videasy',
    name: 'Pearl',
    label: 'Pearl · Desktop',
    providerName: 'Videasy',
    manualOnly: true,
    manualTestLabel: 'Desktop only',
    manualTestTimeoutMs: 16000,
    quality: 'Unknown',
    seekSupport: 'excellent',
    description:
      'Desktop browsers only',
    kind: 'embed',
    reportsPlayback: true,
    playbackStartMessageTypes: ['videasy:play'],
    messageOrigins: ['https://videasy.xyz'],
    frameOrigin: 'https://videasy.xyz',
    audioSelection: {
      kind: 'url-language',
      parameter: 'lang',
      valueFormat: 'iso-639-1',
      documentedLanguages: ['en', 'fr', 'es'],
    },
    buildUrl: ({ tmdbId, type, season = 1, episode = 1 }) =>
      type === 'movie'
        ? `https://videasy.xyz/embed/movie/${tmdbId}?autoplay=true&theme=2563eb`
        : `https://videasy.xyz/embed/tv/${tmdbId}/${season}/${episode}?autoplay=true&theme=2563eb`,
  },
];

/**
 * Sources eligible for background health checks and auto failover, in
 * quality order. A dedicated-audio server (Hindi Server) sits at the end:
 * it is moved to the front only for visitors whose first audio preference is
 * that language (see orderForAudioPreference).
 */
export const AUTOMATIC_EMBED_SOURCES = [
  ...THIRD_PARTY_SOURCES.filter((source) => !source.manualOnly && !source.dedicatedAudio),
  ...THIRD_PARTY_SOURCES.filter((source) => !source.manualOnly && source.dedicatedAudio),
];

export const DEFAULT_SERVER_ID = AUTOMATIC_EMBED_SOURCES[0].id;

const EMBED_SOURCE_ALIASES: Record<string, string> = {
  vidfast_pro: 'vidfast',
  vidlink_pro: 'vidlink',
  vidsrc_pk: 'vidsrcpk',
};

export function resolveEmbedSourceId(id: string | null | undefined): string {
  if (!id) return '';
  return EMBED_SOURCE_ALIASES[id] ?? id;
}

/** The server dedicated to `audio` (e.g. the Hindi Server for `hi`), if any. */
export function getDedicatedAudioSource(
  audio: string | null | undefined
): EmbedSourceOption | null {
  if (!audio) return null;
  return (
    AUTOMATIC_EMBED_SOURCES.find((source) => source.dedicatedAudio === audio) || null
  );
}

/**
 * Re-order automatic route ids for the visitor's first audio preference.
 * The matching dedicated-audio server goes first; every other dedicated
 * server goes last, so an English viewer never lands on a Hindi dub by
 * default but can still reach it as a final fallback (or pick it manually).
 */
export function orderForAudioPreference(
  ids: readonly string[],
  firstAudio: string | null | undefined
): string[] {
  const dedicated = new Map(
    AUTOMATIC_EMBED_SOURCES.filter((source) => source.dedicatedAudio).map((source) => [
      source.id,
      source.dedicatedAudio,
    ])
  );
  const preferred = ids.filter((id) => firstAudio && dedicated.get(id) === firstAudio);
  const regular = ids.filter((id) => !dedicated.has(id));
  const others = ids.filter((id) => dedicated.has(id) && !preferred.includes(id));
  return [...preferred, ...regular, ...others];
}

/** True only when the integration has a URL form for this media type. */
export function supportsEmbedSourceMediaType(
  source: EmbedSourceOption,
  type: MediaType
): boolean {
  return !source.supportedMediaTypes?.length || source.supportedMediaTypes.includes(type);
}

/**
 * Keep automatic selection and recovery inside the reviewed registry. Manual
 * test routes deliberately stay out of detector ranking and auto failover,
 * even when malformed detector data is returned.
 */
export function getApprovedEmbedSourceIds(
  rankedIds: readonly string[] = AUTOMATIC_EMBED_SOURCES.map((source) => source.id)
): string[] {
  const approvedIds = new Set(
    AUTOMATIC_EMBED_SOURCES.map((source) => source.id)
  );
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const id of [
    ...rankedIds,
    ...AUTOMATIC_EMBED_SOURCES.map((source) => source.id),
  ]) {
    if (approvedIds.has(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Returns the next distinct reviewed route for an explicit viewer recovery
 * action. Unlike automatic failover, this deliberately wraps so a viewer can
 * retry after every automatic route has been attempted.
 */
export function getNextApprovedEmbedSource(
  currentId: string,
  rankedIds?: readonly string[],
  allowedIds?: readonly string[],
): { id: string; index: number } | null {
  const ids = getApprovedEmbedSourceIds(rankedIds).filter((id) => !allowedIds || allowedIds.includes(id));
  if (ids.length < 2) return null;
  const currentIndex = ids.indexOf(currentId);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % ids.length;
  return { id: ids[nextIndex], index: nextIndex };
}

export const PLAYER_MESSAGE_ORIGINS: string[] = Array.from(
  new Set(THIRD_PARTY_SOURCES.flatMap((source) => source.messageOrigins ?? []))
);

/**
 * Builds an approved source URL and only adds an audio parameter to a provider
 * with a reviewed default-audio contract. Country values are never guessed or
 * appended: none of the current routes documents a country URL selector.
 */
export function buildEmbedSourceUrl(
  source: EmbedSourceOption,
  params: EmbedUrlParams
): string {
  const base = source.buildUrl(params);
  const selection = source.audioSelection;
  // A dedicated-audio server always asks for its language: picking the Hindi
  // Server is itself the request for Hindi, whatever the profile default.
  const audio = source.dedicatedAudio ?? params.audio;
  if (
    !audio ||
    selection?.kind !== 'url-language' ||
    !selection.documentedLanguages.includes(audio)
  ) {
    return base;
  }

  try {
    const url = new URL(base);
    // Providers can document a human-readable parameter value (`hindi`) rather
    // than accepting ISO-639-1 directly. The mapping lives in the reviewed
    // registry, never in visitor-controlled input.
    url.searchParams.set(
      selection.parameter,
      selection.values?.[audio] || audio
    );
    return url.toString();
  } catch {
    // All current registry entries are HTTPS URLs. Keep a defensive fallback
    // so a malformed future entry does not make the player crash.
    return base;
  }
}

/**
 * Player messages arrive either as objects or as JSON strings (Vidy, VidFast,
 * VidLink and VidZee post `JSON.stringify`-ed payloads). Returns a plain
 * object or null; oversized or malformed strings are ignored.
 */
export function decodePlayerMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    if (data.length > 65536 || !/^\s*\{/.test(data)) return null;
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * Some reviewed players emit a documented start event without timestamp data.
 * WatchView calls this only after verifying the event origin and that it came
 * from the active iframe, so an arbitrary window cannot confirm playback.
 */
export function isDocumentedPlaybackStart(
  source: EmbedSourceOption,
  rawPayload: unknown
): boolean {
  const payload = decodePlayerMessage(rawPayload);
  if (!source.playbackStartMessageTypes?.length || !payload) {
    return false;
  }
  return payload.type === 'videasy:play' && source.playbackStartMessageTypes.includes(payload.type);
}

/**
 * StreamVault's permission list for unsandboxed players: media, fullscreen
 * and motion sensors (used by mobile players for orientation) plus
 * clipboard-write (copy-link buttons). Still no camera, microphone,
 * geolocation or payment delegation.
 */
export const UNSANDBOXED_PLAYER_IFRAME_ALLOW = [
  'accelerometer *',
  'autoplay *',
  'clipboard-write *',
  'encrypted-media *',
  'gyroscope *',
  'picture-in-picture *',
  'fullscreen *',
].join('; ');

/** These providers check the embedding domain, so they need the origin. */
export const UNSANDBOXED_PLAYER_REFERRER_POLICY = 'origin';

export type EmbedFrameProps = {
  sandbox?: string;
  allow: string;
  referrerPolicy: 'strict-origin-when-cross-origin' | 'origin';
};

/**
 * Browser iframe attributes per source. Reviewed routes share one restrictive
 * sandbox; `unsandboxed` sources omit the attribute entirely (an empty or
 * partial sandbox breaks them) and get StreamVault's allow list.
 */
export function getEmbedFrameProps(source: EmbedSourceOption): EmbedFrameProps {
  if (source.unsandboxed) {
    return {
      allow: UNSANDBOXED_PLAYER_IFRAME_ALLOW,
      referrerPolicy: UNSANDBOXED_PLAYER_REFERRER_POLICY,
    };
  }
  return {
    sandbox: PLAYER_IFRAME_SANDBOX,
    allow: PLAYER_IFRAME_ALLOW,
    referrerPolicy: PLAYER_IFRAME_REFERRER_POLICY,
  };
}

export function buildYoutubeEmbedUrl(youtubeKey: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}?rel=0&modestbranding=1`;
}
