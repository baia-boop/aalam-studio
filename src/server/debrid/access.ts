import { ApiError, unauthorized } from '../core/errors';
import { createUserClient, type AuthSession } from '../auth/session';

export interface DebridEntitlement {
  active: boolean;
  expiresAt: string | null;
}

/** Test seam; production checks the authenticated user's RLS-protected row. */
let checkerOverride: ((session: AuthSession) => Promise<DebridEntitlement>) | null = null;
export function setDebridEntitlementCheckerForTests(
  checker: ((session: AuthSession) => Promise<DebridEntitlement>) | null
) {
  checkerOverride = checker;
}

export async function getDebridEntitlement(session: AuthSession | null): Promise<DebridEntitlement> {
  if (!session) throw unauthorized('Sign in to use AALAM Premium.');
  if (checkerOverride) return checkerOverride(session);

  const { data, error } = await createUserClient(session.token)
    .from('user_subscriptions')
    .select('starts_at, expires_at')
    .eq('user_id', session.user.id)
    .eq('product', 'debrid')
    .eq('status', 'active')
    .limit(20);

  if (error) {
    throw new ApiError(
      503,
      'SUBSCRIPTION_LOOKUP_FAILED',
      'Premium access could not be checked. Please try again later.'
    );
  }

  const now = Date.now();
  const active = (data ?? []).find((row: { starts_at: string; expires_at: string | null }) => {
    const startsAt = Date.parse(row.starts_at);
    if (!Number.isFinite(startsAt) || startsAt > now) return false;
    if (row.expires_at === null) return true;
    const expiresAt = Date.parse(row.expires_at);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });

  return {
    active: Boolean(active),
    expiresAt: active?.expires_at ?? null,
  };
}

export async function requireDebridEntitlement(session: AuthSession | null): Promise<DebridEntitlement> {
  const entitlement = await getDebridEntitlement(session);
  if (!entitlement.active) {
    throw new ApiError(403, 'SUBSCRIPTION_REQUIRED', 'An active AALAM Premium subscription is required for Real-Debrid playback.');
  }
  return entitlement;
}
