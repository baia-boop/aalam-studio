import 'server-only';

import { THIRD_PARTY_SOURCES, supportsEmbedSourceMediaType } from '@/lib/embed-sources';
import type { PlaybackGrants } from '@/lib/playability';
import type { MediaType } from '@/types/media';

/** Deployment-owned confirmation that an existing player route serves an
 * authorized title in every market. A TV grant covers every released episode.
 * A manual-only route grant never qualifies a title for automatic Play. No tokens,
 * watch-provider IDs or external URLs belong in this file or output. */
export function parsePlaybackGrants(value: string | undefined): PlaybackGrants {
  const grants: Record<string, string[]> = {};
  for (const part of (value ?? '').split(',')) {
    const match = /^((movie|tv):[1-9]\d{0,8})=([a-z0-9]+(?:\+[a-z0-9]+)*)$/.exec(part.trim());
    if (!match) continue;
    const [, key, type, routeList] = match;
    const eligible = new Set(THIRD_PARTY_SOURCES
      .filter((source) => supportsEmbedSourceMediaType(source, type as MediaType))
      .map((source) => source.id));
    const approved = routeList.split('+').filter((id) => eligible.has(id));
    if (approved.length) grants[key] = [...new Set([...(grants[key] ?? []), ...approved])];
  }
  return grants;
}

export function getAuthorizedPlaybackGrants(): PlaybackGrants {
  return parsePlaybackGrants(process.env.AALAM_AUTHORIZED_PLAYBACK);
}
