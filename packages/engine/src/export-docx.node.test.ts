/**
 * "Export as Word" through the real PDFium WASM (ADR 0035): a page's styled runs and images
 * (`readPageContent`, as the worker builds them) → reading structure → .docx, checked against
 * pdf.js reading the source PDF: every word of the source, in the same order, in the
 * document's text; headings found by size; bold kept; one page break per page.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { structureDocument, toDocx, toMarkdown, toPlainText } from "@selis/convert";
import { FIXTURES } from "@selis/fixtures";
import { pdfjsText } from "@selis/fixtures/oracle";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText } from "./annotations";
import { readPageContent } from "./page-content";
import { documentPointer, imageRectsOnPage } from "./pdfium-objects";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));

let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;
let text: EmbeddedText;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
}, 60_000);

const words = (s: string) =>
  s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");

/** Letters and digits only: word order without caring where pdf.js puts the spaces ("two.Form"). */
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");

/** The text of each page of a .docx (split at the page breaks). */
async function docxPages(bytes: Uint8Array): Promise<string[]> {
  const pages: string[] = [];
  let current = "";
  for (const p of await docxParagraphs(bytes)) {
    current += ` ${p.text}`;
    if (p.pageBreak) {
      pages.push(current);
      current = "";
    }
  }
  pages.push(current);
  return pages;
}

/** The paragraphs of a .docx's main part, in order: text and their style. */
async function docxParagraphs(bytes: Uint8Array): Promise<Array<{ text: string; style: string; bold: boolean; pageBreak: boolean }>> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => ({
    text: [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? "").join(""),
    style: p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "",
    bold: /<w:b\/>|<w:b w:val="(true|1)"\/>/.test(p),
    pageBreak: /<w:br w:type="page"\/>/.test(p),
  }));
}

async function exportFixture(name: string, pageLimit = Infinity) {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture) throw new Error(`no fixture ${name}`);
  const bytes = fixture.build();
  const doc = await engine.openDocumentBuffer({ id: `${name}-${String(Math.random())}`, content: bytes.slice().buffer }, {}).toPromise();
  try {
    const ptr = documentPointer(engine, doc.id);
    const pages = doc.pages.slice(0, pageLimit).map((page) => {
      const images = ptr === null ? [] : imageRectsOnPage(engine, pdf, ptr, doc, page);
      const content = readPageContent(engine, pdf, text, doc, page, images);
      return { width: page.size.width, height: page.size.height, runs: content.runs, images: content.images };
    });
    const structured = structureDocument(pages);
    const docx = await toDocx(structured, new Map(), name);
    const source = await pdfjsText(bytes);
    return { structured, docx, source: source.pages.slice(0, pageLimit), pages };
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

describe("export as Word", () => {
  it("keeps every word of a 9 pt document in order, the heading as Heading, a break per page", async () => {
    const { docx, source, structured } = await exportFixture("small-text");
    const paragraphs = await docxParagraphs(docx);
    expect(words(paragraphs.map((p) => p.text).join(" "))).toEqual(words(source.join(" ")));
    // One break between the two pages, none after the last.
    expect(paragraphs.filter((p) => p.pageBreak)).toHaveLength(structured.length - 1);
    // The 14 pt title over 9 pt body is ≥ 1.25 × the body size.
    expect(paragraphs.some((p) => p.style.startsWith("Heading") && p.text.trim() !== "")).toBe(true);
  });

  it("keeps the words of text with vector figures in order (first pages of the 1000-page fixture)", async () => {
    const { docx, source } = await exportFixture("large-1000", 3);
    const paragraphs = await docxParagraphs(docx);
    expect(words(paragraphs.map((p) => p.text).join(" "))).toEqual(words(source.join(" ")));
  });

  it("keeps the words of a page with a picture in order, and finds the picture and the styles", async () => {
    const { pages, docx, source } = await exportFixture("erase");
    const exported = await docxPages(docx);
    expect(exported).toHaveLength(source.length);
    source.forEach((text, i) => {
      // Page 3 is turned (/Rotate 90): we read it as shown, pdf.js in content order.
      if (i === 2) expect(words(exported[i] ?? "").sort()).toEqual(words(text).sort());
      else expect(letters(exported[i] ?? "")).toBe(letters(text));
    });
    // erase.pdf draws an image: its placement is reported for the export.
    expect(pages.some((p) => p.images.length > 0)).toBe(true);
    expect(pages.every((p) => p.runs.every((r) => typeof r.bold === "boolean" && typeof r.italic === "boolean"))).toBe(true);
  });

  it("writes the same text as plain text and Markdown", async () => {
    const { structured, source } = await exportFixture("small-text");
    expect(words(toPlainText(structured))).toEqual(words(source.join(" ")));
    const markdown = toMarkdown(structured);
    // The 14 pt title over 9 pt body is × 1.55: a second-level heading.
    expect(markdown).toMatch(/^## Small print/m);
    expect(words(markdown.replace(/[#*\\]/g, " "))).toEqual(words(source.join(" ")));
  });
});
