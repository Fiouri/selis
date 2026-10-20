import { describe, expect, it } from "vitest";
import { compareCatalogs, translationPass, verdict } from "./check-el";

describe("el.json completeness (ADR 0030 amendment)", () => {
  const en = { a: "A", group: { b: "B", c: "C" } };

  it("lists untranslated and stale keys", () => {
    expect(compareCatalogs(en, { a: "Α", group: { b: "Β" }, old: "Παλιό" })).toEqual({ untranslated: ["group.c"], stale: ["old"] });
    expect(compareCatalogs(en, { a: "Α", group: { b: "Β", c: "Γ" } })).toEqual({ untranslated: [], stale: [] });
  });

  it("warns between release candidates and fails in the translation pass", () => {
    const report = { untranslated: ["group.c"], stale: [] };
    expect(verdict(report, false)).toEqual({ lines: [expect.stringMatching(/^::warning title=el\.json::1 key/)], failed: false });
    expect(verdict(report, true)).toEqual({ lines: [expect.stringMatching(/^::error title=el\.json::1 key/)], failed: true });
  });

  it("always fails on a translation whose English key is gone", () => {
    expect(verdict({ untranslated: [], stale: ["old"] }, false).failed).toBe(true);
  });

  it("reads the translation-pass switch from the environment", () => {
    expect(translationPass({ SELIS_TRANSLATION_PASS: "1" })).toBe(true);
    expect(translationPass({})).toBe(false);
  });
});
