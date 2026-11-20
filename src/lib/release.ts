/**
 * Release state, in one place.
 *
 * TMDB ships a release date (`release_date` for films, `first_air_date` for
 * series) on every list payload, and AALAM normalises it onto `MediaItem`
 * as `releaseDate`. Everything that has to know whether a title is *out yet*
 * reads it from here, so the hero rules, the Coming soon shelf and the
 * playability check cannot disagree about the same title.
 *
 * Missing or invalid dates are unknown, not evidence of release. Dates are
 * compared by UTC calendar day so release day is included from its start.
 *
 * Pure and dependency-free (shared by server feeds, client views and tests).
 */

export type ReleaseInput = { releaseDate?: string | null };

/** Parsed release timestamp, or `null` when the catalogue has no usable date. */
export function releaseTime(item: ReleaseInput): number | null {
  const raw = item.releaseDate;
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === raw ? parsed : null;
}

/** True only with a known release date on or before today (UTC). */
export function isReleased(item: ReleaseInput, now: number = Date.now()): boolean {
  const time = releaseTime(item);
  if (time === null) return false;
  return time <= now;
}

/** True only for a title with a known date in the future. */
export function isUpcoming(item: ReleaseInput, now: number = Date.now()): boolean {
  const time = releaseTime(item);
  if (time === null) return false;
  return time > now;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * `2027-01-16` → `16 Jan 2027`. Formatting is fixed rather than locale-driven so
 * a server-rendered badge cannot change between the server and the browser.
 */
export function releaseDateLabel(item: ReleaseInput): string | null {
  const raw = item.releaseDate;
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) {
    const month = MONTHS[Number(match[2]) - 1];
    if (!month) return null;
    return `${Number(match[3])} ${month} ${match[1]}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

/**
 * The date line a Coming soon card shows. Films open in cinemas; an unreleased
 * series has a premiere, and calling that a theatre release would be wrong.
 */
export function releaseBadgeLabel(item: ReleaseInput & { type?: 'movie' | 'tv'; theatricalReleaseDate?: string; theatricalRegion?: string }): string | null {
  const label = releaseDateLabel({ releaseDate: item.theatricalReleaseDate || item.releaseDate });
  if (!label) return null;
  return item.type === 'tv' ? `Premieres ${label}` : item.theatricalRegion ? `In theatres ${label} · ${item.theatricalRegion}` : `In theatres ${label}`;
}
