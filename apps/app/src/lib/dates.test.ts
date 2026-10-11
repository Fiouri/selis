import { describe, expect, it } from "vitest";
import { relativeDay } from "./dates";

const NOW = new Date(2026, 9, 11, 15, 0).getTime();
const at = (month: number, day: number, year = 2026) => new Date(year, month, day, 9, 30).getTime();

describe("relativeDay", () => {
  it("says today / yesterday, capitalised, in Greek and English", () => {
    expect(relativeDay(at(9, 11), NOW, "el")).toBe("Σήμερα");
    expect(relativeDay(at(9, 10), NOW, "el")).toBe("Χθες");
    expect(relativeDay(at(9, 11), NOW, "en")).toBe("Today");
    expect(relativeDay(at(9, 10), NOW, "en")).toBe("Yesterday");
  });

  it("uses the weekday within a week, then day + month, then the year", () => {
    expect(relativeDay(at(9, 7), NOW, "en")).toBe("Wednesday");
    expect(relativeDay(at(9, 7), NOW, "el")).toBe("Τετάρτη");
    expect(relativeDay(at(8, 3), NOW, "en")).toBe("Sep 3");
    expect(relativeDay(at(8, 3), NOW, "el")).toMatch(/^3 Σεπ/);
    expect(relativeDay(at(11, 24, 2025), NOW, "en")).toBe("Dec 24, 2025");
  });
});
