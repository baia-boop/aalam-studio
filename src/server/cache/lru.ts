/**
 * Bounded TTL LRU cache. A Map keeps insertion order, so re-inserting on read
 * moves an entry to the most-recently-used end and the first key is always the
 * eviction candidate. O(1) get/set, no timers, no dependencies.
 */
interface Entry<V> {
  value: V;
  /** Fresh until this time (ms epoch). */
  freshUntil: number;
  /** Servable as stale until this time; evicted after it. */
  staleUntil: number;
}

export interface LruStats {
  size: number;
  maxEntries: number;
  hits: number;
  staleHits: number;
  misses: number;
  evictions: number;
}

export class LruCache<V = unknown> {
  private readonly map = new Map<string, Entry<V>>();
  private hits = 0;
  private staleHits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxEntries = 5000) {}

  /** Returns the value and whether it is still fresh. */
  peek(key: string, now = Date.now()): { value: V; fresh: boolean } | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.staleUntil <= now) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    const fresh = entry.freshUntil > now;
    if (fresh) this.hits += 1;
    else this.staleHits += 1;
    return { value: entry.value, fresh };
  }

  get(key: string): V | undefined {
    const hit = this.peek(key);
    return hit?.fresh ? hit.value : undefined;
  }

  set(key: string, value: V, ttlSeconds: number, staleSeconds = 0, now = Date.now()): void {
    if (ttlSeconds <= 0) return;
    this.map.delete(key);
    this.map.set(key, {
      value,
      freshUntil: now + ttlSeconds * 1000,
      staleUntil: now + (ttlSeconds + Math.max(0, staleSeconds)) * 1000,
    });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evictions += 1;
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  deletePrefix(prefix: string): number {
    let removed = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }

  stats(): LruStats {
    return {
      size: this.map.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
