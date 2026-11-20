import { TMDB_MAX_PAGES } from '@/lib/pagination';
import type { WatchRegion } from '@/lib/watch-regions';
import type { MediaType } from '@/types/media';

export type ServiceProvider = {
  id: number;
  name: string;
  logoPath: string | null;
  types: MediaType[];
  priority: number;
};

type TmdbProviderRow = {
  provider_id?: unknown;
  provider_name?: unknown;
  logo_path?: unknown;
  display_priority?: unknown;
  display_priorities?: Record<string, unknown>;
};

export const SERVICE_SORTS = ['popular', 'top_rated', 'newest'] as const;
export type ServiceSort = (typeof SERVICE_SORTS)[number];
export const SERVICE_SORT_LABELS: Record<ServiceSort, string> = {
  popular: 'Most popular',
  top_rated: 'Highest rated',
  newest: 'Newest first',
};
export const DISCOVERY_LANGUAGE = 'en-US'; // AALAM's metadata/UI language, not a restriction on original language.
export const SUBSCRIPTION_TYPE = 'flatrate';

const NAME_ALIASES: Readonly<Record<string, string>> = {
  'prime video': 'Prime Video',
  'amazon prime video': 'Prime Video',
  'hbo max': 'HBO Max',
  'max': 'HBO Max',
  'disney plus': 'Disney+',
  'apple tv plus': 'Apple TV+',
};

const nameKey = (value: string) => value.normalize('NFKD').toLowerCase()
  .replace(/\p{M}/gu, '').replace(/\+/g, ' plus ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function displayName(value: string) {
  const key = nameKey(value);
  return Object.hasOwn(NAME_ALIASES, key) ? NAME_ALIASES[key] : value;
}

export function parseProviderId(value: unknown): number | null {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^[1-9]\d{0,8}$/.test(text) ? Number(text) : null;
}

/** Both TMDB lists are scoped to the same watch_region. IDs, not logos or
 * aliases, merge the two media halves. Distinct channel/store IDs stay distinct. */
export function mergeServiceProviders(region: WatchRegion, movie: unknown[], tv: unknown[]): ServiceProvider[] {
  const byId = new Map<number, ServiceProvider>();
  const consume = (rows: unknown[], type: MediaType) => {
    for (const value of rows) {
      if (!value || typeof value !== 'object') continue;
      const row = value as TmdbProviderRow;
      const id = parseProviderId(row.provider_id);
      const name = typeof row.provider_name === 'string' ? row.provider_name.trim() : '';
      if (!id || !name || name.length > 150) continue;
      const priority = [row.display_priorities?.[region], row.display_priority]
        .find((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) ?? Number.MAX_SAFE_INTEGER;
      const logoPath = typeof row.logo_path === 'string' && /^\/[\w-]+\.(png|jpe?g|webp)$/i.test(row.logo_path)
        ? row.logo_path : null;
      const known = byId.get(id);
      if (known) {
        if (!known.types.includes(type)) known.types.push(type);
        known.priority = Math.min(known.priority, priority);
        known.logoPath ??= logoPath;
      } else {
        byId.set(id, { id, name: displayName(name), logoPath, types: [type], priority });
      }
    }
  };
  consume(movie, 'movie');
  consume(tv, 'tv');
  return [...byId.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'en') || a.id - b.id);
}

export function isServiceSlug(value: string): boolean {
  // Numeric IDs are canonical. Accept old named bookmarks without retaining a roster of IDs.
  return parseProviderId(value) !== null || /^[a-z][a-z0-9-]{0,79}$/i.test(value);
}

export function resolveServiceProvider(providers: readonly ServiceProvider[], slug: string): ServiceProvider | undefined {
  const id = parseProviderId(slug);
  if (id) return providers.find((service) => service.id === id);
  const alias = nameKey(displayName(slug));
  const matches = providers.filter((service) => nameKey(service.name) === alias);
  return matches.length === 1 ? matches[0] : undefined;
}

export function normalizeServiceType(value?: string | null): MediaType | undefined {
  if (value === 'movie' || value === 'movies') return 'movie';
  if (value === 'tv' || value === 'series' || value === 'shows') return 'tv';
  return undefined; // no format selected yet (also migrates old ?type=all links)
}

export function isServiceSort(value: unknown): value is ServiceSort {
  return (SERVICE_SORTS as readonly unknown[]).includes(value);
}

export function normalizeServiceSort(value?: string | null): ServiceSort {
  return isServiceSort(value) ? value : 'popular';
}

export function parseDiscoveryPage(value: string): number | null {
  if (!/^[1-9]\d{0,2}$/.test(value)) return null;
  const page = Number(value);
  return page <= TMDB_MAX_PAGES ? page : null;
}

export function serviceHref(id: number, { type, sort = 'popular', page = 1 }: { type?: MediaType; sort?: ServiceSort; page?: number } = {}) {
  const query = new URLSearchParams();
  if (type) query.set('type', type);
  if (sort !== 'popular') query.set('sort', sort);
  if (page > 1) query.set('page', String(page));
  return `/service/${id}${query.size ? `?${query}` : ''}`;
}

/** Only included subscriptions. Storefront-only services may have no results.
 * TMDB supplies title metadata and provider indexing, never playback rights. */
export function serviceDiscoverParams({ region, providerId, type, sort, page, today = new Date().toISOString().slice(0, 10) }: {
  region: WatchRegion;
  providerId: number;
  type: MediaType;
  sort: ServiceSort;
  page: number;
  today?: string;
}): Record<string, string | number> {
  const params: Record<string, string | number> = {
    language: DISCOVERY_LANGUAGE,
    include_adult: 'false',
    watch_region: region,
    with_watch_providers: String(providerId),
    with_watch_monetization_types: SUBSCRIPTION_TYPE,
    sort_by: 'popularity.desc',
    page,
  };
  if (sort === 'top_rated') {
    params.sort_by = 'vote_average.desc';
    params['vote_count.gte'] = type === 'movie' ? 200 : 50;
  } else if (sort === 'newest') {
    const date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    params.sort_by = `${date}.desc`;
    params[`${date}.lte`] = today;
  }
  return params;
}
