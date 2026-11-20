import { readCatalogueRouteParams, type RouteSearchParams } from '@/lib/catalogue-route';
import { getTmdbGenreFilterId } from '@/lib/genres';

/**
 * Query-string variants of the catalogue landings (/movies?genre=Action,
 * /series?sort=top_rated&page=2, …) are cacheable too.
 *
 * A page that reads `searchParams` is always rendered per request, so the
 * middleware rewrites any *meaningful* catalogue query onto a path-based,
 * ISR-cached route: `/catalogue-variant/<section>/<variant>`, where `variant`
 * is a base64url-encoded, normalised query. The visitor's URL is unchanged.
 *
 * Normalisation is what keeps the cache bounded and correct:
 * - only parameters that change the content survive (genre, sort, avail/src,
 *   local, page); unknown and tracking parameters are dropped;
 * - values are clamped exactly as the page would (sort whitelist, page ≤ 500);
 *   only known genres/services survive; documentaries ignore genre;
 * - a query equal to the defaults returns null → the bare cached landing.
 *
 * This module is edge-safe (used by middleware) and has no server imports.
 */

export const CATALOGUE_SECTIONS = {
  movies: 'movie',
  series: 'tv',
  documentaries: 'documentary',
} as const;

export type CatalogueSection = keyof typeof CATALOGUE_SECTIONS;
export type CatalogueSectionMode = (typeof CATALOGUE_SECTIONS)[CatalogueSection];

export const CATALOGUE_VARIANT_PREFIX = '/catalogue-variant';

export function isCatalogueSection(value: string): value is CatalogueSection {
  return Object.prototype.hasOwnProperty.call(CATALOGUE_SECTIONS, value);
}

/** Canonical query string (no leading "?") for a catalogue request, or "" for defaults. */
export function normalizeCatalogueQuery(
  section: CatalogueSection,
  params: RouteSearchParams
): string {
  const mode = CATALOGUE_SECTIONS[section];
  const route = readCatalogueRouteParams(params, mode);
  const query = new URLSearchParams();
  // Unknown genres do not change the listing: dropping them keeps
  // the cache key space bounded and sends junk values to the bare landing.
  if (route.genre && mode !== 'documentary' && getTmdbGenreFilterId(mode, route.genre)) query.set('genre', route.genre);
  if (route.local) query.set('local', '1');
  if (route.sort !== 'popularity') query.set('sort', route.sort);
  if (route.onlyWithSources) query.set('avail', '1');
  if (route.page !== 1) query.set('page', String(route.page));
  return query.toString();
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Variant segment for a request, or null when the bare landing applies. */
export function encodeCatalogueVariant(
  section: CatalogueSection,
  search: URLSearchParams
): string | null {
  const params: RouteSearchParams = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    params[key] = values.length > 1 ? values : values[0];
  }
  const normalized = normalizeCatalogueQuery(section, params);
  return normalized ? toBase64Url(normalized) : null;
}

/**
 * Decodes a variant segment back to route search params. Returns null for
 * malformed or non-normalised segments, so hand-crafted URLs cannot create
 * extra cache entries (the route 404s instead).
 */
export function decodeCatalogueVariant(
  section: CatalogueSection,
  variant: string
): RouteSearchParams | null {
  const query = fromBase64Url(variant);
  if (!query) return null;
  const search = new URLSearchParams(query);
  const params: RouteSearchParams = Object.fromEntries(search.entries());
  if (normalizeCatalogueQuery(section, params) !== query) return null;
  return params;
}

/** Maps the internal rewrite target back to its public landing path. */
export function publicPathFromInternal(pathname: string): string {
  if (!pathname.startsWith(`${CATALOGUE_VARIANT_PREFIX}/`)) return pathname;
  const section = pathname.slice(CATALOGUE_VARIANT_PREFIX.length + 1).split('/')[0] || '';
  return isCatalogueSection(section) ? `/${section}` : pathname;
}
