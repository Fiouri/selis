import { describe, expect, it } from "vitest";
import { LruCache } from "./lru";

const bytesOf = (v: Uint8Array) => v.byteLength;
const buf = (n: number) => new Uint8Array(n);

describe("LruCache", () => {
  it("evicts the least recently used entry beyond the count limit", () => {
    const cache = new LruCache<string, Uint8Array>(2, 1000, bytesOf);
    cache.set("a", buf(1));
    cache.set("b", buf(1));
    cache.get("a"); // a is now most recent
    cache.set("c", buf(1));
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.has("b")).toBe(false);
  });

  it("evicts oldest entries until the byte budget fits", () => {
    const cache = new LruCache<string, Uint8Array>(10, 100, bytesOf);
    cache.set("a", buf(40));
    cache.set("b", buf(40));
    cache.set("c", buf(40)); // 120 > 100 → a goes
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.totalBytes).toBe(80);
    cache.set("d", buf(90)); // needs b and c gone
    expect(cache.keys()).toEqual(["d"]);
    expect(cache.totalBytes).toBe(90);
  });

  it("never stores an entry larger than the whole budget", () => {
    const cache = new LruCache<string, Uint8Array>(10, 50, bytesOf);
    cache.set("small", buf(10));
    cache.set("huge", buf(51));
    expect(cache.keys()).toEqual(["small"]);
  });

  it("replacing a key updates its size and recency", () => {
    const cache = new LruCache<string, Uint8Array>(3, 100, bytesOf);
    cache.set("a", buf(10));
    cache.set("b", buf(10));
    cache.set("a", buf(30));
    expect(cache.keys()).toEqual(["b", "a"]);
    expect(cache.totalBytes).toBe(40);
  });

  it("deletes by predicate and clears", () => {
    const cache = new LruCache<string, Uint8Array>(10, 1000, bytesOf);
    cache.set("doc-1:0", buf(5));
    cache.set("doc-1:1", buf(5));
    cache.set("doc-2:0", buf(5));
    cache.deleteWhere((k) => k.startsWith("doc-1:"));
    expect(cache.keys()).toEqual(["doc-2:0"]);
    expect(cache.totalBytes).toBe(5);
    cache.clear();
    expect([cache.size, cache.totalBytes]).toEqual([0, 0]);
  });

  it("stays within both bounds under a long scroll", () => {
    const cache = new LruCache<number, Uint8Array>(8, 48 * 1024 * 1024, bytesOf);
    for (let page = 0; page < 1000; page++) {
      cache.set(page, buf(3.5 * 1024 * 1024));
      expect(cache.size).toBeLessThanOrEqual(8);
      expect(cache.totalBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
    }
    expect(cache.has(999)).toBe(true);
    expect(cache.has(0)).toBe(false);
  });
});
