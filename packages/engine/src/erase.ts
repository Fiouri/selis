/**
 * Erasing page content (P7b, ADR 0033), worker side. Everything drawn inside
 * the area leaves the file, through the redaction path of ADR 0009, and the
 * area is painted with a fill colour (no box, no annotation):
 *
 * 1. Un-share: every image or form XObject drawn on the page that meets the
 *    area gets its own copy under a new name. PDFium blanks image pixels and
 *    rewrites forms in place (measured: a shared image lost its pixels on the
 *    other page too), so the copies keep the rest of the document as it was.
 * 2. PDFium (`EPDFText_RedactInQuads`, forms included): the glyphs under the
 *    area leave the text objects and the image pixels under it are blanked in
 *    the image data itself.
 * 3. Paths: PDFium leaves vector paths whole, so each path that meets the area
 *    is cut geometrically (path-clip.ts) in the content stream, page and forms.
 *    The fill is painted last, over the area.
 * 4. The file is written anew with only the objects still reachable (pdf-objects.ts),
 *    so the old content streams and image data do not survive.
 *
 * Runs on scratch copies and returns new bytes; the worker swaps the open
 * document for them. A document with an owner password is written without it,
 * as for redaction (its streams must be readable to be rewritten).
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject } from "@embedpdf/models";
import type { EmbeddedText } from "./annotations";
import {
  apply,
  ContentSyntaxError,
  fmt,
  IDENTITY,
  invert,
  mapSubpaths,
  type Matrix,
  maxScale,
  multiply,
  operations,
  type PaintEvent,
  pathText,
  splice,
  walk,
} from "./content-stream";
import type { PageRect } from "./geometry";
import { type Box, boxesMeet, clipFill, clipStroke, pathMeets, shrinkBoxes, type Subpath } from "./path-clip";
import {
  bytesToLatin1,
  decodeStream,
  deflate,
  latin1ToBytes,
  nameOf,
  type PdfDict,
  PdfDocumentObjects,
  type PdfObj,
} from "./pdf-objects";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { documentPointer, removePageObject, toUserSpace } from "./pdfium-objects";
import type { EraseArea, PageObjectInfo } from "./types";

export class EraseError extends Error {
  override readonly name = "EraseError";
}

let scratchId = 0;

async function withScratch<T>(engine: PdfiumNative, bytes: ArrayBuffer, use: (doc: PdfDocumentObject) => Promise<T>): Promise<T> {
  const doc = await engine.openDocumentBuffer({ id: `erase-${scratchId++}`, content: bytes.slice(0) }).toPromise();
  try {
    return await use(doc);
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

type Stream = Extract<PdfObj, { t: "stream" }>;
type Ctx = { readonly doc: PdfDocumentObjects; readonly boxes: readonly Box[]; readonly changed: Set<Stream>; next: number };

const num = (o: PdfObj | undefined): number | null => (o?.t === "num" ? Number(o.v) : null);

function matrixOf(doc: PdfDocumentObjects, o: PdfObj | undefined): Matrix {
  const arr = doc.array(o)?.map((x) => num(doc.get(x)));
  return arr && arr.length === 6 && arr.every((x) => x !== null) ? (arr as unknown as Matrix) : IDENTITY;
}

/** The page-space bounding box of a unit square or form BBox drawn with `m`. */
function drawnBox(corners: readonly [number, number, number, number], m: Matrix): Box {
  const [x0, y0, x1, y1] = corners;
  const pts = [apply(m, { x: x0, y: y0 }), apply(m, { x: x1, y: y0 }), apply(m, { x: x0, y: y1 }), apply(m, { x: x1, y: y1 })];
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

type XObject = { readonly stream: Stream; readonly form: boolean; readonly box: Box; readonly matrix: Matrix };

/** The image or form XObject `name` and where it lands in page space, or null. */
function xobject(ctx: Ctx, resources: PdfDict, name: string, ctm: Matrix): XObject | null {
  const target = ctx.doc.get(ctx.doc.dict(resources.get("XObject"))?.get(name));
  if (target.t !== "stream") return null;
  const subtype = nameOf(target.dict.get("Subtype"));
  if (subtype === "Image") return { stream: target, form: false, box: drawnBox([0, 0, 1, 1], ctm), matrix: ctm };
  if (subtype !== "Form") return null;
  const bbox = ctx.doc.array(target.dict.get("BBox"))?.map((x) => num(ctx.doc.get(x)) ?? 0);
  const matrix = multiply(matrixOf(ctx.doc, target.dict.get("Matrix")), ctm);
  const corners: [number, number, number, number] =
    bbox && bbox.length === 4 ? [bbox[0] ?? 0, bbox[1] ?? 0, bbox[2] ?? 0, bbox[3] ?? 0] : [-1e9, -1e9, 1e9, 1e9];
  return { stream: target, form: true, box: drawnBox(corners, matrix), matrix };
}

/** A resource dictionary of one's own: the dict copied, its XObject subdictionary too. */
function ownResources(doc: PdfDocumentObjects, resources: PdfDict | null): PdfDict {
  const copy: PdfDict = new Map(resources ?? []);
  const xobjects = doc.dict(copy.get("XObject"));
  copy.set("XObject", { t: "dict", v: new Map(xobjects ?? []) });
  return copy;
}

async function contentOf(doc: PdfDocumentObjects, contents: PdfObj | undefined): Promise<string> {
  const target = doc.get(contents);
  const parts = target.t === "arr" ? target.v.map((x) => doc.get(x)) : [target];
  const out: string[] = [];
  for (const part of parts) {
    if (part.t !== "stream") continue;
    const data = await decodeStream(part);
    if (!data) throw new EraseError("a content stream uses an encoding the erase cannot rewrite");
    out.push(bytesToLatin1(data));
  }
  return out.join("\n");
}

function setStreamText(ctx: Ctx, stream: Stream, text: string): void {
  stream.data = latin1ToBytes(text);
  stream.dict.delete("Filter");
  stream.dict.delete("DecodeParms");
  stream.dict.delete("DL");
  ctx.changed.add(stream);
}

/**
 * Pass 1: gives every XObject drawn in `text` that meets the area a copy of its
 * own under a new name (recursively inside forms). Returns the new content, or
 * null when nothing was renamed.
 */
async function unshareContent(ctx: Ctx, text: string, resources: PdfDict, base: Matrix): Promise<string | null> {
  const draws: { name: string; ctm: Matrix; start: number; end: number }[] = [];
  walk(operations(text), base, { onDo: (e) => draws.push({ name: e.name, ctm: e.ctm, start: e.nameStart, end: e.nameEnd }) });
  const xobjects = ctx.doc.dict(resources.get("XObject"));
  const edits: { start: number; end: number; text: string }[] = [];
  for (const draw of draws) {
    const x = xobject(ctx, resources, draw.name, draw.ctm);
    if (!x || !xobjects || !ctx.boxes.some((b) => boxesMeet(x.box, b))) continue;
    const copy: Stream = { t: "stream", dict: new Map(x.stream.dict), data: x.stream.data };
    if (x.form) {
      const own = ownResources(ctx.doc, ctx.doc.dict(x.stream.dict.get("Resources")) ?? resources);
      copy.dict.set("Resources", { t: "dict", v: own });
      const inner = await decodeStream(x.stream);
      if (inner) {
        const renamed = await unshareContent(ctx, bytesToLatin1(inner), own, x.matrix);
        if (renamed !== null) setStreamText(ctx, copy, renamed);
      }
    }
    const name = `SelisE${ctx.next++}`;
    xobjects.set(name, ctx.doc.add(copy));
    edits.push({ start: draw.start, end: draw.end, text: `/${name}` });
  }
  return edits.length > 0 ? splice(text, edits) : null;
}

const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);
const CLOSES = new Set(["s", "b", "b*"]);

