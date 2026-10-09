/**
 * Least-recently-used cache bounded by entry count and by total size.
 * Map iteration order is insertion order, so re-inserting on access keeps the
 * least recently used entry first.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, { value: V; size: number }>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;

  constructor(maxEntries: number, maxBytes: number, sizeOf: (value: V) => number) {
    this.maxEntries = Math.max(0, maxEntries);
    this.maxBytes = Math.max(0, maxBytes);
    this.sizeOf = sizeOf;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Inserts (or refreshes) an entry, then evicts the oldest ones beyond the limits. */
  set(key: K, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxBytes || this.maxEntries === 0) return; // would never fit
    this.entries.set(key, { value, size });
    this.bytes += size;
    this.evict();
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.size;
    return true;
  }

  /** Removes every entry whose key matches. */
  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of [...this.entries.keys()]) if (predicate(key)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
