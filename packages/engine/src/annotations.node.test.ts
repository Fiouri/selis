/**
 * Annotations through the real PDFium WASM: every editor kind is written,
 * saved as a new PDF, reopened and read back as the same annotation. Also pins
 * the EmbedPDF internals that annotations.ts relies on.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfAnnotationObject, PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { FIXTURES, type FixtureName } from "@selis/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { fromPdfAnnotation, TEXT_STAMP_PREFIX, TextStamps, toPdfAnnotation } from "./annotations";
import type { Annotation } from "./types";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
let engine: PdfiumNative;
let stamps: TextStamps;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  stamps = new TextStamps(engine, pdf, () => Promise.resolve(FONT));
}, 60_000);

let nextId = 0;
async function open(content: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `doc-${nextId++}`, content }).toPromise();
}

function fixture(name: FixtureName): ArrayBuffer {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(name);
  return f.build().slice().buffer;
}

function firstPage(doc: PdfDocumentObject): PdfPageObject {
  const page = doc.pages[0];
  if (!page) throw new Error("no page");
  return page;
}

async function add(doc: PdfDocumentObject, a: Annotation): Promise<void> {
  const page = doc.pages[a.page];
  if (!page) throw new Error("no page");
  if (a.kind === "text") await stamps.create(doc, page, a);
  else if (a.kind !== "other") await engine.createPageAnnotation(doc, page, toPdfAnnotation(a)).toPromise();
}

async function read(doc: PdfDocumentObject, index = 0): Promise<Annotation[]> {
  const page = doc.pages[index];
  if (!page) throw new Error("no page");
  const raw = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
  const styles = stamps.styles(
    doc,
    page,
    raw.filter((a) => a.id.startsWith(TEXT_STAMP_PREFIX)).map((a) => a.id),
  );
  return raw.map((a) => fromPdfAnnotation(a, styles.get(a.id) ?? null));
}

async function saveAndReopen(doc: PdfDocumentObject): Promise<PdfDocumentObject> {
  const bytes = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  return open(bytes);
}

/** Pixels darker than mid-grey inside `rect` (page points), rendered at 2×. */
async function inkIn(doc: PdfDocumentObject, rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  const raw = await engine
    .renderPageRect(doc, firstPage(doc), { origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }, {
      scaleFactor: 2,
      dpr: 1,
      withAnnotations: true,
    })
    .toPromise();
  let n = 0;
  for (let i = 0; i < raw.data.length; i += 4) if ((raw.data[i] as number) < 128) n++;
  return n;
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.6);

describe("annotations survive save + reopen", () => {
  const rect = { x: 72, y: 100, width: 120, height: 14 };
  const kinds: Annotation[] = [
    { id: "a-highlight", page: 0, kind: "highlight", rect, color: "#f4c430", opacity: 0.42, segments: [rect] },
    { id: "a-underline", page: 0, kind: "underline", rect, color: "#6ea8f0", opacity: 1, segments: [rect] },
    { id: "a-strike", page: 0, kind: "strikeout", rect, color: "#ef7fae", opacity: 1, segments: [rect] },
    {
      id: "a-ink",
      page: 0,
      kind: "ink",
      rect: { x: 98, y: 198, width: 104, height: 54 },
      color: "#1f3a8a",
      opacity: 1,
      width: 3,
      strokes: [
        [
          { x: 100, y: 200 },
          { x: 150, y: 250 },
          { x: 200, y: 210 },
        ],
      ],
    },
    { id: "a-square", page: 0, kind: "square", rect: { x: 300, y: 300, width: 80, height: 40 }, color: "#5fbf7f", opacity: 1, width: 2, fill: null },
    { id: "a-circle", page: 0, kind: "circle", rect: { x: 300, y: 400, width: 60, height: 60 }, color: "#f39a4a", opacity: 1, width: 2, fill: "#ffffff" },
    {
      id: "a-arrow",
      page: 0,
      kind: "arrow",
      rect: { x: 90, y: 490, width: 120, height: 40 },
      color: "#000000",
      opacity: 1,
      width: 2,
      start: { x: 100, y: 500 },
      end: { x: 200, y: 520 },
    },
    { id: "a-note", page: 0, kind: "note", rect: { x: 400, y: 120, width: 20, height: 20 }, color: "#f4c430", opacity: 1, text: "Σχόλιο: έλεγχος" },
  ];

  for (const a of kinds) {
    it(a.kind, async () => {
      const doc = await open(fixture("mixed-sizes"));
      await add(doc, a);
      const back = (await read(await saveAndReopen(doc))).find((x) => x.id === a.id);
      if (!back) throw new Error("annotation lost on save");
      expect(back.kind).toBe(a.kind);
      expect(back.color).toBe(a.color);
      near(back.opacity, a.opacity);
      switch (back.kind) {
        case "highlight":
        case "underline":
        case "strikeout":
          expect(back.segments).toHaveLength(1);
          near(back.segments[0]?.x ?? 0, rect.x);
          near(back.segments[0]?.y ?? 0, rect.y);
          break;
        case "ink":
          if (a.kind !== "ink") break;
          near(back.width, a.width);
          expect(back.strokes[0]).toHaveLength(3);
          near(back.strokes[0]?.[1]?.y ?? 0, 250);
          break;
        case "square":
        case "circle":
          if (a.kind !== back.kind) break;
          expect(back.fill).toBe(a.fill);
          break;
        case "arrow":
          near(back.end.x, 200);
          near(back.end.y, 520);
          break;
        case "note":
          expect(back.text).toBe("Σχόλιο: έλεγχος");
          break;
      }
    });
  }
});

