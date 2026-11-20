import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../core/config';
import { LruCache } from '../cache/lru';
import { logger } from '../core/logger';
import { unauthorized } from '../core/errors';

/**
 * Supabase Auth session verification for API routes.
 *
 * The browser sends its Supabase access token as `Authorization: Bearer`.
 * The token is verified by Supabase (`auth.getUser`), never merely decoded,
 * and the verified identity is cached per token hash until shortly before it
 * expires, so an active user costs one verification per minute at most.
 *
 * Database access then uses a *user-scoped* client carrying that token, so
 * Postgres row-level security applies to every query. The API never needs a
 * service-role key.
 */

export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
}

const verified = new LruCache<AuthUser>(10_000);
const MAX_CACHE_SECONDS = 60;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isAuthConfigured(): boolean {
  const { url, publicKey } = getConfig().supabase;
  return Boolean(url && publicKey && /^https?:\/\//.test(url));
}

export function bearerToken(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 20 && token.length < 4096 && TOKEN_SHAPE.test(token) ? token : null;
}

/** Reads `exp` for cache sizing only. Identity always comes from Supabase. */
function unverifiedExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

let anonClient: SupabaseClient | null = null;
function getAnonClient(): SupabaseClient {
  if (!anonClient) {
    const { url, publicKey } = getConfig().supabase;
    anonClient = createClient(url, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return anonClient;
}

/** Test seam: replaces the verifier without network access. */
let verifierOverride: ((token: string) => Promise<AuthUser | null>) | null = null;
export function setTokenVerifierForTests(fn: ((token: string) => Promise<AuthUser | null>) | null) {
  verifierOverride = fn;
  verified.clear();
}

async function verifyWithSupabase(token: string): Promise<AuthUser | null> {
  if (verifierOverride) return verifierOverride(token);
  if (!isAuthConfigured()) return null;
  try {
    const { data, error } = await getAnonClient().auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? undefined };
  } catch (error) {
    logger.warn('Supabase token verification failed', { error });
    return null;
  }
}

/**
 * Resolves the session for a request. Returns null when no bearer token is
 * present; throws 401 when a token is present but invalid — a bad token is
 * never silently downgraded to anonymous access.
 */
export async function resolveSession(authorization: string | null): Promise<AuthSession | null> {
  if (!authorization) return null;
  const token = bearerToken(authorization);
  if (!token) throw unauthorized('Invalid authorization header.');

  const exp = unverifiedExpiry(token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp !== null && exp <= nowSeconds) throw unauthorized('Your session has expired. Sign in again.');

  const cacheKey = createHash('sha256').update(token).digest('base64url');
  const cached = verified.get(cacheKey);
  if (cached) return { user: cached, token };

  const user = await verifyWithSupabase(token);
  if (!user) throw unauthorized('Your session could not be verified. Sign in again.');
  const ttl = Math.min(MAX_CACHE_SECONDS, exp ? exp - nowSeconds - 5 : MAX_CACHE_SECONDS);
  if (ttl > 0) verified.set(cacheKey, user, ttl);
  return { user, token };
}

/** Supabase client bound to the caller's JWT: every query runs under RLS. */
export function createUserClient(token: string): SupabaseClient {
  const { url, publicKey } = getConfig().supabase;
  return createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
