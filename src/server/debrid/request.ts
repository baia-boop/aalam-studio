import { getConfig } from '../core/config';
import { ApiError } from '../core/errors';
import { isDebridToken } from '@/lib/torrentio';

/**
 * The Real-Debrid credential is owned by AALAM and exists only in the server
 * environment. It must never be accepted from a browser request or returned
 * to a client.
 */
export function requireDebridServiceToken(): string {
  if (!getConfig().debrid.enabled) {
    throw new ApiError(404, 'DEBRID_DISABLED', 'Torrentio / Real-Debrid playback is disabled on this server.');
  }
  const token = process.env.REALDEBRID_API_TOKEN?.trim() || '';
  if (!isDebridToken(token)) {
    throw new ApiError(503, 'DEBRID_NOT_CONFIGURED', 'AALAM Premium playback is not configured yet.');
  }
  return token;
}

export function isDebridServiceConfigured(): boolean {
  if (!getConfig().debrid.enabled) return false;
  return isDebridToken(process.env.REALDEBRID_API_TOKEN?.trim() || '');
}
