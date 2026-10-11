import { describe, expect, it } from "vitest";
import { FIXTURES } from "./corpus.ts";
import { rc4 } from "./rc4.ts";

const latin1 = new TextDecoder("latin1");

/** Each fixture is built once per run and shared by the tests below. */
const built = new Map<string, Uint8Array>();
function build(fixture: (typeof FIXTURES)[number]): Uint8Array {
  let bytes = built.get(fixture.name);
  if (!bytes) {
    bytes = fixture.build();
    built.set(fixture.name, bytes);
  }
  return bytes;
}

/**
 * Building the corpus (the 1000-page file above all) is CPU-bound: ~1 s alone,
 * but well over the 5 s default when the full parallel `vitest run` shares a
 * loaded machine. The tests are deterministic, only slow, so they get room.
 */
const BUILD_TIMEOUT_MS = 60_000;

describe("fixture corpus", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: has a valid header, xref and trailer`, { timeout: BUILD_TIMEOUT_MS }, () => {
      const text = latin1.decode(build(fixture));
      expect(text.startsWith("%PDF-1.7\n")).toBe(true);
      expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

      const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)?.[1]);
      expect(text.slice(startxref, startxref + 4)).toBe("xref");

      // Every xref offset must point at "<n> 0 obj".
      const xref = text.slice(startxref).split("\n");
      const count = Number(xref[1]?.split(" ")[1]);
      expect(count).toBeGreaterThan(1);
      for (let num = 1; num < count; num++) {
        const offset = Number(xref[2 + num]?.slice(0, 10));
        expect(text.slice(offset, offset + `${num} 0 obj`.length)).toBe(`${num} 0 obj`);
      }
    });
  }

  it("generation is deterministic", { timeout: BUILD_TIMEOUT_MS }, () => {
    // One fresh build per fixture against the cached one: half the work of building twice.
    for (const fixture of FIXTURES) expect(fixture.build()).toEqual(build(fixture));
  });
});

describe("rc4", () => {
  it("matches the RFC 6229 test vector (key 0102030405)", () => {
    const out = rc4(Uint8Array.from([1, 2, 3, 4, 5]), new Uint8Array(16));
    expect(Buffer.from(out).toString("hex")).toBe("b2396305f03dc027ccc3524a0a1118a8");
  });
});