/** The operators that replace one painted path, or null to keep it as it is. */
function cutPath(e: PaintEvent, boxes: readonly Box[]): string | null {
  const fills = FILLS.has(e.op);
  const strokes = STROKES.has(e.op);
  if (!fills && !strokes) return null;
  const inverse = invert(e.ctm);
  if (!inverse) return null;
  const user: Subpath[] = CLOSES.has(e.op) ? e.subpaths.map((sp) => ({ ...sp, closed: true })) : [...e.subpaths];
  const page = mapSubpaths(user, e.ctm);
  // A stroke keeps its centre line within half its width of the area's edge, so the
  // outside renders as before; the fill covers that part.
  const strokeBoxes = shrinkBoxes(boxes, (e.lineWidth * maxScale(e.ctm)) / 2);
  const cutFill = fills && pathMeets(page, boxes);
  const cutStroke = strokes && pathMeets(page, strokeBoxes);
  if (!cutFill && !cutStroke) return null;
  const parts: string[] = [];
  if (fills) {
    const kept = cutFill ? mapSubpaths(clipFill(page, boxes), inverse) : user;
    if (kept.length > 0) parts.push(`${pathText(kept)}\n${e.op.endsWith("*") ? "f*" : "f"}`);
  }
  if (strokes) {
    const kept = cutStroke ? mapSubpaths(clipStroke(page, strokeBoxes), inverse) : user;
    if (kept.length > 0) parts.push(`${pathText(kept)}\nS`);
  }
  // A clip set with this path still clips with the whole path (it hides, it draws nothing).
  if (e.clip) parts.push(`${pathText(e.subpaths)}\n${e.clip} n`);
  return parts.join("\n");
}

