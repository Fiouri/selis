import { describe, expect, it } from "vitest";
import { cleanText, imageSize, layoutWords, MIN_CONFIDENCE, type OcrLine, type OcrPage, wordKey } from "./index";

const line = (y0: number, words: Array<[string, number, number, number]>, baselineY = y0 + 40): OcrLine => ({
  bbox: { x0: Math.min(...words.map((w) => w[1])), y0, x1: Math.max(...words.map((w) => w[2])), y1: y0 + 50 },
  baseline: { x0: 0, y0: baselineY, x1: 1000, y1: baselineY },
  words: words.map(([text, x0, x1, confidence]) => ({ text, confidence, bbox: { x0, y0, x1, y1: y0 + 50 } })),
});

describe("layoutWords", () => {
  const page: OcrPage = {
    width: 1000,
    height: 2000,
    lines: [line(100, [["Hello", 100, 300, 95], ["world", 340, 520, 90]]), line(300, [["µε", 100, 160, 11], ["noise", 200, 260, MIN_CONFIDENCE - 1]])],
  };

  it("maps image pixels to page points, on the line's baseline", () => {
    const words = layoutWords(page, 500, 1000);
    expect(words[0]).toEqual({ text: "Hello", x: 50, y: 70, width: 100, fontSize: 50 * 0.82 * 0.5 });
    expect(words[1]).toMatchObject({ text: "world", x: 170, y: 70, width: 90 });
  });

  it("keeps doubtful words, drops noise, and normalises Tesseract's Greek", () => {
    const texts = layoutWords(page, 500, 1000).map((w) => w.text);
    // The micro sign Tesseract reads for μ becomes μ (NFKC); a 11 % word stays, a 9 % one goes.
    expect(texts).toEqual(["Hello", "world", "με"]);
    expect(cleanText(" ﬁle ")).toBe("file");
  });

  it("follows a sloped baseline and keeps words in reading order", () => {
    const sloped: OcrPage = {
      width: 100,
      height: 100,
      lines: [{ ...line(10, [["b", 60, 80, 90], ["a", 10, 30, 90]]), baseline: { x0: 0, y0: 40, x1: 100, y1: 50 } }],
    };
    const words = layoutWords(sloped, 100, 100);
    expect(words.map((w) => w.text)).toEqual(["a", "b"]);
    expect(words[0]?.y).toBeCloseTo(41);
    expect(words[1]?.y).toBeCloseTo(46);
  });

  it("skips empty words and lines without height", () => {
    const empty: OcrPage = { width: 10, height: 10, lines: [line(0, [["  ", 0, 5, 99]]), { ...line(0, [["x", 0, 5, 99]]), bbox: { x0: 0, y0: 5, x1: 5, y1: 5 } }] };
    expect(layoutWords(empty, 10, 10)).toEqual([]);
  });
});

describe("helpers", () => {
  it("compares words without surrounding punctuation", () => {
    expect(wordKey("«απόδειξη»,")).toBe("απόδειξη");
    expect(wordKey("(London).")).toBe("London");
  });

  it("reads PNG and JPEG sizes", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    new DataView(png.buffer).setUint32(16, 2480);
    new DataView(png.buffer).setUint32(20, 3508);
    expect(imageSize(png)).toEqual({ width: 2480, height: 3508 });
    // SOI, APP0 (length 4), SOF0 with height 300, width 200.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 44, 0, 200, 3, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 200, height: 300 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
