import { describe, expect, it } from "vitest";
import { resolveTheme } from "./settings";

describe("resolveTheme", () => {
  it("maps system to the OS preference and keeps explicit choices", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("sepia", true)).toBe("sepia");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
