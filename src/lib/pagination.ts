/**
 * TMDB list endpoints serve at most 500 pages, whatever `total_pages` says
 * (popular discover queries report thousands). Showing "of 500" would be a
 * made-up number, so a capped count is flagged and the UI shows only the
 * current page.
 */
export const TMDB_MAX_PAGES = 500;

export function tmdbPageCount(...reported: Array<number | string | null | undefined>): {
  totalPages: number;
  totalPagesCapped?: true;
} {
  const largest = Math.max(1, ...reported.map((value) => Number(value) || 0));
  return largest > TMDB_MAX_PAGES
    ? { totalPages: TMDB_MAX_PAGES, totalPagesCapped: true }
    : { totalPages: largest };
}

/** True when the page count is real (not TMDB's 500-page ceiling). */
export function hasExactPageCount(result: { totalPages: number; totalPagesCapped?: boolean }): boolean {
  return !result.totalPagesCapped && result.totalPages < TMDB_MAX_PAGES;
}
