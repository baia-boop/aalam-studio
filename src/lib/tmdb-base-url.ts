/**
 * TMDB API base-URL policy shared by the server gateway (src/server/tmdb)
 * and the server-side branch of src/lib/tmdb.ts, so both send the TMDB key
 * only to the same hosts. Pure module: safe to import from shared code.
 */

export const DEFAULT_TMDB_BASE_URL = 'https://api.themoviedb.org/3';

/**
 * Hosts allowed to receive the TMDB key. `api.tmdb.org` is TMDB's own alias
 * (useful on networks that SNI-filter api.themoviedb.org). Loopback is only
 * accepted outside production, or with the explicit `TMDB_ALLOW_LOOPBACK=1`
 * opt-in, so a local mock server can stand in for TMDB (tests and
 * `npm run perf:budget`, which must measure a real production build).
 */
export const TMDB_ALLOWED_HOSTS = new Set(['api.themoviedb.org', 'api.tmdb.org']);

export function resolveTmdbBaseUrl(
  raw: string | undefined,
  nodeEnv: string | undefined,
  { allowLoopback = false }: { allowLoopback?: boolean } = {}
): string {
  const configured = (raw || '').trim().replace(/^["']|["']$/g, '');
  if (!configured) return DEFAULT_TMDB_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('TMDB_BASE_URL is not a valid URL');
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (isLoopback && (nodeEnv !== 'production' || allowLoopback)) {
    return configured.replace(/\/+$/, '');
  }
  if (parsed.protocol !== 'https:') throw new Error('TMDB_BASE_URL must use https');
  if (!TMDB_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`TMDB_BASE_URL host is not allowed: ${parsed.hostname}`);
  }
  return configured.replace(/\/+$/, '');
}
