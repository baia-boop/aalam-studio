/**
 * Minimal, spec-compliant sitemap XML serialisation
 * (https://www.sitemaps.org/protocol.html).
 *
 * Deliberately emits only <loc> and an optional <lastmod>. <changefreq> and
 * <priority> are omitted: Google ignores both, and hard-coded values such as
 * "daily" on routes that do not change daily are inaccurate signals.
 */

/** Protocol limits per sitemap file. */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export interface SitemapUrl {
  loc: string;
  /** W3C datetime; omitted when the real modification time is unknown. */
  lastmod?: string;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function entry(tag: 'url' | 'sitemap', item: SitemapUrl): string {
  const lastmod = item.lastmod ? `<lastmod>${escapeXml(item.lastmod)}</lastmod>` : '';
  return `<${tag}><loc>${escapeXml(item.loc)}</loc>${lastmod}</${tag}>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export function renderUrlset(urls: readonly SitemapUrl[]): string {
  if (urls.length > SITEMAP_MAX_URLS) {
    throw new Error(`A sitemap may list at most ${SITEMAP_MAX_URLS} URLs (got ${urls.length}).`);
  }
  const body = urls.map((u) => entry('url', u)).join('\n');
  const xml = `${XML_HEAD}<urlset xmlns="${NS}">\n${body}${body ? '\n' : ''}</urlset>\n`;
  if (Buffer.byteLength(xml, 'utf8') > SITEMAP_MAX_BYTES) {
    throw new Error('Sitemap exceeds the 50 MB uncompressed limit.');
  }
  return xml;
}

export function renderSitemapIndex(sitemaps: readonly SitemapUrl[]): string {
  if (sitemaps.length > SITEMAP_MAX_URLS) {
    throw new Error(`A sitemap index may list at most ${SITEMAP_MAX_URLS} sitemaps.`);
  }
  const body = sitemaps.map((s) => entry('sitemap', s)).join('\n');
  return `${XML_HEAD}<sitemapindex xmlns="${NS}">\n${body}${body ? '\n' : ''}</sitemapindex>\n`;
}

/** The latest of several W3C datetimes (ISO strings compare lexically). */
export function latestLastmod(values: ReadonlyArray<string | undefined>): string | undefined {
  let latest: string | undefined;
  for (const value of values) if (value && (!latest || value > latest)) latest = value;
  return latest;
}

/** Headers shared by every sitemap response. */
export function sitemapHeaders(cacheControl: string): Record<string, string> {
  return {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': cacheControl,
    // Sitemaps are for crawlers, not search results. Google still reads them.
    'X-Robots-Tag': 'noindex',
  };
}
