import { apiRoute, json, type RouteContext } from '@/server/core/api';
import { ApiError } from '@/server/core/errors';
import { logger } from '@/server/core/logger';
import { createUserClient } from '@/server/auth/session';
import { parseTasteContext, type TasteContext } from '@/server/cinematch/context';
import { loadCollaborative, loadUserSignals } from '@/server/cinematch/interactions';
import { recommend } from '@/server/cinematch/pipeline';
import type { TitleSignal } from '@/server/cinematch/types';
import { RATE_LIMITS } from '@/server/security/rate-limit';

/**
 * CineMatch recommendations.
 *
 *  GET  — signed-in users: built from their stored interaction history;
 *         guests: the cold-start feed (trending + acclaimed).
 *  POST — same, plus the browser's local taste state (seeds, likes, dislikes,
 *         watchlist, continue-watching, genre weights). This lets guests get
 *         the full engine without storing anything server-side, and lets
 *         signed-in users merge not-yet-synced local signals.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(ctx: RouteContext<Record<string, string | string[]>>, context: TasteContext) {
  const { session } = ctx;
  let signals: TitleSignal[] = context.signals;
  let history: 'none' | 'loaded' | 'unavailable' = 'none';
  let collaborative: (() => ReturnType<typeof loadCollaborative>) | undefined;

  if (session) {
    const client = createUserClient(session.token);
    const started = performance.now();
    try {
      const stored = await loadUserSignals(client, session.user.id);
      signals = [...stored, ...context.signals];
      history = 'loaded';
      collaborative = () => loadCollaborative(client);
    } catch (error) {
      // Recommendations must still work if the migration is missing or the
      // database is briefly unavailable: fall back to the request context.
      history = 'unavailable';
      if (!(error instanceof ApiError)) logger.warn('Loading interaction history failed', { error });
    }
    ctx.mark('history', started);
  }

  const started = performance.now();
  const { result, cache } = await recommend({
    scope: session ? `u:${session.user.id}` : 'guest',
    signals,
    genreWeights: context.genreWeights,
    collaborative,
    limit: context.limit,
  });
  ctx.mark('engine', started);

  return json(
    { ...result, history },
    {
      headers: {
        'X-Cache': cache,
        // Personal results must never be stored by shared caches.
        'Cache-Control': 'private, no-store',
      },
    }
  );
}

export const GET = apiRoute(
  { name: 'recommendations', auth: 'optional', rateLimit: RATE_LIMITS.recommendations },
  async (ctx) => {
    const limitParam = ctx.url.searchParams.get('limit');
    return handle(ctx, parseTasteContext(limitParam ? { limit: Number(limitParam) } : {}));
  }
);

export const POST = apiRoute(
  { name: 'recommendations', auth: 'optional', rateLimit: RATE_LIMITS.recommendations },
  async (ctx) => handle(ctx, parseTasteContext(await ctx.readJson(64 * 1024)))
);
