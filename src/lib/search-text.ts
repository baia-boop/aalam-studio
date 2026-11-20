/**
 * Language-neutral text folding shared by the server suggest index and the
 * client highlighter, so "what matched" on screen is exactly what the index
 * matched on.
 *
 * Folding, per code point:
 * - NFKD + strip combining marks  ("Amélie" → "amelie", "Pokémon" → "pokemon")
 * - transliterate letters NFKD leaves alone ("Æon" → "aeon", "Straße" → "strasse",
 *   "Łódź" → "lodz", "Øresund" → "oresund")
 * - apostrophes vanish ("Ocean's" → "oceans", so "oceans eleven" matches)
 * - "&" reads as "and"; any other punctuation separates words
 *
 * Folding is per character (no context-sensitive lower-casing), which keeps the
 * folded string mappable back onto the original for highlighting.
 */

const TRANSLITERATIONS: Record<string, string> = {
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ß: 'ss',
  ẞ: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
  ŋ: 'ng',
};

// Matching combining marks is the whole purpose of this pattern: NFKD splits a
// letter into base + mark, and the mark is exactly what gets stripped below.
// `no-misleading-character-class` exists to catch combining marks that reached a
// class by accident (in `/[á]/` the entry is two code points and matches
// neither "a" nor "á"), which is the opposite of the intent here — hence the
// single-line disable rather than a rewritten pattern.
// eslint-disable-next-line no-misleading-character-class
const COMBINING_MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
const APOSTROPHES = /^['’‘`´ʼʹ]$/;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/** Folds one code point; returns '' (dropped) or ' ' (word separator) or letters. */
export function foldChar(ch: string): string {
  if (APOSTROPHES.test(ch)) return '';
  if (ch === '&') return ' and ';
  const base = ch.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
  let out = '';
  for (const c of base) {
    const mapped = TRANSLITERATIONS[c] ?? c;
    out += WORD_CHAR.test(mapped.charAt(0)) ? mapped : ' ';
  }
  return out;
}

export function foldText(text: string): string {
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out.replace(/\s+/g, ' ').trim();
}

/** Folded form without spaces: "Spider-Man" and "spiderman" agree. */
export function compactFold(text: string): string {
  return foldText(text).replace(/ /g, '');
}

/** Folded query words, longest first (so "star" never pre-empts "starship"). */
export function queryTokens(query: string): string[] {
  return Array.from(new Set(foldText(query).split(' ').filter(Boolean))).sort(
    (a, b) => b.length - a.length
  );
}

export type MatchKind = 'exact' | 'prefix' | 'partial';

/** How a title relates to the query, after folding. */
export function titleMatchKind(title: string, query: string): MatchKind {
  const t = foldText(title);
  const q = foldText(query);
  if (!q) return 'partial';
  if (t === q || compactFold(title) === compactFold(query)) return 'exact';
  return t.startsWith(q) ? 'prefix' : 'partial';
}

export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Ranges (UTF-16 offsets into `text`) to highlight for `query`.
 *
 * A query word matches at the start of a title word ("kni" → "The Dark
 * <Kni>ght"); words of 3+ characters may also match inside a word when no
 * word-start match exists. Accents, ligatures and case are ignored, so
 * "amelie" highlights "Amélie". Overlapping ranges are merged.
 */
export function highlightRanges(text: string, query: string): HighlightRange[] {
  const tokens = queryTokens(query);
  if (!text || tokens.length === 0) return [];

  // Folded string plus, for every folded char, the original [start, end).
  let folded = '';
  const origin: Array<[number, number]> = [];
  let offset = 0;
  for (const ch of text) {
    const piece = foldChar(ch);
    for (const f of piece) {
      folded += f;
      origin.push([offset, offset + ch.length]);
    }
    offset += ch.length;
  }

  const ranges: HighlightRange[] = [];
  const claimed = new Array<boolean>(folded.length).fill(false);
  const take = (at: number, length: number) => {
    for (let i = at; i < at + length; i++) claimed[i] = true;
    ranges.push({ start: origin[at][0], end: origin[at + length - 1][1] });
  };
  const free = (at: number, length: number) => {
    for (let i = at; i < at + length; i++) if (claimed[i]) return false;
    return true;
  };

  for (const token of tokens) {
    let found = false;
    for (let at = folded.indexOf(token); at >= 0; at = folded.indexOf(token, at + 1)) {
      const wordStart = at === 0 || folded[at - 1] === ' ';
      if (wordStart && free(at, token.length)) {
        take(at, token.length);
        found = true;
      }
    }
    if (!found && token.length >= 3) {
      const at = folded.indexOf(token);
      if (at >= 0 && free(at, token.length)) take(at, token.length);
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged: HighlightRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Splits `text` into plain/highlighted segments for rendering. */
export function highlightSegments(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return [{ text, match: false }];
  const out: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
  return out;
}
