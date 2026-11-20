export const SITE_NAME = 'AALAM';

/**
 * Product description shared by the root metadata and the web app manifest
 * (the install prompt and OS app listings show it). Keep it to what the
 * product promises publicly: discovery, ratings, official regional viewing
 * options and a personal watchlist. Change it here, not per surface.
 */
export const SITE_DESCRIPTION =
  'Discover movies, TV series, anime, and documentaries. Explore popular titles, compare ratings, and build your personal watchlist with AALAM.';

/** Installed-app name (install prompt, splash screen, OS app list). */
export const APP_NAME = 'AALAM — Movies, Series & Anime';

/**
 * Brand colours for metadata, share images and generated art outside CSS.
 * Mirrors the --color-* role tokens in src/app/tokens.css. tests/pwa.test.cjs
 * asserts the two stay identical, so change them together.
 */
export const BRAND_BACKGROUND = '#040714';
export const BRAND_SURFACE = '#1A1D29';
export const BRAND_TEXT = '#F9F9F9';
export const BRAND_MUTED = '#C0C0C0';
export const BRAND_ACCENT = '#02D6E8';

function normalizeSiteUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Set SITE_URL to the canonical, public origin in the server environment. */
export const SITE_URL = normalizeSiteUrl(process.env.SITE_URL);

export function absoluteSiteUrl(path: string): string | undefined {
  if (!SITE_URL) return undefined;
  return new URL(path.startsWith('/') ? path : `/${path}`, SITE_URL).toString();
}
