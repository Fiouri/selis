import { describe, expect, it } from "vitest";
import { parseBootSettings, resolveTheme } from "./settings";

describe("resolveTheme", () => {
  it("maps system to the OS preference and keeps explicit choices", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("sepia", true)).toBe("sepia");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("parseBootSettings", () => {
  it("reads a mirror from before English first (no version) with locale system as English", () => {
    expect(parseBootSettings(JSON.stringify({ locale: "system", theme: "dark" }))).toMatchObject({
      locale: "en",
      theme: "dark",
    });
  });

  it("keeps an explicit Greek, and a system chosen after the upgrade", () => {
    expect(parseBootSettings(JSON.stringify({ locale: "el" })).locale).toBe("el");
    expect(parseBootSettings(JSON.stringify({ v: 2, locale: "system" })).locale).toBe("system");
  });

  it("falls back to English defaults for nothing or garbage", () => {
    expect(parseBootSettings(null).locale).toBe("en");
    expect(parseBootSettings("{not json").locale).toBe("en");
  });
});
