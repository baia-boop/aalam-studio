import { isWatchRegion } from '@/lib/watch-regions';
import { parseProviderId } from '@/lib/service-catalogue';
import { ApiError } from '../core/errors';

/**
 * What the public catalogue proxy may request from TMDB.
 *
 * The previous proxy forwarded any path and any query parameter with the
 * server key attached. These allowlists turn it into a catalogue API: only
 * read endpoints the product uses, only known parameters, bounded values.
 */

const PATHS: RegExp[] = [
  /^trending\/(all|movie|tv)\/(day|week)$/,
  /^(movie|tv)\/(popular|top_rated)$/,
  /^movie\/(now_playing|upcoming)$/,
  /^tv\/(on_the_air|airing_today)$/,
  /^discover\/(movie|tv)$/,
  /^search\/(multi|movie|tv|keyword|person|collection)$/,
  // Person/collection-scoped search ("titles with …", "… Collection").
  /^person\/\d{1,9}$/,
  /^collection\/\d{1,9}$/,
  /^(movie|tv)\/\d{1,9}$/,
  /^(movie|tv)\/\d{1,9}\/(videos|similar|recommendations|watch\/providers|credits|keywords|external_ids|release_dates|content_ratings|images|aggregate_credits)$/,
  /^tv\/\d{1,9}\/season\/\d{1,4}$/,
  /^genre\/(movie|tv)\/list$/,
  /^watch\/providers\/(movie|tv|regions)$/,
  /^configuration$/,
];

const PARAMS = new Set([
  'language', 'page', 'region', 'sort_by', 'query', 'include_adult', 'append_to_response', 'timezone',
  'with_genres', 'without_genres', 'with_keywords', 'without_keywords', 'with_people', 'with_cast', 'with_crew',
  'with_companies', 'with_networks', 'with_original_language', 'with_origin_country', 'with_watch_providers',
  'without_watch_providers', 'watch_region', 'with_watch_monetization_types', 'with_release_type', 'with_status',
  'with_type', 'vote_count.gte', 'vote_count.lte', 'vote_average.gte', 'vote_average.lte',
  'primary_release_date.gte', 'primary_release_date.lte', 'release_date.gte', 'release_date.lte',
  'first_air_date.gte', 'first_air_date.lte', 'air_date.gte', 'air_date.lte', 'with_runtime.gte', 'with_runtime.lte',
  'primary_release_year', 'first_air_date_year', 'year', 'include_null_first_air_dates', 'include_video',
  'screened_theatrically', 'include_image_language',
]);

const APPENDABLE = new Set([
  'credits', 'aggregate_credits', 'recommendations', 'similar', 'release_dates', 'content_ratings',
  'watch/providers', 'external_ids', 'videos', 'keywords', 'images', 'combined_credits',
]);

/** Parameter values: printable, no control characters, bounded. */
const SAFE_VALUE = /^[\p{L}\p{N}\p{P}\p{Zs}+|<>=^$`~]*$/u;

export function isAllowedTmdbPath(path: string): boolean {
  return PATHS.some((pattern) => pattern.test(path));
}

export function sanitizeTmdbParams(path: string, input: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of input.entries()) {
    if (key === 'api_key') continue; // never accept a caller-supplied key
    if (!PARAMS.has(key)) {
      throw new ApiError(400, 'PARAM_NOT_ALLOWED', `Query parameter "${key.slice(0, 40)}" is not supported.`);
    }
    const value = rawValue.trim();
    if (value.length > (key === 'query' ? 200 : 300) || !SAFE_VALUE.test(value)) {
      throw new ApiError(400, 'PARAM_INVALID', `Query parameter "${key}" has an invalid value.`);
    }
    if (['watch_region', 'region', 'with_origin_country'].includes(key) && !isWatchRegion(value)) {
      throw new ApiError(400, 'PARAM_INVALID', 'A valid ISO country code is required.');
    }
    if (['with_watch_providers', 'without_watch_providers'].includes(key) && value.split(/[|,]/).some((part) => !parseProviderId(part))) {
      throw new ApiError(400, 'PARAM_INVALID', 'A valid provider ID is required.');
    }
    if (key === 'page') {
      const page = Number(value);
      if (!Number.isInteger(page) || page < 1 || page > 500) {
        throw new ApiError(400, 'PARAM_INVALID', 'page must be an integer between 1 and 500.');
      }
    }
    if (key === 'append_to_response') {
      const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 10 || parts.some((part) => !APPENDABLE.has(part))) {
        throw new ApiError(400, 'PARAM_INVALID', 'append_to_response contains an unsupported section.');
      }
    }
    out[key] = value;
  }
  // Adult content is never requested through this service.
  if ('include_adult' in out || /^(search|discover)\//.test(path)) out.include_adult = 'false';
  return out;
}

/** Freshness policy (seconds) per endpoint family. SWR window is derived from it. */
export function ttlForTmdbPath(path: string): number {
  if (path.startsWith('trending/')) return 15 * 60;
  if (path.startsWith('search/')) return 10 * 60;
  if (path.startsWith('discover/')) return 60 * 60;
  if (/^(movie|tv)\/(popular|top_rated|now_playing|upcoming|on_the_air|airing_today)$/.test(path)) return 60 * 60;
  if (/\/(videos|images)$/.test(path)) return 12 * 60 * 60;
  if (/\/watch\/providers$/.test(path) || path.startsWith('watch/')) return 6 * 60 * 60;
  if (path.startsWith('genre/') || path === 'configuration') return 24 * 60 * 60;
  return 6 * 60 * 60; // title details, seasons, credits, keywords
}