describe("typed text (stamp with the embedded Latin + Greek font)", () => {
  it("draws Greek and Latin, keeps text and style, and reads upright", async () => {
    const doc = await open(fixture("mixed-sizes"));
    const box = { x: 72, y: 300, width: 220, height: 20 };
    const text: Annotation = {
      id: `${TEXT_STAMP_PREFIX}1`,
      page: 0,
      kind: "text",
      rect: box,
      color: "#1f3a8a",
      opacity: 1,
      text: "Καλημέρα κόσμε — Hello\nδεύτερη γραμμή",
      fontSize: 16,
    };
    const stored = await stamps.create(doc, firstPage(doc), text);
    // Two lines: the box grew to fit them.
    expect(stored.height).toBeGreaterThan(2 * 16);
    const reopened = await saveAndReopen(doc);
    const back = (await read(reopened)).find((a) => a.id === text.id);
    expect(back).toMatchObject({ kind: "text", text: text.text, fontSize: 16, color: "#1f3a8a" });
    // The glyphs are really drawn (the standard-14 FreeText path draws ~nothing for Greek).
    expect(await inkIn(reopened, stored)).toBeGreaterThan(1500);
  });

  it("wraps long lines to the box width", async () => {
    const doc = await open(fixture("mixed-sizes"));
    const stored = await stamps.create(doc, firstPage(doc), {
      id: `${TEXT_STAMP_PREFIX}2`,
      page: 0,
      kind: "text",
      rect: { x: 72, y: 72, width: 120, height: 10 },
      color: "#000000",
      opacity: 1,
      text: "ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ",
      fontSize: 12,
    });
    expect(stored.width).toBeLessThanOrEqual(121);
    expect(stored.height).toBeGreaterThan(3 * 12);
  });

  it("replaces a stamp written again with the same id", async () => {
    const doc = await open(fixture("mixed-sizes"));
    const a = {
      id: `${TEXT_STAMP_PREFIX}3`,
      page: 0,
      kind: "text" as const,
      rect: { x: 72, y: 72, width: 200, height: 10 },
      color: "#000000",
      opacity: 1,
      text: "πρώτο",
      fontSize: 12,
    };
    await stamps.create(doc, firstPage(doc), a);
    await stamps.create(doc, firstPage(doc), { ...a, text: "δεύτερο" });
    const texts = (await read(doc)).filter((x) => x.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "δεύτερο" });
  });
});

/**
 * With SELIS_SAMPLES=<dir>, writes the fixtures with every kind of annotation
 * there, for checks in other readers (Chrome's viewer, pypdf; see the P2a PR).
 */
