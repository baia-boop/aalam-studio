import { apiRoute } from '@/server/core/api';
import { getAuthorizedPlaybackGrants } from '@/server/playback/grants';
import { RATE_LIMITS } from '@/server/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Play buttons in cached catalogue pages can outlive a deployment config
// change. This refreshes their public title/route IDs, not playback authority.
// Watch and the detector still check the current grants on the server.
export const GET = apiRoute({
  name: 'playback-grants',
  rateLimit: RATE_LIMITS.catalogue,
  cacheControl: 'private, no-store',
}, async () => ({ grants: getAuthorizedPlaybackGrants() }));
