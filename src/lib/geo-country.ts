import {
  isWatchRegion,
  normalizeWatchRegion,
  regionFromAcceptLanguage,
  type WatchRegion,
} from '@/lib/watch-regions';

/**
 * These headers are populated from the viewer IP by common CDNs. Deployments
 * must only trust headers injected by their edge/proxy and strip client-sent
 * copies before the application receives a request.
 */
export const GEO_COUNTRY_HEADERS = [
  'x-vercel-ip-country',
  'cf-ipcountry',
  'cloudfront-viewer-country',
  'fly-client-country',
  'x-country-code',
  'x-geo-country',
] as const;

export type GeoCountrySource = 'ip-header' | 'accept-language' | 'default';

export type GeoCountryResolution = {
  country: WatchRegion;
  rawCountry: string | null;
  supported: boolean;
  source: GeoCountrySource;
};

/**
 * Resolve country without transmitting a raw IP to another vendor. A CDN's
 * trusted country header is already derived from the incoming IP; language is
 * only a fallback when no deployment-provided geo header exists.
 */
export function resolveRequestCountry(headers: Headers): GeoCountryResolution {
  for (const headerName of GEO_COUNTRY_HEADERS) {
    const value = headers.get(headerName)?.trim().toUpperCase();
    if (value && /^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1') {
      return {
        country: normalizeWatchRegion(value),
        rawCountry: value,
        supported: isWatchRegion(value),
        source: 'ip-header',
      };
    }
  }

  const fromLanguage = regionFromAcceptLanguage(headers.get('accept-language'));
  if (fromLanguage) {
    return {
      country: fromLanguage,
      rawCountry: fromLanguage,
      supported: true,
      source: 'accept-language',
    };
  }

  return {
    country: 'US',
    rawCountry: null,
    supported: true,
    source: 'default',
  };
}
