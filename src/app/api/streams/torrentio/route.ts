import { apiRoute, json } from '@/server/core/api';
import { badRequest } from '@/server/core/errors';
import { parseEnum, parseIntParam } from '@/server/core/validate';
import { requireDebridEntitlement } from '@/server/debrid/access';
import { requireDebridServiceToken } from '@/server/debrid/request';
import { getTorrentioStreams } from '@/server/debrid/torrentio';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { isImdbId } from '@/lib/torrentio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/streams/torrentio?type=movie|tv&imdb=tt…&s=&e=
 *
 * Torrentio stream discovery for a signed-in Premium subscriber. AALAM's
 * server-only Real-Debrid token adds "instant" markers and is never returned
 * to the browser (Torrentio resolve URLs are stripped). Results are cached per title/episode.
 */
export const GET = apiRoute({ name: 'streams.torrentio', auth: 'required', rateLimit: RATE_LIMITS.streams }, async ({ url, mark, session }) => {
  const token = requireDebridServiceToken();
  await requireDebridEntitlement(session);
  const type = parseEnum(url.searchParams.get('type') ?? undefined, ['movie', 'tv'] as const, 'type');
  const imdbId = url.searchParams.get('imdb') ?? '';
  if (!isImdbId(imdbId)) throw badRequest('imdb must be an IMDb id such as tt0111161');
  const season = type === 'tv' ? parseIntParam(url.searchParams.get('s'), 's', { min: 0, max: 10000, fallback: 1 }) : undefined;
  const episode = type === 'tv' ? parseIntParam(url.searchParams.get('e'), 'e', { min: 1, max: 10000, fallback: 1 }) : undefined;

  const started = performance.now();
  const { value, status } = await getTorrentioStreams({ type, imdbId, season, episode }, { realDebridToken: token });
  mark('torrentio', started);
  return json(
    { ...value, query: { type, imdbId, season, episode } },
    {
      headers: {
        // The response contains release metadata only; service credentials never leave this route.
        'Cache-Control': 'private, max-age=60',
        'X-Cache': status,
      },
    }
  );
});
