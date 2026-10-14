import { describe, expect, it } from "vitest";
import { photoSize } from "./capture";

describe("photoSize", () => {
  it("asks for the sensor's maximum (an exact size) when the worker can scale it down", () => {
    // The Galaxy S23's back camera at the mid tier (8 MP): 12 MP is taken and scaled.
    expect(photoSize({ imageWidth: { max: 4000, min: 176, step: 1 }, imageHeight: { max: 3000, min: 144, step: 1 } }, 8_000_000)).toEqual({
      imageWidth: 4000,
      imageHeight: 3000,
    });
  });

  it("scales the request for a far larger sensor, keeping its proportions", () => {
    const size = photoSize({ imageWidth: { max: 8160, min: 176, step: 16 }, imageHeight: { max: 6120, min: 144, step: 16 } }, 6_000_000);
    expect(size).toEqual({ imageWidth: 2816, imageHeight: 2112 });
  });

  it("gives up without capabilities", () => {
    expect(photoSize({}, 8_000_000)).toBeNull();
  });
});
