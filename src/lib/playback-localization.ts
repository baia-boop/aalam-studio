import {
  normalizeWatchRegion,
  type WatchRegion,
} from '@/lib/watch-regions';

/**
 * A deliberately small vocabulary for audio hints that the approved embed
 * registry can currently document. A hint is never proof that a title carries
 * a dubbed track; the external player remains the authority for availability.
 */
const PLAYBACK_AUDIO_LANGUAGE_OPTIONS = [
  { value: 'hi', label: 'Hindi' },
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'Arabic' },
  { value: 'tr', label: 'Turkish' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'id', label: 'Indonesian' },
  { value: 'pt', label: 'Portuguese' },
] as const;

export type PlaybackAudioCode =
  (typeof PLAYBACK_AUDIO_LANGUAGE_OPTIONS)[number]['value'];

/**
 * Explicit choices exposed in Profile. They are intentionally limited to
 * languages with an auditable preference contract in the current registry.
 */
export const PLAYBACK_AUDIO_OPTIONS = [
  { value: 'auto', label: 'Auto (language + content country)' },
  ...PLAYBACK_AUDIO_LANGUAGE_OPTIONS.filter(
    (option) => option.value === 'hi' || option.value === 'en'
  ),
] as const;

export type PlaybackAudioPreference =
  (typeof PLAYBACK_AUDIO_OPTIONS)[number]['value'];

const PLAYBACK_AUDIO_PREFERENCE_CODES = new Set<PlaybackAudioPreference>(
  PLAYBACK_AUDIO_OPTIONS.map((option) => option.value)
);

/**
 * Only these language hints have a documented route preference today. Keeping
 * this list narrow avoids pretending that an English-only route carries (for
 * example) Arabic merely because an IP address is in an Arabic-speaking region.
 */
const AUDITABLE_AUTO_AUDIO_CODES = new Set<PlaybackAudioCode>([
  'hi',
  'en',
]);

/**
 * Country is a fallback—not a proxy for a person's language. Pakistan uses
 * Hindi audio (the same dub track widely used in India), followed by
 * English. A browser that explicitly prefers Hindi can move that compatible
 * preference ahead of the country default, while an explicit Profile choice
 * always wins.
 */
const REGION_AUDIO_ORDER: Partial<
  Record<WatchRegion, readonly PlaybackAudioCode[]>
> = {
  PK: ['hi', 'en'],
  IN: ['hi', 'en'],
};

export type PlaybackAudioSource =
  | 'explicit'
  | 'browser-language'
  | 'region'
  | 'fallback';

export type PlaybackLocalization = {
  region: WatchRegion;
  audio: PlaybackAudioCode;
  /** Ordered candidates used only to rank integrations with declared support. */
  audioCandidates: readonly PlaybackAudioCode[];
  label: string;
  isExplicit: boolean;
  source: PlaybackAudioSource;
};

export type LocalizedEmbedDescriptor = {
  /** ISO-639-1 audio tracks explicitly supported by the integration. */
  audioLanguages?: readonly string[];
  /**
   * A documented URL mechanism to request a language, without asserting that
   * every title has that track. It scores below explicitly declared tracks.
   */
  audioSelection?: {
    kind: 'url-language';
    /** URL-language values specifically documented by the integration. */
    documentedLanguages?: readonly string[];
  };
  /** Regional routing hints explicitly supported by the integration. */
  regionHints?: readonly string[];
};

export function isPlaybackAudioPreference(
  value: string | null | undefined
): value is PlaybackAudioPreference {
  return (
    typeof value === 'string' &&
    PLAYBACK_AUDIO_PREFERENCE_CODES.has(value as PlaybackAudioPreference)
  );
}

export function normalizePlaybackAudioPreference(
  value: string | null | undefined
): PlaybackAudioPreference {
  return isPlaybackAudioPreference(value) ? value : 'auto';
}

export function playbackAudioLabel(
  code: PlaybackAudioCode | PlaybackAudioPreference
): string {
  if (code === 'auto') return 'Auto (language + content country)';
  return (
    PLAYBACK_AUDIO_LANGUAGE_OPTIONS.find((option) => option.value === code)
      ?.label || 'English'
  );
}

function dedupeAudioCodes(codes: readonly PlaybackAudioCode[]): PlaybackAudioCode[] {
  return [...new Set(codes)];
}

/**
 * Extract usable language hints from Accept-Language or navigator.languages.
 * English alone does not override a country fallback: browsers commonly ship
 * with English UI language even when that is not the viewer's playback choice.
 */
