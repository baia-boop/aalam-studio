import { apiRoute } from '@/server/core/api';
import { getDebridEntitlement } from '@/server/debrid/access';
import { isDebridServiceConfigured } from '@/server/debrid/request';
import { RATE_LIMITS } from '@/server/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Current user's AALAM Premium entitlement; no Real-Debrid credentials leave the server. */
export const GET = apiRoute(
  { name: 'debrid.access', auth: 'required', rateLimit: RATE_LIMITS.debrid },
  async ({ session }) => {
    if (!isDebridServiceConfigured()) return { status: 'unavailable' as const, expiresAt: null };
    const entitlement = await getDebridEntitlement(session);
    return {
      status: entitlement.active ? 'active' as const : 'subscription_required' as const,
      expiresAt: entitlement.expiresAt,
    };
  }
);
