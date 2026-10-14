import { describe, expect, it } from "vitest";
import { pdfjsText } from "./oracle.ts";
import { type SampleLanguage, samples } from "./samples.ts";

describe("store sample documents", () => {
  for (const lang of ["en", "el"] as SampleLanguage[]) {
    for (const sample of samples(lang)) {
      it(`${lang}/${sample.file}: pdf.js reads its pages and text`, { timeout: 30_000 }, async () => {
        const { pages } = await pdfjsText(sample.build());
        expect(pages).toHaveLength(sample.pageCount);
        // pdf.js may split words into items: compare without spaces.
        const squash = (s: string): string => s.replace(/\s+/g, "");
        expect(squash(pages[0] ?? "")).toContain(squash(sample.heading));
      });
    }
  }

  it("has four documents per language, with distinct files", () => {
    const files = [...samples("en"), ...samples("el")].map((s) => s.file);
    expect(files).toHaveLength(8);
    expect(new Set(files).size).toBe(8);
  });
});
