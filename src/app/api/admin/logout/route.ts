import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-auth';
import { clientAddressFrom, requestHostFrom } from '@/server/core/client-address';
import { RATE_LIMITS, rateLimit, rateLimitHeaders } from '@/server/security/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const originHeader = request.headers.get('origin');
  let sameOrigin = false;

  if (originHeader) {
    try {
      const origin = new URL(originHeader);
      sameOrigin = origin.host.toLowerCase() === requestHostFrom(request.headers, request.nextUrl);
    } catch {
      sameOrigin = false;
    }
  }

  if (!sameOrigin) {
    return NextResponse.json(
      { error: 'Request could not be verified.' },
      { status: 403, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  }

  const limit = await rateLimit(RATE_LIMITS.status, `ip:${clientAddressFrom(request.headers)}`);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Cache-Control': 'no-store, max-age=0', ...rateLimitHeaders(limit) } }
    );
  }

  const response = NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
  response.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return response;
}
