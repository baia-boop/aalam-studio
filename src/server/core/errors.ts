/**
 * Errors that carry an HTTP status and a stable machine-readable code.
 * Anything else that reaches the API boundary becomes an opaque 500.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'BAD_REQUEST', message, { details });
export const unauthorized = (message = 'Sign in to use this feature.') =>
  new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'This request is not allowed.') =>
  new ApiError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found.') => new ApiError(404, 'NOT_FOUND', message);
export const unavailable = (code: string, message: string) => new ApiError(503, code, message);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.', {
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
