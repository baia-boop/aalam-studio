import 'server-only';
import { getConfig } from './config';
import { logger } from './logger';

/**
 * Client identity, read only from headers this deployment has explicitly
 * declared trustworthy.
 *
 * `X-Real-IP` and `X-Forwarded-For` are written by whoever sits closest to the
 * client — which, whenever an edge appends instead of overwriting, is the
 * client itself. Trusting them blindly lets a caller choose its own rate-limit
 * bucket by sending a fresh value on every request, which silently disables
 * every limit keyed on it. The same is true of `X-Forwarded-Host`, which is
 * what the same-origin check compares an `Origin` against.
 *
 * Two ways to name the trusted source:
 *
 *  - `TRUSTED_PROXY_HEADER`: a header the platform *overwrites* on every
 *    request — `cf-connecting-ip`, `x-vercel-forwarded-for`, or `x-real-ip`
 *    behind an nginx that sets it from `$remote_addr`. Used verbatim.
 *  - `TRUSTED_PROXY_HOPS`: how many trusted proxies append to
 *    `X-Forwarded-For`. The client address is the Nth entry counted from the
 *    right; everything to its left was supplied by the client and dropped.
 *
 * With neither configured (`TRUSTED_PROXY_HOPS=0`) no forwarded header is read
 * and every request shares {@link UNTRUSTED_CLIENT}. Limits then cannot be
 * rotated at all, which is the safe failure mode for a server exposed directly
 * with no proxy in front — at the cost of a single shared bucket.
 */

/** Shared bucket for requests with no trustworthy client identity. */
export const UNTRUSTED_CLIENT = 'untrusted-client';

export type ClientAddressSource = 'trusted-header' | 'forwarded-for' | 'untrusted';

export interface ClientAddress {
  address: string;
  source: ClientAddressSource;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

function isIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  return value.split('.').every((part) => {
    if (part.length > 1 && part.startsWith('0')) return false; // no octal forms
    return Number(part) <= 255;
  });
}

function isIpv6(value: string): boolean {
  if (!value.includes(':') || value.includes('%') || value.includes(':::')) return false;

  let body = value;
  let trailingGroups = 0;
  if (value.includes('.')) {
    // An IPv4-mapped tail (::ffff:192.0.2.1) stands for the last two groups.
    const lastColon = value.lastIndexOf(':');
    const tail = value.slice(lastColon + 1);
    if (!isIpv4(tail)) return false;
    body = value.slice(0, lastColon);
    trailingGroups = 2;
  }

  const halves = body.split('::');
  if (halves.length > 2) return false;

  /** Group count, or -1 when the chunk holds anything that is not a group. */
  const countGroups = (chunk: string): number => {
    if (chunk === '') return 0;
    const groups = chunk.split(':');
    return groups.every((group) => IPV6_GROUP.test(group)) ? groups.length : -1;
  };

  if (halves.length === 2) {
    const head = countGroups(halves[0]);
    const tail = countGroups(halves[1]);
    if (head < 0 || tail < 0) return false;
    // `::` has to stand for at least one group of zeros.
    return head + tail + trailingGroups <= 7;
  }

  const groups = countGroups(body);
  return groups >= 0 && groups + trailingGroups === 8;
}

/** Strict enough to stop a client turning arbitrary text into a cache key. */
export function isIpAddress(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

/** Splits a comma-separated forwarding header, dropping blanks and padding. */
function splitChain(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

let warnedSharedBucket = false;

function warnSharedBucketOnce(): void {
  if (warnedSharedBucket) return;
  warnedSharedBucket = true;
  const { isProduction } = getConfig();
  if (!isProduction) return;
  logger.warn('No trusted proxy configured; every request shares one rate-limit bucket', {
    hint: 'Set TRUSTED_PROXY_HOPS to the number of proxies that append to X-Forwarded-For, or TRUSTED_PROXY_HEADER to a header your platform overwrites.',
  });
}

/**
 * The client address to key rate limits and access logs on. Never a value the
 * client alone controls, unless the deployment has said no proxy is involved.
 */
export function resolveClientAddress(headers: Headers): ClientAddress {
  const { hops, header } = getConfig().proxy;

  if (header) {
    const value = headers.get(header)?.trim() ?? '';
    if (isIpAddress(value)) return { address: value, source: 'trusted-header' };
    // A trusted header that does not parse is a deployment problem, not a
    // client-supplied value: fall back to the shared bucket rather than to a
    // less trusted source.
    warnSharedBucketOnce();
    return { address: UNTRUSTED_CLIENT, source: 'untrusted' };
  }

  if (hops > 0) {
    const chain = splitChain(headers.get('x-forwarded-for'));
    // A chain shorter than the configured trust depth cannot vouch for any
    // entry: with hops=2 and a single entry, that entry is whatever the client
    // put in the header, not something the outermost trusted proxy appended.
    // Clamping the index to 0 here would hand the caller a chosen rate-limit
    // bucket — the exact rotation this module exists to prevent — so the
    // request joins the shared bucket instead. A correctly configured
    // deployment always has at least `hops` entries, one per proxy.
    if (chain.length >= hops) {
      const candidate = chain[chain.length - hops];
      if (isIpAddress(candidate)) return { address: candidate, source: 'forwarded-for' };
    }
  }

  warnSharedBucketOnce();
  return { address: UNTRUSTED_CLIENT, source: 'untrusted' };
}

/** Convenience wrapper for call sites that only need the key. */
export function clientAddressFrom(headers: Headers): string {
  return resolveClientAddress(headers).address;
}

/**
 * The host this request was addressed to, for same-origin checks.
 *
 * `X-Forwarded-Host` is deliberately never consulted: a client can set it, and
 * most reverse proxies pass it through untouched, so comparing an `Origin`
 * against it lets a foreign origin declare itself same-origin. `Host` is the
 * host the client chose to connect to, which is exactly what an `Origin`
 * header should be measured against.
 *
 * A deployment whose proxy rewrites `Host` to an internal value should list
 * its public origin in `API_ALLOWED_ORIGINS` — an explicit allow-list, not a
 * header the caller controls.
 */
export function requestHostFrom(headers: Headers, url: URL): string {
  return (headers.get('host') || url.host).toLowerCase();
}

/** Tests change env between cases; production never calls this. */
export function resetClientAddressForTests(): void {
  warnedSharedBucket = false;
}
