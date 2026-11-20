import { randomUUID } from 'node:crypto';
import { ApiError, forbidden, tooManyRequests, badRequest } from './errors';
import { getConfig } from './config';
import { clientAddressFrom, requestHostFrom } from './client-address';
import { logger, safePath } from './logger';
import { rateLimit, rateLimitHeaders, type RateLimitPolicy, type RateLimitResult } from '../security/rate-limit';
import { resolveSession, type AuthSession } from '../auth/session';
import { TmdbError } from '../tmdb/gateway';

/**
 * One wrapper for every API route, so cross-cutting behaviour is uniform:
 *
 *  - request id (honours a sane inbound `x-request-id`) on every response;
 *  - origin checks: state-changing methods must be same-origin (or listed in
 *    API_ALLOWED_ORIGINS); CORS headers only for allow-listed origins;
 *  - rate limiting keyed by user id when signed in, otherwise a client address
 *    resolved only from headers the deployment has declared trustworthy;
 *  - auth: none / optional / required, with invalid tokens always rejected;
 *  - bounded JSON body parsing with content-type enforcement;
 *  - structured access logs with latency and a `Server-Timing` header;
 *  - errors mapped to `{ error: { code, message } }`; internals never leak.
 */

export type AuthMode = 'none' | 'optional' | 'required';

export interface RouteContext<P> {
  req: Request;
  url: URL;
  params: P;
  requestId: string;
  session: AuthSession | null;
  clientIp: string;
  /** Records a named stage for the Server-Timing header. */
  mark: (name: string, startedAt: number) => void;
  /**
   * Bounded JSON body. `contentTypes` overrides the accepted media types
   * (default application/json), e.g. for application/csp-report.
   */
  readJson: <T = unknown>(maxBytes?: number, contentTypes?: readonly string[]) => Promise<T>;
}

export interface RouteOptions {
  name: string;
  auth?: AuthMode;
  rateLimit?: RateLimitPolicy | null;
  /** Default Cache-Control when the handler does not set one. */
  cacheControl?: string;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

function isAllowedOrigin(origin: string, req: Request, url: URL): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.host.toLowerCase() === requestHostFrom(req.headers, url)) return true;
    return getConfig().allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers },
  });
}

/**
 * Reads a request body without ever holding more than `maxBytes` of it.
 *
 * `await req.text()` buffers everything first, so a client that omits
 * `content-length` (`Transfer-Encoding: chunked`) can make the process absorb
 * an arbitrarily large body before the size check runs — on unauthenticated
 * beacons included. Reading chunk by chunk and bailing as soon as the cap is
 * passed bounds the memory to the cap, and cancelling the reader stops the
 * client from continuing to upload into a response it will not read.
 */
async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  // Decoding the concatenated bytes (not each chunk) keeps multi-byte
  // characters that straddle a chunk boundary intact.
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

function errorResponse(error: ApiError, requestId: string): Response {
  return json(
    { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, requestId },
    { status: error.status, headers: error.headers }
  );
}

/** Upstream catalogue failures become stable, user-safe API errors. */
export function fromTmdbError(error: TmdbError): ApiError {
  switch (error.status) {
    case 404:
      return new ApiError(404, 'NOT_FOUND', 'That title could not be found.');
    case 400:
      return badRequest('The catalogue rejected this request.');
    case 503:
      return new ApiError(503, 'CATALOGUE_UNAVAILABLE', 'The catalogue is not configured on this server.');
    case 429:
      return new ApiError(503, 'CATALOGUE_BUSY', 'The catalogue is busy. Please retry shortly.', { headers: { 'Retry-After': String(error.retryAfter ?? 5) } });
    case 504:
      return new ApiError(504, 'CATALOGUE_TIMEOUT', 'The catalogue did not respond in time.');
    default:
      return new ApiError(502, 'CATALOGUE_ERROR', 'The catalogue returned an unexpected error.');
  }
}

type Handler<P> = (ctx: RouteContext<P>) => Promise<Response | unknown>;

