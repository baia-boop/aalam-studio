import { unstable_cache } from 'next/cache';
import { fetchRegionalServices } from '@/server/discovery/catalogue';
import type { ServiceProvider } from '@/lib/service-catalogue';
import type { WatchRegion } from '@/lib/watch-regions';

/**
 * A country's streaming roster changes when a service launches or leaves a
 * market — weeks, not minutes. Cache it for a day so the services strip can be
 * server-rendered on every request without paying TMDB latency, and so the very
 * first paint already has logos instead of skeleton tiles.
 */
export const SERVICE_ROSTER_REVALIDATE_SECONDS = 60 * 60 * 24;

const cachedRegionalServices = unstable_cache(
  async (region: WatchRegion) => fetchRegionalServices(region),
  ['regional-service-roster'],
  { revalidate: SERVICE_ROSTER_REVALIDATE_SECONDS, tags: ['regional-services'] }
);

/**
 * Providers for one market, or `null` when TMDB is unavailable. A missing
 * roster is a normal state (the strip renders its "no services" line) and must
 * never take the page down with it.
 */
export async function getRegionalServices(region: WatchRegion): Promise<ServiceProvider[] | null> {
  try {
    const { providers } = await cachedRegionalServices(region);
    return providers;
  } catch {
    return null;
  }
}
