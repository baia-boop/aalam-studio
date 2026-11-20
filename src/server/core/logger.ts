import { getConfig } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never written to logs, at any depth. */
const SECRET_KEY = /(authorization|token|secret|password|api[_-]?key|cookie|jwt)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Strips query strings, which can carry api_key or search text. */
export function safePath(url: string): string {
  return url.split('?')[0];
}

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  let threshold: Level = 'info';
  try {
    threshold = getConfig().logLevel;
  } catch {
    // Configuration errors must not silence the logger itself.
  }
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    service: 'aalam-api',
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};
