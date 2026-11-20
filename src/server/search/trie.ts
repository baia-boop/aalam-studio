import { foldText } from '@/lib/search-text';

/**
 * Prefix trie for instant title suggestions.
 *
 * - Keys are folded (`@/lib/search-text`: accents, ligatures, apostrophes,
 *   punctuation); every word start of a title is indexed too, so "knight"
 *   finds "The Dark Knight", plus a space-free key so "spiderman" finds
 *   "Spider-Man".
 * - Each node keeps its top-N entities by popularity, so a lookup costs
 *   O(|prefix|) and never walks the subtree.
 * - `fuzzy` performs a bounded Levenshtein walk (row-by-row DP down the trie)
 *   so typos like "intersteller" or "braking bad" still resolve.
 */

export interface TrieEntity {
  key: string;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: string;
  popularity: number;
  posterPath: string | null;
  /** TMDB genre ids, when the source row carried them (optional, additive). */
  genreIds?: number[];
}

interface Node {
  children: Map<string, Node>;
  top: TrieEntity[];
  /** True when a full indexed key ends here. */
  terminal: boolean;
}

const newNode = (): Node => ({ children: new Map(), top: [], terminal: false });

// Folding lives in a shared module so the client highlighter agrees with
// the index on what matched (accents, ligatures, apostrophes, "&").
export { foldText };

export class SuggestTrie {
  private root = newNode();
  private entities = new Map<string, TrieEntity>();

  constructor(private readonly perNode = 20) {}

  get size(): number {
    return this.entities.size;
  }

  insert(entity: TrieEntity): void {
    if (this.entities.has(entity.key)) return;
    this.entities.set(entity.key, entity);
    const folded = foldText(entity.title);
    if (!folded) return;
    const words = folded.split(' ');
    const keys = new Set<string>([folded]);
    for (let i = 1; i < words.length; i++) {
      if (words[i].length >= 2) keys.add(words.slice(i).join(' '));
    }
    // Space-free form: "spiderman" / "wall e" find "Spider-Man" / "WALL·E".
    if (words.length > 1) keys.add(words.join(''));
    for (const key of keys) this.insertKey(key.slice(0, 64), entity);
  }

  private insertKey(key: string, entity: TrieEntity) {
    let node = this.root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = newNode();
        node.children.set(ch, next);
      }
      node = next;
      this.offer(node, entity);
    }
    node.terminal = true;
  }

  private offer(node: Node, entity: TrieEntity) {
    if (node.top.some((e) => e.key === entity.key)) return;
    if (node.top.length >= this.perNode && node.top[node.top.length - 1].popularity >= entity.popularity) return;
    node.top.push(entity);
    node.top.sort((a, b) => b.popularity - a.popularity);
    if (node.top.length > this.perNode) node.top.pop();
  }

  prefix(query: string, limit = 8): TrieEntity[] {
    const folded = foldText(query);
    if (!folded) return [];
    let node: Node | undefined = this.root;
    for (const ch of folded) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    return node.top.slice(0, limit);
  }

  /**
   * Entities whose indexed key prefix is within `maxEdits` of the query.
   * Ranked by edit distance, then popularity.
   */
  fuzzy(query: string, limit = 8, maxEdits = foldText(query).length >= 6 ? 2 : 1): TrieEntity[] {
    const target = [...foldText(query)];
    if (target.length < 3) return [];
    const best = new Map<string, { entity: TrieEntity; distance: number }>();
    const firstRow = target.map((_, i) => i + 1);
    firstRow.unshift(0);

    const walk = (node: Node, ch: string, previous: number[]) => {
      const row = [previous[0] + 1];
      let rowMin = row[0];
      for (let i = 1; i <= target.length; i++) {
        const cost = target[i - 1] === ch ? 0 : 1;
        const value = Math.min(row[i - 1] + 1, previous[i] + 1, previous[i - 1] + cost);
        row.push(value);
        if (value < rowMin) rowMin = value;
      }
      const distance = row[target.length];
      // Treat a match of the whole query against this prefix as a hit.
      if (distance <= maxEdits) {
        for (const entity of node.top) {
          const existing = best.get(entity.key);
          if (!existing || existing.distance > distance) best.set(entity.key, { entity, distance });
        }
        return; // Deeper nodes only add longer, worse prefixes of the same entities.
      }
      if (rowMin > maxEdits) return;
      for (const [nextCh, child] of node.children) walk(child, nextCh, row);
    };

    for (const [ch, child] of this.root.children) walk(child, ch, firstRow);
    return [...best.values()]
      .sort((a, b) => a.distance - b.distance || b.entity.popularity - a.entity.popularity)
      .slice(0, limit)
      .map((v) => v.entity);
  }
}
