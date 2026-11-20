import type { MediaItem, PaginatedResult } from '@/types/media';

/**
 * Compact wire format for MediaItems embedded in cached HTML / RSC payloads.
 *
 * Every server-rendered rail item used to carry three long, fully derivable
 * strings (poster srcset, backdrop srcset, 780w backdrop thumb ≈ 550 bytes,
 * escaped twice in the inline RSC script). `compactMediaItem` drops a field
 * only when `expandMediaItem` regenerates exactly the same string, so the
 * round trip is lossless; the optional synopsis trim is the only lossy step
 * and is used for rail cards whose hover preview clamps to two lines anyway.
 *
 * Pure and dependency-free (shared by server pages and client views).
 */

const TMDB_IMG = 'https://image.tmdb.org/t/p/';
const TMDB_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w\d+(\/[^/?#\s]+)$/;

function tmdbPath(url: string | undefined): string | null {
  const match = url ? TMDB_URL.exec(url) : null;
  return match ? match[1] : null;
}

function posterSrcSetFor(path: string): string {
  return [185, 342, 500].map((w) => `${TMDB_IMG}w${w}${path} ${w}w`).join(', ');
}

function backdropSrcSetFor(path: string): string {
  return [300, 780, 1280].map((w) => `${TMDB_IMG}w${w}${path} ${w}w`).join(', ');
}

/** Derived image fields for an item, computed from posterUrl / backdropUrl. */
function derived(item: Pick<MediaItem, 'posterUrl' | 'backdropUrl'>) {
  const poster = tmdbPath(item.posterUrl);
  const backdrop = tmdbPath(item.backdropUrl);
  return {
    posterSrcSet: poster ? posterSrcSetFor(poster) : undefined,
    backdropSrcSet: backdrop ? backdropSrcSetFor(backdrop) : undefined,
    backdropThumbUrl: backdrop ? `${TMDB_IMG}w780${backdrop}` : undefined,
  };
}

export function trimSynopsis(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type WireMediaItem = Omit<MediaItem, 'backdropThumbUrl'> & {
  backdropThumbUrl?: string;
};

export function compactMediaItem(
  item: MediaItem,
  { synopsisChars }: { synopsisChars?: number } = {}
): WireMediaItem {
  const d = derived(item);
  const wire: WireMediaItem = { ...item };
  if (d.posterSrcSet && wire.posterSrcSet === d.posterSrcSet) delete wire.posterSrcSet;
  if (d.backdropSrcSet && wire.backdropSrcSet === d.backdropSrcSet) delete wire.backdropSrcSet;
  if (d.backdropThumbUrl && wire.backdropThumbUrl === d.backdropThumbUrl) delete wire.backdropThumbUrl;
  if (wire.tagline === undefined) delete wire.tagline;
  if (synopsisChars) wire.overview = trimSynopsis(wire.overview, synopsisChars);
  return wire;
}

export function expandMediaItem(wire: WireMediaItem | MediaItem): MediaItem {
  if (wire.posterSrcSet && wire.backdropSrcSet && wire.backdropThumbUrl) {
    return wire as MediaItem;
  }
  const d = derived(wire);
  return {
    ...wire,
    posterSrcSet: wire.posterSrcSet ?? d.posterSrcSet,
    backdropSrcSet: wire.backdropSrcSet ?? d.backdropSrcSet,
    backdropThumbUrl: wire.backdropThumbUrl ?? d.backdropThumbUrl ?? wire.backdropUrl,
  };
}

/** Rail cards show ≤2 lines of synopsis (hover preview); keep a little slack. */
export const RAIL_SYNOPSIS_CHARS = 220;

/**
 * Compacts several lists while preserving object identity for items that
 * appear in more than one list (React's RSC serializer then emits a short
 * back-reference instead of a second copy). Lists earlier in `lists` win, so
 * put the hero/featured list first to keep its full synopsis.
 */
export function compactLists<K extends string>(
  lists: Record<K, MediaItem[]>,
  options: Partial<Record<K, { synopsisChars?: number }>> = {}
): Record<K, WireMediaItem[]> {
  const byKey = new Map<string, WireMediaItem>();
  const out = {} as Record<K, WireMediaItem[]>;
  for (const name of Object.keys(lists) as K[]) {
    out[name] = lists[name].map((item) => {
      const key = `${item.type}:${item.id}`;
      const existing = byKey.get(key);
      if (existing) return existing;
      const wire = compactMediaItem(item, options[name]);
      byKey.set(key, wire);
      return wire;
    });
  }
  return out;
}

/** A feed/result object whose MediaItem fields are in wire form. */
export type WireOf<T> = {
  [K in keyof T]: T[K] extends MediaItem[]
    ? WireMediaItem[]
    : T[K] extends MediaItem | null
      ? WireMediaItem | null
      : T[K];
};

function isMediaLike(value: unknown): value is WireMediaItem {
  return Boolean(value && typeof value === 'object' && 'posterUrl' in value && 'type' in value);
}

/**
 * Compacts every MediaItem list / single item on a feed object. `primary`
 * names the list whose items keep a full synopsis (the hero carousel); single
 * items (e.g. the editor's pick) also keep it. Those are processed first so
 * items shared with a rail keep identity *and* full text.
 */
export function compactFeed<T extends object>(feed: T, primary?: keyof T): WireOf<T> {
  const entries = Object.entries(feed) as Array<[keyof T & string, unknown]>;
  const lists: Record<string, MediaItem[]> = {};
  const options: Record<string, { synopsisChars?: number }> = {};
  // Full-synopsis entries first (primary list, then single featured items such
  // as the editor's pick) so an item shared with a rail keeps its full text.
  const keys = entries.map(([k]) => k as string);
  const isSingle = (k: string) => isMediaLike((feed as Record<string, unknown>)[k]);
  const order = [
    ...(primary ? [String(primary)] : []),
    ...keys.filter((k) => k !== primary && isSingle(k)),
    ...keys.filter((k) => k !== primary && !isSingle(k)),
  ];
  for (const key of order) {
    const value = (feed as Record<string, unknown>)[key];
    if (Array.isArray(value) && value.every(isMediaLike)) {
      lists[key] = value as MediaItem[];
      if (key !== primary) options[key] = { synopsisChars: RAIL_SYNOPSIS_CHARS };
    } else if (isMediaLike(value)) {
      lists[key] = [value as MediaItem];
    }
  }
  const compacted = compactLists(lists, options);
  const out: Record<string, unknown> = { ...(feed as Record<string, unknown>) };
  for (const [key, list] of Object.entries(compacted)) {
    out[key] = Array.isArray((feed as Record<string, unknown>)[key]) ? list : list[0];
  }
  return out as WireOf<T>;
}

export function expandFeed<T extends object>(wire: WireOf<T>): T {
  const out: Record<string, unknown> = { ...wire };
  for (const [key, value] of Object.entries(wire)) {
    if (Array.isArray(value) && value.length && value.every(isMediaLike)) {
      out[key] = value.map(expandMediaItem);
    } else if (isMediaLike(value)) {
      out[key] = expandMediaItem(value);
    }
  }
  return out as T;
}

export function compactResult(result: PaginatedResult): WireOf<PaginatedResult> {
  return compactFeed(result);
}

export function expandResult(result: WireOf<PaginatedResult>): PaginatedResult {
  return expandFeed<PaginatedResult>(result);
}