function lineWidthOf(doc: PdfDocumentObjects, resources: PdfDict, name: string): number | undefined {
  const gs = doc.dict(doc.dict(resources.get("ExtGState"))?.get(name));
  return num(doc.get(gs?.get("LW"))) ?? undefined;
}

/** Pass 3: cuts the paths that meet the area, in the content and the forms it draws. */
async function cutContent(ctx: Ctx, text: string, resources: PdfDict, base: Matrix): Promise<{ text: string | null; paths: number }> {
  const edits: { start: number; end: number; text: string }[] = [];
  const forms: XObject[] = [];
  walk(operations(text), base, {
    lineWidthOf: (name) => lineWidthOf(ctx.doc, resources, name),
    onPaint: (e) => {
      const replacement = cutPath(e, ctx.boxes);
      if (replacement !== null) edits.push({ start: e.start, end: e.end, text: replacement });
    },
    onDo: (e) => {
      const x = xobject(ctx, resources, e.name, e.ctm);
      if (x?.form && ctx.boxes.some((b) => boxesMeet(x.box, b))) forms.push(x);
    },
  });
  let paths = edits.length;
  for (const form of forms) {
    const inner = await decodeStream(form.stream);
    if (!inner) continue;
    const own = ctx.doc.dict(form.stream.dict.get("Resources")) ?? resources;
    const cut = await cutContent(ctx, bytesToLatin1(inner), own, form.matrix);
    if (cut.text !== null) setStreamText(ctx, form.stream, cut.text);
    paths += cut.paths;
  }
  return { text: edits.length > 0 ? splice(text, edits) : null, paths };
}

/** #rrggbb as PDF RGB components (0–1). */
export function rgbOf(hex: string): [number, number, number] {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new EraseError(`not a colour: ${hex}`);
  return [1, 2, 3].map((k) => Number.parseInt(m[k] as string, 16) / 255) as [number, number, number];
}

function pageOf(doc: PdfDocumentObjects, index: number): { dict: PdfDict; resources: PdfDict | null } {
  const page = doc.pages()[index];
  if (!page) throw new EraseError(`no page ${index + 1}`);
  return page;
}

function writeContents(ctx: Ctx, page: PdfDict, text: string): void {
  const stream: Stream = { t: "stream", dict: new Map(), data: new Uint8Array() };
  setStreamText(ctx, stream, text);
  page.set("Contents", ctx.doc.add(stream));
}

/** Compresses every stream written in this pass and writes the file anew. */
async function finish(ctx: Ctx): Promise<Uint8Array> {
  for (const s of ctx.changed) {
    s.data = await deflate(s.data);
    s.dict.set("Filter", { t: "name", v: "FlateDecode" });
  }
  return ctx.doc.write();
}

/**
 * Erases `area` from the document `current` and returns the new bytes: the
 * text, image pixels and paths under it are gone and the area is filled.
 */
