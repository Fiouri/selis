import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "./tokens";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** Extracts `--name: #hex` and `--name: var(--other)` declarations from the first block matching `selector`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf("\n}", start);
  const vars = new Map<string, string>();
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6}|var\(--[a-z0-9-]+\))\s*;/gi)) {
    vars.set(m[1] as string, (m[2] as string).toLowerCase());
  }
  return vars;
}

/** A theme's palette: its own block over the light defaults, `var()` references resolved. */
function palette(own: Map<string, string>): Map<string, string> {
  const merged = new Map([...ROOT, ...own]);
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (!ref) return value;
    const next = merged.get(ref[1] as string);
    if (!next || depth > 8) throw new Error(`unresolved ${value}`);
    return resolve(next, depth + 1);
  };
  return new Map([...merged].map(([k, v]) => [k, resolve(v)]));
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

const ROOT = block(":root");
const OWN: Record<(typeof THEMES)[number], Map<string, string>> = {
  light: ROOT,
  dark: block(':root[data-theme="dark"]'),
  sepia: block(':root[data-theme="sepia"]'),
};
const PALETTES = Object.fromEntries(THEMES.map((t) => [t, palette(OWN[t])])) as Record<(typeof THEMES)[number], Map<string, string>>;

/** Surfaces chrome and controls sit on. */
const SURFACES = ["neutral-1", "neutral-2", "neutral-3", "surface-app", "surface-raised"];

/**
 * Every foreground/background pair the UI uses, with its WCAG 2.2 AA minimum: 4.5:1 for text
 * (SC 1.4.3), 3:1 for the parts of controls and graphics needed to see them (SC 1.4.11).
 */
const PAIRS: { fg: string; bgs: string[]; min: number; use: string }[] = [
  { fg: "neutral-12", bgs: SURFACES, min: 7, use: "body text" },
  { fg: "neutral-11", bgs: SURFACES, min: 4.5, use: "secondary text" },
  { fg: "accent-11", bgs: ["neutral-1", "surface-raised"], min: 4.5, use: "links" },
  { fg: "accent-selected", bgs: ["accent-3"], min: 4.5, use: "selected tab / chip / tile text" },
  { fg: "accent-contrast", bgs: ["accent-9"], min: 4.5, use: "primary button text" },
  { fg: "warning-11", bgs: ["neutral-1", "surface-raised"], min: 4.5, use: "warning text" },
  { fg: "danger-11", bgs: ["neutral-1", "surface-raised"], min: 4.5, use: "error text" },
  { fg: "success-11", bgs: ["neutral-1", "surface-raised"], min: 4.5, use: "success text" },
  { fg: "control-line", bgs: SURFACES, min: 3, use: "control borders, unchecked boxes, switch track, grabber" },
  { fg: "neutral-9", bgs: ["neutral-1", "surface-raised"], min: 3, use: "icons" },
  { fg: "accent-9", bgs: ["neutral-1", "surface-raised"], min: 3, use: "selected outline, checked box" },
  { fg: "focus-ring", bgs: ["neutral-1", "surface-raised"], min: 3, use: "focus ring" },
];

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

    it(`${theme}: every token pair meets WCAG 2.2 AA (text 4.5:1, control boundaries 3:1)`, () => {
      const failures: string[] = [];
      for (const { fg, bgs, min, use } of PAIRS) {
        for (const bg of bgs) {
          const ratio = contrast(get(fg), get(bg));
          if (ratio < min) failures.push(`--${fg} on --${bg} (${use}): ${ratio.toFixed(2)} < ${min}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${theme}: the switch knob stands out from the off track`, () => {
      expect(contrast("#ffffff", get("control-line"))).toBeGreaterThanOrEqual(3);
    });
  }

  it("the OS-dark fallback matches the explicit dark palette", () => {
    const start = css.indexOf("@media (prefers-color-scheme: dark)");
    const media = css.slice(start, css.indexOf("\n}\n", start));
    for (const [name, value] of OWN.dark) expect(media, `--${name}`).toContain(`--${name}: ${value};`);
  });

  it("sticky-note paper keeps its text and actions readable (AA)", () => {
    const light = PALETTES.light;
    const paper = light.get("note-paper") as string;
    for (const name of ["note-ink", "note-action", "note-danger", "note-muted"]) {
      expect(contrast(light.get(name) as string, paper), `--${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(light.get("paper-hint") as string, light.get("paper") as string)).toBeGreaterThanOrEqual(4.5);
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
