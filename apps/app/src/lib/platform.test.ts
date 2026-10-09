import { describe, expect, it } from "vitest";
import { chooseShell, detectPlatform } from "./platform";

const UA = {
  pixel7:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  ipadOs:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
};

describe("platform", () => {
  it("detects platforms from the user agent", () => {
    expect(detectPlatform(UA.pixel7, 5)).toBe("android");
    expect(detectPlatform(UA.iphone, 5)).toBe("ios");
    expect(detectPlatform(UA.ipadOs, 5)).toBe("ios");
    expect(detectPlatform(UA.ipadOs, 0)).toBe("desktop");
    expect(detectPlatform(UA.windows, 0)).toBe("desktop");
  });

  it("chooses a shell from platform and width", () => {
    expect(chooseShell("android", 412)).toBe("phone");
    expect(chooseShell("android", 800)).toBe("tablet");
    expect(chooseShell("ios", 1366)).toBe("tablet");
    expect(chooseShell("desktop", 500)).toBe("phone");
    expect(chooseShell("desktop", 900)).toBe("tablet");
    expect(chooseShell("desktop", 1440)).toBe("desktop");
  });
});