export async function eraseArea(
  engine: PdfiumNative,
  text: EmbeddedText,
  current: ArrayBuffer,
  area: EraseArea,
): Promise<{ bytes: ArrayBuffer; paths: number; ownerPassword: boolean }> {
  const rects = area.rects.filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) throw new EraseError("nothing to erase");
  const [r, g, b] = rgbOf(area.fill);
  let ownerPassword = false;
  let boxes: Box[] = [];
  const plain = await withScratch(engine, current, async (doc) => {
    const page = doc.pages[area.page];
    if (!page) throw new EraseError(`no page ${area.page + 1}`);
    boxes = rects.map((rect) => {
      const a = toUserSpace(engine, doc, page, { x: rect.x, y: rect.y });
      const c = toUserSpace(engine, doc, page, { x: rect.x + rect.width, y: rect.y + rect.height });
      return { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) };
    });
    ownerPassword = text.isEncrypted(doc);
    if (ownerPassword) text.removeEncryption(doc);
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });

  try {
    // 1. Un-share what the page draws over the area.
    const first = await PdfDocumentObjects.parse(new Uint8Array(plain));
    const ctx1: Ctx = { doc: first, boxes, changed: new Set(), next: 1 };
    const page1 = pageOf(first, area.page);
    const resources = ownResources(first, page1.resources);
    page1.dict.set("Resources", { t: "dict", v: resources });
    const renamed = await unshareContent(ctx1, await contentOf(first, page1.dict.get("Contents")), resources, IDENTITY);
    if (renamed !== null) writeContents(ctx1, page1.dict, renamed);
    const unshared = await finish(ctx1);

    // 2. PDFium: glyphs and image pixels.
    const redacted = await withScratch(engine, unshared.slice().buffer, async (doc) => {
      const page = doc.pages[area.page];
      if (!page) throw new EraseError(`no page ${area.page + 1}`);
      const quads = rects.map((rect) => ({ origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }));
      // False when there was nothing to remove: the paths and the fill still apply.
      await engine.redactTextInRects(doc, page, quads, { recurseForms: true, drawBlackBoxes: false }).toPromise();
      return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    });

    // 3. Paths, then the fill on top; 4. a fresh file.
    const last = await PdfDocumentObjects.parse(new Uint8Array(redacted));
    const ctx3: Ctx = { doc: last, boxes, changed: new Set(), next: 1 };
    const page3 = pageOf(last, area.page);
    const content = await contentOf(last, page3.dict.get("Contents"));
    const cut = await cutContent(ctx3, content, page3.resources ?? new Map<string, PdfObj>(), IDENTITY);
    const fill = boxes.map((box) => `${fmt(box.x0)} ${fmt(box.y0)} ${fmt(box.x1 - box.x0)} ${fmt(box.y1 - box.y0)} re`).join("\n");
    writeContents(ctx3, page3.dict, `q\n${cut.text ?? content}\nQ\nq ${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n${fill}\nf\nQ\n`);
    const bytes = await finish(ctx3);
    return { bytes: bytes.slice().buffer, paths: cut.paths, ownerPassword };
  } catch (err) {
    if (err instanceof ContentSyntaxError) throw new EraseError(`cannot read the page content: ${err.message}`);
    throw err;
  }
}

/**
 * Removes one top-level object (text, path, image, shading or form) from page
 * `pageIndex` and writes the file anew, so the old content stream (and an
 * image or form nothing else draws) do not survive. Throws when the page no
 * longer has the object where the user picked it.
 */
export async function deletePageObject(
  engine: PdfiumNative,
  pdf: WrappedPdfiumModule,
  text: EmbeddedText,
  current: ArrayBuffer,
  pageIndex: number,
  object: PageObjectInfo,
): Promise<ArrayBuffer> {
  const removed = await withScratch(engine, current, async (doc) => {
    const page = doc.pages[pageIndex];
    const ptr = documentPointer(engine, doc.id);
    if (!page || ptr === null) throw new EraseError(`no page ${pageIndex + 1}`);
    if (text.isEncrypted(doc)) text.removeEncryption(doc);
    if (!removePageObject(engine, pdf, ptr, doc, page, object)) throw new EraseError("the object is no longer on the page");
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });
  return (await PdfDocumentObjects.parse(new Uint8Array(removed))).write().slice().buffer;
}

/**
 * The median colour (per channel) of the pixels within `ring` points around the
 * rects but outside them, from an RGBA raster of the page at `scale`; white when
 * there are none. Zero-size rects sample the spot itself (the eyedropper).
 */
export function ringColor(data: Uint8Array | Uint8ClampedArray, width: number, height: number, scale: number, rects: readonly PageRect[], ring = 4): string {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
  let count = 0;
  const grown = rects.map((r) => ({ x0: r.x - ring, y0: r.y - ring, x1: r.x + r.width + ring, y1: r.y + r.height + ring }));
  const x0 = Math.max(0, Math.floor(Math.min(...grown.map((g) => g.x0)) * scale));
  const y0 = Math.max(0, Math.floor(Math.min(...grown.map((g) => g.y0)) * scale));
  const x1 = Math.min(width, Math.ceil(Math.max(...grown.map((g) => g.x1)) * scale));
  const y1 = Math.min(height, Math.ceil(Math.max(...grown.map((g) => g.y1)) * scale));
  for (let py = y0; py < y1; py++) {
    const y = (py + 0.5) / scale;
    for (let px = x0; px < x1; px++) {
      const x = (px + 0.5) / scale;
      if (!grown.some((g) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1)) continue;
      if (rects.some((r) => x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height)) continue;
      const o = (py * width + px) * 4;
      hist.forEach((h, c) => {
        const v = data[o + c] as number;
        h[v] = (h[v] as number) + 1;
      });
      count++;
    }
  }
  if (count === 0) return "#ffffff";
  const median = (h: Uint32Array) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v] as number;
      if (seen * 2 >= count) return v;
    }
    return 255;
  };
  return `#${hist.map((h) => median(h).toString(16).padStart(2, "0")).join("")}`;
}