export function getBrowserPlaybackAudioCandidates(
  languages: string | readonly string[] | null | undefined
): PlaybackAudioCode[] {
  const raw: readonly string[] = Array.isArray(languages)
    ? languages
    : typeof languages === 'string'
      ? languages.split(',')
      : [];

  const candidates = raw
    .map((entry, index) => {
      const [language, ...parameters] = entry.trim().toLowerCase().split(';');
      const code = language?.trim().split('-', 1)[0];
      const qualityParameter = parameters.find((parameter) =>
        parameter.trim().startsWith('q=')
      );
      const quality = qualityParameter
        ? Number(qualityParameter.trim().slice(2))
        : 1;
      return {
        code,
        index,
        quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
      };
    })
    .filter(
      (candidate): candidate is { code: PlaybackAudioCode; index: number; quality: number } =>
        candidate.quality > 0 &&
        Boolean(candidate.code) &&
        AUDITABLE_AUTO_AUDIO_CODES.has(candidate.code as PlaybackAudioCode)
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((candidate) => candidate.code);

  return dedupeAudioCodes(candidates);
}

export function getPlaybackLocalization(
  regionInput: string | null | undefined,
  preferenceInput: string | null | undefined = 'auto',
  browserLanguages?: string | readonly string[] | null
): PlaybackLocalization {
  const region = normalizeWatchRegion(regionInput || 'US');
  const preference = normalizePlaybackAudioPreference(preferenceInput);
  const regionOrder = REGION_AUDIO_ORDER[region] || ['en'];
  const browserOrder = getBrowserPlaybackAudioCandidates(browserLanguages);
  const browserRegionalOrder = browserOrder.filter((code) => code !== 'en');
  const isExplicit = preference !== 'auto';

  const audioCandidates = isExplicit
    ? dedupeAudioCodes([
        preference,
        ...browserRegionalOrder.filter((code) => code !== preference),
        ...regionOrder.filter((code) => code !== preference),
        ...browserOrder.filter((code) => code !== preference),
        'en',
      ])
    : dedupeAudioCodes([
        ...browserRegionalOrder,
        ...regionOrder,
        ...browserOrder,
        'en',
      ]);
  const audio = audioCandidates[0] || 'en';
  const source: PlaybackAudioSource = isExplicit
    ? 'explicit'
    : browserRegionalOrder.length > 0
      ? 'browser-language'
      : REGION_AUDIO_ORDER[region]
        ? 'region'
        : 'fallback';

  return {
    region,
    audio,
    audioCandidates,
    label: isExplicit ? playbackAudioLabel(preference) : `${playbackAudioLabel(audio)} first`,
    isExplicit,
    source,
  };
}

/**
 * Select the exact URL-language request a provider has documented. An explicit
 * Profile choice and a leading browser language are never silently replaced.
 * Only coarse region auto-routing may use its second regional candidate (for
 * example, Hindi as the Pakistan default); the neutral English tail is not used
 * to promote an unrelated provider.
 */
export function getDocumentedUrlAudioRequest(
  source: LocalizedEmbedDescriptor,
  localization: PlaybackLocalization
): PlaybackAudioCode | null {
  if (source.audioSelection?.kind !== 'url-language') return null;

  const candidates =
    localization.isExplicit || localization.source !== 'region'
      ? [localization.audio]
      : localization.audioCandidates.slice(0, 2);
  return (
    candidates.find((candidate) =>
      source.audioSelection?.documentedLanguages?.includes(candidate)
    ) || null
  );
}

/**
 * Score only documented integration capabilities. A route with regional hints
 * is deliberately penalized outside those regions so a Pakistan-focused route
 * cannot outrank a broadly compatible English/Hindi route in unrelated markets.
 */
export function localizationScore(
  source: LocalizedEmbedDescriptor,
  localization: PlaybackLocalization
): number {
  let score = 0;
  const languages = source.audioLanguages || [];
  const audioIndex = localization.audioCandidates.findIndex((candidate) =>
    languages.includes(candidate)
  );
  if (audioIndex >= 0) {
    // A documented preference outweighs small latency differences, while a
    // healthy source always beats an unavailable one in the caller.
    score += Math.max(90, 680 - audioIndex * 150);
  } else if (source.audioSelection?.kind === 'url-language') {
    const requestedAudio = getDocumentedUrlAudioRequest(source, localization);
    // English is every player's default track, so a route that merely
    // accepts `lang=en` gains nothing over one that plays English anyway.
    // Without this, a last-resort route would outrank the best servers for
    // every English viewer.
    if (requestedAudio && requestedAudio !== 'en') {
      const candidateIndex = localization.audioCandidates.indexOf(requestedAudio);
      // A first-choice documented request is strongest. A lower score is
      // allowed only for the second coarse-region candidate, never for an
      // explicit choice or the generic English tail.
      score += candidateIndex === 0 ? 440 : 320;
    }
  }

  const regionHints = source.regionHints || [];
  if (regionHints.length) {
    score += regionHints.includes(localization.region) ? 140 : -420;
  }
  return score;
}