describe.runIf(Boolean(process.env.SELIS_SAMPLES))("samples for other readers", () => {
  it("writes greek + mixed-sizes with every annotation kind", async () => {
    const { writeFileSync } = await import("node:fs");
    for (const name of ["greek", "mixed-sizes"] as const) {
      const doc = await open(fixture(name));
      const page = firstPage(doc);
      const kinds: Annotation[] = [
        { id: "s-hl", page: 0, kind: "highlight", rect: { x: 56, y: 120, width: 200, height: 16 }, color: "#f4c430", opacity: 0.42, segments: [{ x: 56, y: 120, width: 200, height: 16 }] },
        { id: "s-ul", page: 0, kind: "underline", rect: { x: 56, y: 146, width: 200, height: 16 }, color: "#6ea8f0", opacity: 1, segments: [{ x: 56, y: 146, width: 200, height: 16 }] },
        { id: "s-so", page: 0, kind: "strikeout", rect: { x: 56, y: 172, width: 200, height: 16 }, color: "#ef7fae", opacity: 1, segments: [{ x: 56, y: 172, width: 200, height: 16 }] },
        { id: "s-ink", page: 0, kind: "ink", rect: { x: 98, y: 298, width: 204, height: 84 }, color: "#211f1a", opacity: 1, width: 3, strokes: [[{ x: 100, y: 300 }, { x: 160, y: 380 }, { x: 220, y: 320 }, { x: 300, y: 360 }]] },
        { id: "s-sq", page: 0, kind: "square", rect: { x: 340, y: 300, width: 120, height: 70 }, color: "#5fbf7f", opacity: 1, width: 2, fill: null },
        { id: "s-ci", page: 0, kind: "circle", rect: { x: 340, y: 400, width: 90, height: 90 }, color: "#f39a4a", opacity: 1, width: 2, fill: null },
        { id: "s-ar", page: 0, kind: "arrow", rect: { x: 90, y: 420, width: 200, height: 70 }, color: "#211f1a", opacity: 1, width: 2, start: { x: 100, y: 480 }, end: { x: 280, y: 430 } },
        { id: "s-note", page: 0, kind: "note", rect: { x: 500, y: 120, width: 20, height: 20 }, color: "#f4c430", opacity: 1, text: "Σημείωση: έλεγχος σε άλλον αναγνώστη" },
        { id: `${TEXT_STAMP_PREFIX}s`, page: 0, kind: "text", rect: { x: 56, y: 520, width: 260, height: 20 }, color: "#24438f", opacity: 1, text: "Πληκτρολογημένο κείμενο — typed text", fontSize: 16 },
      ];
      for (const a of kinds) await add(doc, a);
      expect(page.index).toBe(0);
      const bytes = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
      writeFileSync(`${process.env.SELIS_SAMPLES}/annotated-${name}.pdf`, new Uint8Array(bytes));
    }
  });

  it("writes large-1000 with 50 annotations (memory gate, docs/spike-p0.md)", async () => {
    const { writeFileSync } = await import("node:fs");
    const doc = await open(fixture("large-1000"));
    const kinds = ["highlight", "ink", "square", "text", "note"] as const;
    for (let i = 0; i < 50; i++) {
      // Pages 1–25 and 976–1000: the start and the end of the full scroll.
      const page = i < 25 ? i : 975 + (i - 25);
      const kind = kinds[i % kinds.length] as (typeof kinds)[number];
      const base = { id: `${kind === "text" ? TEXT_STAMP_PREFIX : "m-"}${i}`, page, color: "#24438f", opacity: 1 };
      const rect = { x: 72, y: 200, width: 220, height: 40 };
      const a: Annotation =
        kind === "highlight"
          ? { ...base, kind, rect, opacity: 0.42, color: "#f4c430", segments: [rect] }
          : kind === "ink"
            ? { ...base, kind, rect, width: 3, strokes: [[{ x: 72, y: 220 }, { x: 150, y: 240 }, { x: 292, y: 205 }]] }
            : kind === "square"
              ? { ...base, kind, rect, width: 2, fill: null }
              : kind === "text"
                ? { ...base, kind, rect, text: `Σημείωση ${i + 1} — annotation ${i + 1}`, fontSize: 14 }
                : { ...base, kind, rect: { x: 500, y: 80, width: 20, height: 20 }, text: `Σχόλιο ${i + 1}` };
      await add(doc, a);
    }
    const bytes = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    writeFileSync(`${process.env.SELIS_SAMPLES}/large-1000-annotated.pdf`, new Uint8Array(bytes));
    const reopened = await open(bytes);
    expect(reopened.pageCount).toBe(1000);
    expect(await read(reopened, 999)).toHaveLength(1);
  });
});

describe("foreign and form annotations", () => {
  it("are read as 'other' and never as editable kinds", async () => {
    const doc = await open(fixture("acroform"));
    const items = await read(doc);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((a) => a.kind === "other")).toBe(true);
  });
});

describe("removal", () => {
  it("removes by id and the save no longer carries it", async () => {
    const doc = await open(fixture("mixed-sizes"));
    const page = firstPage(doc);
    const a: Annotation = { id: "gone", page: 0, kind: "square", rect: { x: 50, y: 50, width: 20, height: 20 }, color: "#000000", opacity: 1, width: 1, fill: null };
    await add(doc, a);
    const raw = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
    const found = raw.find((x) => x.id === "gone");
    if (!found) throw new Error("not created");
    expect(await engine.removePageAnnotation(doc, page, found).toPromise()).toBe(true);
    expect((await read(await saveAndReopen(doc))).some((x) => x.id === "gone")).toBe(false);
  });
});
