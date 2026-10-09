import { describe, expect, it } from "vitest";
import { FIXTURES } from "./corpus.ts";
import { rc4 } from "./rc4.ts";

const latin1 = new TextDecoder("latin1");

describe("fixture corpus", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: has a valid header, xref and trailer`, () => {
      const text = latin1.decode(fixture.build());
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

  it("generation is deterministic", () => {
    for (const fixture of FIXTURES) expect(fixture.build()).toEqual(fixture.build());
  });
});

describe("rc4", () => {
  it("matches the RFC 6229 test vector (key 0102030405)", () => {
    const out = rc4(Uint8Array.from([1, 2, 3, 4, 5]), new Uint8Array(16));
    expect(Buffer.from(out).toString("hex")).toBe("b2396305f03dc027ccc3524a0a1118a8");
  });
});
