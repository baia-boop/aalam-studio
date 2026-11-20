/**
 * Canonical-URL helpers shared by metadata generation, route redirects and
 * middleware (which runs on the Node edge runtime, so this module must not
 * import 'server-only').
 *
 * Every indexable page must resolve to exactly one canonical URL: the clean,
 * absolute ID+slug form of its route. Tracking parameters (utm_*, fbclid,
 * gclid, …) never change page identity and are stripped from canonical URLs;
 * only explicitly allow-listed semantic filters may appear in a canonical.
 */

const TRACKING_PARAM_RE =
  /^(utm_.+|gclid|dclid|fbclid|msclkid|yclid|twclid|ttclid|igshid|igsh|ref|ref_src|ref_url|mc_cid|mc_eid|s_kwcid|_ga|_gl|_hsenc|_hsmi|pk_campaign|pk_source|pk_medium|pk_content|pk_term|mc_|mkt_.+)$/i;

/** True for campaign/click-tracking query parameters that must not be indexed. */
export function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_RE.test(key);
}

/**
 * Removes tracking parameters while preserving user-facing filters such as
 * ?genre= or ?sort=. Returns '' when nothing meaningful remains.
 */
export function stripTrackingParams(search: string): string {
  if (!search || search === '?') return '';
  const params = new URLSearchParams(search);
  let removed = false;
  for (const key of Array.from(params.keys())) {
    if (isTrackingParam(key)) {
      params.delete(key);
      removed = true;
    }
  }
  if (!removed) return search.startsWith('?') ? search : `?${search}`;
  const kept = params.toString();
  return kept ? `?${kept}` : '';
}

/** Builds an absolute canonical URL, dropping tracking parameters. */
export function canonicalUrl(
  origin: string | undefined,
  path: string,
  searchOrParams?: string | URLSearchParams
): string | undefined {
  if (!origin) return undefined;
  try {
    const url = new URL(path, origin);
    const rawSearch =
      typeof searchOrParams === 'string'
        ? searchOrParams
        : searchOrParams
          ? searchOrParams.toString()
          : '';
    url.search = stripTrackingParams(rawSearch);
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Extracts the leading numeric TMDB id from a dynamic `[id]` route segment of
 * the form "1368337-the-odyssey". Returns null for non-numeric segments.
 */
export function parseIdSegment(segment: string): number | null {
  const match = /^(\d+)(?:-|$)/.exec(segment || '');
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Normalizes arbitrary title text into a lowercase hyphenated slug suitable
 * for the ID+slug URL format used across internal links and the sitemap.
 */
export function slugifyTitle(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * Slug suffix ("the-odyssey") for a given TMDB id, or '' when the title has
 * no sluggable characters. The full canonical segment is `${id}${suffix}`.
 */
export function titleSlugSuffix(id: number, title: string | undefined): string {
  const slug = title ? slugifyTitle(title) : '';
  return slug ? `-${slug}` : '';
}
