import { getConfig } from '../core/config';
import { logger } from '../core/logger';

/**
 * Optional shared cache/limiter store over the Upstash Redis REST API.
 *
 * Plain fetch keeps it working on serverless and edge runtimes with no TCP
 * client or extra dependency. Every call has a hard timeout and a circuit
 * breaker: after repeated failures Redis is skipped for a cool-down period,
 * so a Redis outage degrades to per-instance memory instead of slowing every
 * request by the timeout.
 */

const FAILURE_THRESHOLD = 3;
const COOL_DOWN_MS = 30_000;

let consecutiveFailures = 0;
let openUntil = 0;
let lastError: string | null = null;
let commands = 0;
let failures = 0;

export function isRedisConfigured(): boolean {
  const { url, token } = getConfig().redis;
  return Boolean(url && token && /^https:\/\//.test(url));
}

function circuitOpen(): boolean {
  return Date.now() < openUntil;
}

function recordFailure(error: unknown) {
  failures += 1;
  consecutiveFailures += 1;
  lastError = error instanceof Error ? error.message : String(error);
  if (consecutiveFailures >= FAILURE_THRESHOLD && !circuitOpen()) {
    openUntil = Date.now() + COOL_DOWN_MS;
    logger.warn('Redis circuit opened; using in-memory fallback', { error: lastError, coolDownMs: COOL_DOWN_MS });
  }
}

/**
 * Runs a pipeline of Redis commands. Returns undefined (never throws) when
 * Redis is unconfigured, the circuit is open, or the call fails.
 */
export async function redisPipeline(cmds: Array<Array<string | number>>): Promise<unknown[] | undefined> {
  if (!isRedisConfigured() || circuitOpen() || cmds.length === 0) return undefined;
  const { url, token, timeoutMs } = getConfig().redis;
  commands += cmds.length;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    if (!Array.isArray(body)) throw new Error('Unexpected Redis response');
    consecutiveFailures = 0;
    return body.map((entry) => (entry?.error ? undefined : entry?.result));
  } catch (error) {
    recordFailure(error);
    return undefined;
  }
}

export async function redisGet(key: string): Promise<string | null | undefined> {
  const result = await redisPipeline([['GET', key]]);
  if (!result) return undefined;
  return typeof result[0] === 'string' ? result[0] : null;
}

export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const result = await redisPipeline([['SET', key, value, 'EX', Math.max(1, Math.round(ttlSeconds))]]);
  return Boolean(result);
}

export async function redisDel(keys: string[]): Promise<void> {
  if (keys.length) await redisPipeline([['DEL', ...keys]]);
}

export function getRedisStatus() {
  return {
    configured: isRedisConfigured(),
    circuitOpen: circuitOpen(),
    consecutiveFailures,
    commands,
    failures,
    lastError,
  };
}

export function resetRedisForTests() {
  consecutiveFailures = 0;
  openUntil = 0;
  lastError = null;
  commands = 0;
  failures = 0;
}
