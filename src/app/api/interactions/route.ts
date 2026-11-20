import { apiRoute } from '@/server/core/api';
import { createUserClient } from '@/server/auth/session';
import {
  countUserInteractions, deleteUserHistory, parseInteractionBatch, recordInteractions,
} from '@/server/cinematch/interactions';
import { RATE_LIMITS } from '@/server/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Viewing/taste telemetry for signed-in users. Writes run with the user's
 * own JWT, so Row Level Security guarantees isolation.
 *
 *  POST   { events: [{ tmdbId, mediaType, type, progress?, position?, source? }] }
 *  GET    → { total, lastAt }
 *  DELETE → wipes the caller's history (resets CineMatch personalisation)
 */

export const POST = apiRoute(
  { name: 'interactions', auth: 'required', rateLimit: RATE_LIMITS.interactions },
  async ({ session, readJson }) => {
    const events = parseInteractionBatch(await readJson(32 * 1024));
    const accepted = await recordInteractions(createUserClient(session!.token), session!.user.id, events);
    return { accepted };
  }
);

export const GET = apiRoute(
  { name: 'interactions', auth: 'required', rateLimit: RATE_LIMITS.interactions },
  async ({ session }) => countUserInteractions(createUserClient(session!.token), session!.user.id)
);

export const DELETE = apiRoute(
  { name: 'interactions', auth: 'required', rateLimit: RATE_LIMITS.destructive },
  async ({ session }) => {
    await deleteUserHistory(createUserClient(session!.token), session!.user.id);
    return { deleted: true };
  }
);
