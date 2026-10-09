import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "./tokens";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** Extracts `--name: #hex` declarations from the first block matching `selector`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf("\n}", start);
  const vars = new Map<string, string>();
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    vars.set(m[1] as string, (m[2] as string).toLowerCase());
  }
  return vars;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const PALETTES: Record<(typeof THEMES)[number], Map<string, string>> = {
  light: block(":root"),
  dark: block(':root[data-theme="dark"]'),
  sepia: block(':root[data-theme="sepia"]'),
};

describe("design tokens", () => {
  for (const theme of THEMES) {
    const p = PALETTES[theme];
    const get = (name: string) => {
      const v = p.get(name);
      if (!v) throw new Error(`${theme}: --${name} missing`);
      return v;
    };

    it(`${theme}: defines 12 neutral steps`, () => {
      for (let i = 1; i <= 12; i++) expect(p.has(`neutral-${i}`), `--neutral-${i}`).toBe(true);
    });

    it(`${theme}: text meets WCAG 2.2 AA on app background`, () => {
      expect(contrast(get("neutral-12"), get("neutral-1"))).toBeGreaterThanOrEqual(7);
      expect(contrast(get("neutral-11"), get("neutral-1"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get("neutral-11"), get("neutral-3"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get("accent-11"), get("neutral-1"))).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: primary button text is readable`, () => {
      expect(contrast(get("accent-contrast"), get("accent-9"))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("the OS-dark fallback matches the explicit dark palette", () => {
    const start = css.indexOf("@media (prefers-color-scheme: dark)");
    const media = css.slice(start, css.indexOf("\n}\n", start));
    for (const [name, value] of PALETTES.dark) expect(media, `--${name}`).toContain(`--${name}: ${value};`);
  });

  it("motion durations stay within 150–250 ms and honour reduced motion", () => {
    for (const m of css.matchAll(/--duration-[a-z]+:\s*(\d+)ms/g)) {
      const ms = Number(m[1]);
      expect(ms === 0 || (ms >= 150 && ms <= 250)).toBe(true);
    }
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("--touch-target: 44px");
  });
});
