/**
 * Parsing + sanitising of browser CSP violation reports.
 *
 * Accepts both wire formats:
 *  - legacy `report-uri`:   Content-Type application/csp-report,
 *                           body `{ "csp-report": { "document-uri", … } }`
 *  - Reporting API `report-to`: Content-Type application/reports+json,
 *                           body `[{ type: "csp-violation", body: { documentURL, … } }]`
 *
 * Reports are untrusted input from any visitor, so everything is reduced to a
 * small, bounded, query-string-free record before it is logged or counted:
 * URLs keep only origin + path (query strings can carry tokens or PII),
 * strings are length-capped, and unknown fields are dropped.
 */

export const CSP_REPORT_CONTENT_TYPES = ['application/csp-report', 'application/reports+json', 'application/json'] as const;
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
export const CSP_REPORT_MAX_ITEMS = 20;

export interface CspViolation {
  disposition: 'enforce' | 'report';
  directive: string;
  /** Origin of the blocked resource, or a CSP keyword (inline, eval, data…). */
  blocked: string;
  /** First-party document path (no query). */
  documentPath: string;
  /** Origin + path of the script that triggered it, when known. */
  sourceFile?: string;
  line?: number;
  column?: number;
  /** First 40 chars of the inline sample, when the policy requests samples. */
  sample?: string;
}

type Raw = Record<string, unknown>;

const DIRECTIVE = /^[a-z-]{3,40}$/;
const KEYWORDS = new Set(['inline', 'eval', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink', 'self', 'data', 'blob']);

function str(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.length ? value.slice(0, max) : undefined;
}

function int(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : undefined;
}

/** Origin + path, never query/hash; null for unparsable input. */
export function stripUrl(raw: string | undefined, keepPath = true): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'wss:' || url.protocol === 'ws:') {
      return keepPath ? `${url.origin}${url.pathname}`.slice(0, 200) : url.origin;
    }
    return `${url.protocol.replace(/:$/, '')}`; // data:, blob:, chrome-extension: …
  } catch {
    return undefined;
  }
}

function blockedValue(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const lowered = raw.toLowerCase();
  if (KEYWORDS.has(lowered)) return lowered;
  return stripUrl(raw, false) ?? 'unknown';
}

function directiveValue(effective: unknown, violated: unknown): string | undefined {
  const candidate = (str(effective, 60) || str(violated, 60)?.split(/\s+/)[0] || '').toLowerCase();
  return DIRECTIVE.test(candidate) ? candidate : undefined;
}

function normalise(body: Raw, legacy: boolean): CspViolation | null {
  const get = (modern: string, old: string) => (legacy ? body[old] : body[modern]);
  const directive = directiveValue(get('effectiveDirective', 'effective-directive'), get('violatedDirective', 'violated-directive'));
  if (!directive) return null;
  const documentUrl = stripUrl(str(get('documentURL', 'document-uri'), 2048));
  let documentPath = '/';
  if (documentUrl) {
    try {
      documentPath = new URL(documentUrl).pathname.slice(0, 200);
    } catch {
      /* keep '/' */
    }
  }
  const disposition = get('disposition', 'disposition') === 'enforce' ? 'enforce' : 'report';
  const sample = str(get('sample', 'script-sample'), 40);
  const sourceFile = stripUrl(str(get('sourceFile', 'source-file'), 2048));
  return {
    disposition,
    directive,
    blocked: blockedValue(str(get('blockedURL', 'blocked-uri'), 2048)),
    documentPath,
    ...(sourceFile ? { sourceFile } : {}),
    ...(int(get('lineNumber', 'line-number')) !== undefined ? { line: int(get('lineNumber', 'line-number')) } : {}),
    ...(int(get('columnNumber', 'column-number')) !== undefined ? { column: int(get('columnNumber', 'column-number')) } : {}),
    ...(sample ? { sample } : {}),
  };
}

/** Returns at most CSP_REPORT_MAX_ITEMS sanitised violations; ignores junk. */
export function parseCspReports(payload: unknown): CspViolation[] {
  const out: CspViolation[] = [];
  const push = (value: CspViolation | null) => {
    if (value && out.length < CSP_REPORT_MAX_ITEMS) out.push(value);
  };

  if (Array.isArray(payload)) {
    for (const entry of payload.slice(0, CSP_REPORT_MAX_ITEMS * 2)) {
      if (!entry || typeof entry !== 'object') continue;
      const report = entry as Raw;
      if (report.type !== 'csp-violation' || !report.body || typeof report.body !== 'object') continue;
      push(normalise(report.body as Raw, false));
    }
    return out;
  }

  if (payload && typeof payload === 'object') {
    const legacy = (payload as Raw)['csp-report'];
    if (legacy && typeof legacy === 'object') push(normalise(legacy as Raw, true));
  }
  return out;
}

/** Daily Redis counters: field `directive|blocked|disposition`. */
export function cspAggregationCommands(
  violation: CspViolation,
  day: string,
  ttlSeconds = 30 * 24 * 60 * 60
): Array<Array<string | number>> {
  const key = `csp:v1:${day}`;
  return [
    ['HINCRBY', key, `${violation.directive}|${violation.blocked}|${violation.disposition}`, 1],
    ['EXPIRE', key, ttlSeconds],
  ];
}
