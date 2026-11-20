import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSessionToken,
  isAdminAuthConfigured,
  verifyAdminCredentials,
} from '@/lib/admin-auth';
import { clientAddressFrom, requestHostFrom } from '@/server/core/client-address';
import { RATE_LIMITS, rateLimit, rateLimitHeaders } from '@/server/security/rate-limit';

export const runtime = 'nodejs';

function isSameOrigin(request: NextRequest): boolean {
  const originHeader = request.headers.get('origin');
  if (!originHeader) return false;

  try {
    const origin = new URL(originHeader);
    return (
      origin.host.toLowerCase() === requestHostFrom(request.headers, request.nextUrl) &&
      (origin.protocol === 'https:' || origin.protocol === 'http:')
    );
  } catch {
    return false;
  }
}

function privateResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {}
) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0', ...headers },
  });
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return privateResponse({ error: 'Request could not be verified.' }, 403);
  }

  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return privateResponse({ error: 'Expected a JSON request.' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 4096) {
    return privateResponse({ error: 'Request is too large.' }, 413);
  }

  if (!isAdminAuthConfigured()) {
    return privateResponse(
      { error: 'Admin sign-in is not configured on this deployment.' },
      503
    );
  }

  // Checked before the body is read, so the limit also caps scrypt work.
  // Every attempt counts, not only failures — the budget is what bounds
  // credential guessing, and it now lives in the shared Redis-backed limiter
  // rather than a per-process map, so it holds across replicas and is bounded.
  const address = clientAddressFrom(request.headers);
  const limit = await rateLimit(RATE_LIMITS.adminLogin, `ip:${address}`);
  if (!limit.allowed) {
    const response = privateResponse(
      { error: 'Too many sign-in attempts. Please try again shortly.' },
      429,
      rateLimitHeaders(limit)
    );
    response.headers.set('Retry-After', String(limit.resetSeconds));
    return response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return privateResponse({ error: 'Invalid sign-in request.' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return privateResponse({ error: 'Invalid sign-in request.' }, 400);
  }

  const { email, password } = body as { email?: unknown; password?: unknown };
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    email.length > 320 ||
    password.length < 1 ||
    password.length > 1024
  ) {
    return privateResponse({ error: 'Email or password is incorrect.' }, 401);
  }

  const authenticated = await verifyAdminCredentials(email, password);
  if (!authenticated) {
    return privateResponse({ error: 'Email or password is incorrect.' }, 401);
  }

  const token = createAdminSessionToken();
  if (!token) {
    return privateResponse({ error: 'Admin sign-in is unavailable.' }, 503);
  }

  const response = privateResponse({ ok: true }, 200);
  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