export function apiRoute<P extends object = Record<string, string | string[]>>(options: RouteOptions, handler: Handler<P>) {
  // Next.js validates this exact second-argument shape at build time.
  return async (req: Request, routeArgs: { params: Promise<P> }): Promise<Response> => {
    const startedAt = performance.now();
    const url = new URL(req.url);
    const inbound = req.headers.get('x-request-id');
    const requestId = inbound && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    const timings: string[] = [];
    const mark = (name: string, since: number) => {
      timings.push(`${name.replace(/[^a-z0-9_-]/gi, '')};dur=${(performance.now() - since).toFixed(1)}`);
    };
    const origin = req.headers.get('origin');
    const clientIp = clientAddressFrom(req.headers);
    let limitResult: RateLimitResult | null = null;
    let session: AuthSession | null = null;
    let response: Response;

    try {
      if (origin && !isAllowedOrigin(origin, req, url)) {
        // Cross-site reads get no CORS headers anyway; writes are refused outright.
        if (MUTATING.has(req.method)) throw forbidden('Cross-origin requests are not allowed.');
      } else if (!origin && MUTATING.has(req.method) && req.headers.get('sec-fetch-site') === 'cross-site') {
        throw forbidden('Cross-origin requests are not allowed.');
      }

      const authStarted = performance.now();
      if (options.auth && options.auth !== 'none') {
        session = await resolveSession(req.headers.get('authorization'));
        if (options.auth === 'required' && !session) {
          throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to use this feature.');
        }
        mark('auth', authStarted);
      }

      if (options.rateLimit) {
        const key = session ? `u:${session.user.id}` : `ip:${clientIp}`;
        limitResult = await rateLimit(options.rateLimit, key);
        if (!limitResult.allowed) throw tooManyRequests(limitResult.resetSeconds);
      }

      const params = ((await routeArgs?.params) ?? {}) as P;
      const ctx: RouteContext<P> = {
        req,
        url,
        params,
        requestId,
        session,
        clientIp,
        mark,
        readJson: async <T,>(maxBytes = 32 * 1024, contentTypes: readonly string[] = ['application/json']): Promise<T> => {
          const mediaType = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
          if (!contentTypes.includes(mediaType)) {
            throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected a JSON request body.');
          }
          // Cheap reject when the client declares a size; the stream read below
          // is the real enforcement, since a declared size can be absent or a lie.
          const declared = Number(req.headers.get('content-length') || 0);
          if (declared > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
          const text = await readBoundedText(req.body, maxBytes);
          try {
            return JSON.parse(text) as T;
          } catch {
            throw badRequest('Request body is not valid JSON.');
          }
        },
      };

      const result = await handler(ctx);
      response = result instanceof Response ? result : json(result);
    } catch (caught) {
      const error = caught instanceof TmdbError ? fromTmdbError(caught) : caught;
      if (error instanceof ApiError) {
        response = errorResponse(error, requestId);
        if (error.status >= 500) logger.error('API error', { route: options.name, requestId, code: error.code });
      } else {
        logger.error('Unhandled API error', { route: options.name, requestId, error });
        response = errorResponse(new ApiError(500, 'INTERNAL', 'Something went wrong. Please try again.'), requestId);
      }
    }

    const headers = response.headers;
    headers.set('X-Request-Id', requestId);
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', response.status < 400 && options.cacheControl ? options.cacheControl : 'no-store');
    }
    if (limitResult) {
      for (const [key, value] of Object.entries(rateLimitHeaders(limitResult))) headers.set(key, value);
    }
    if (origin && isAllowedOrigin(origin, req, url)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.append('Vary', 'Origin');
    }
    headers.set('X-Content-Type-Options', 'nosniff');
    const totalMs = performance.now() - startedAt;
    timings.push(`total;dur=${totalMs.toFixed(1)}`);
    headers.set('Server-Timing', timings.join(', '));

    const level = response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      route: options.name,
      method: req.method,
      path: safePath(url.pathname),
      status: response.status,
      ms: Math.round(totalMs),
      requestId,
      user: session ? 'signed-in' : 'guest',
    });
    return response;
  };
}

/** Preflight handler for allow-listed cross-origin API clients. */
export function preflight(methods: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    if (!origin || !isAllowedOrigin(origin, req, url)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      },
    });
  };
}
