/**
 * Synthetic PDF corpus. Every byte is generated here — no third-party documents.
 * Text is original filler written for this project.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseTrueType, type TrueTypeFont, woffToSfnt } from "./font.ts";
import { n, type PdfDict, PdfWriter, type PdfValue, type Ref, Str } from "./pdf-writer.ts";
import { buildScanned, SCANNED_TEXT } from "./scanned.ts";

export type FixtureName =
  | "large-1000"
  | "acroform"
  | "greek"
  | "encrypted"
  | "mixed-sizes"
  | "scanned-greek"
  | "scanned-english"
  | "erase"
  | "shared-xobjects"
  | "rotated-text";

export type Fixture = {
  readonly name: FixtureName;
  readonly file: string;
  readonly description: string;
  readonly pageCount: number;
  /** User password, when the file is encrypted. */
  readonly password?: string;
  build(): Uint8Array;
};

export const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];

/** Escapes a Latin-1 string for a PDF literal string. */
function lit(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function helveticaResources(w: PdfWriter): PdfDict {
  const helv = w.add({ Type: n("Font"), Subtype: n("Type1"), BaseFont: n("Helvetica"), Encoding: n("WinAnsiEncoding") });
  const bold = w.add({
    Type: n("Font"),
    Subtype: n("Type1"),
    BaseFont: n("Helvetica-Bold"),
    Encoding: n("WinAnsiEncoding"),
  });
  return { Font: { F1: helv, F2: bold } };
}

type PageSpec = { size: [number, number]; content: string; rotate?: number; annots?: Ref[] };

/** Builds a page tree with all pages under one /Pages node and sets the catalog. Returns the page refs. */
export function finishDocument(w: PdfWriter, pages: PageSpec[], resources: PdfDict, catalogExtra: PdfDict = {}): Ref[] {
  const pagesRef = w.reserve();
  const resRef = w.add(resources);
  const kids: Ref[] = pages.map((p) => {
    const contents = w.addStream({}, p.content);
    const page: Record<string, PdfValue> = {
      Type: n("Page"),
      Parent: pagesRef,
      MediaBox: [0, 0, p.size[0], p.size[1]],
      Resources: resRef,
      Contents: contents,
    };
    if (p.rotate) page.Rotate = p.rotate;
    if (p.annots) page.Annots = p.annots;
    return w.add(page);
  });
  w.set(pagesRef, { Type: n("Pages"), Kids: kids, Count: kids.length });
  w.setRoot(w.add({ Type: n("Catalog"), Pages: pagesRef, ...catalogExtra }));
  return kids;
}

type OutlineSpec = { title: string; page: number; children?: OutlineSpec[] };

/** Writes an outline (bookmarks) tree into a reserved /Outlines object; sub-levels start closed. */
function writeOutline(w: PdfWriter, root: Ref, items: readonly OutlineSpec[], pages: readonly Ref[]): void {
  const level = (parent: Ref, specs: readonly OutlineSpec[]): { first: Ref; last: Ref; count: number } => {
    const refs = specs.map(() => w.reserve());
    specs.forEach((spec, i) => {
      const self = refs[i] as Ref;
      const entry: Record<string, PdfValue> = {
        Title: Str.ascii(spec.title),
        Parent: parent,
        Dest: [pages[spec.page] as Ref, n("Fit")],
      };
      if (i > 0) entry.Prev = refs[i - 1] as Ref;
      if (i < refs.length - 1) entry.Next = refs[i + 1] as Ref;
      if (spec.children?.length) {
        const sub = level(self, spec.children);
        entry.First = sub.first;
        entry.Last = sub.last;
        entry.Count = -sub.count;
      }
      w.set(self, entry);
    });
    return { first: refs[0] as Ref, last: refs[refs.length - 1] as Ref, count: refs.length };
  };
  const top = level(root, items);
  w.set(root, { Type: n("Outlines"), First: top.first, Last: top.last, Count: top.count });
}

/** A deterministic RGB image XObject (smooth colour gradient). */
function gradientImage(w: PdfWriter, width: number, height: number): Ref {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = Math.round((x / (width - 1)) * 255);
      data[i + 1] = Math.round((y / (height - 1)) * 200) + 30;
      data[i + 2] = 180;
    }
  }
  return w.addStream(
    { Type: n("XObject"), Subtype: n("Image"), Width: width, Height: height, ColorSpace: n("DeviceRGB"), BitsPerComponent: 8 },
    data,
  );
}

const FILLER = [
  "Selis keeps every document on your device. Nothing leaves it unless you decide to send it.",
  "This page is part of a synthetic test corpus used to measure rendering speed and memory.",
  "Each line is drawn as real text so that search and selection can be tested later.",
  "The quick brown fox jumps over the lazy dog while the ink settles on calm paper.",
];

function largePage(index: number, total: number): string {
  const [w, h] = A4;
  const lines: string[] = [];
  lines.push("q 0.141 0.263 0.561 rg");
  lines.push(`48 ${h - 72} ${w - 96} 4 re f Q`);
  lines.push(`BT /F2 28 Tf 48 ${h - 120} Td ${lit(`Page ${index + 1} of ${total}`)} Tj ET`);
  let y = h - 170;
  for (let para = 0; para < 6; para++) {
    for (let l = 0; l < 4; l++) {
      const text = FILLER[(index + para + l) % FILLER.length] as string;
      lines.push(`BT /F1 11 Tf 48 ${y.toFixed(2)} Td ${lit(text)} Tj ET`);
      y -= 16;
    }
    y -= 14;
  }
  // A simple vector figure that varies per page (exercises path rendering).
  const bars = 12;
  for (let b = 0; b < bars; b++) {
    const height = 12 + ((index * 7 + b * 13) % 72);
    const shade = (0.55 + (b % 4) * 0.1).toFixed(2);
    lines.push(`q ${shade} ${shade} ${shade} rg ${48 + b * 40} 120 28 ${height} re f Q`);
  }
  lines.push(`q 0.4 0.4 0.4 RG 0.75 w 48 110 m ${w - 48} 110 l S Q`);
  lines.push(`BT /F1 9 Tf ${w / 2 - 20} 48 Td ${lit(`- ${index + 1} -`)} Tj ET`);
  return lines.join("\n");
}

function buildLarge(pageCount: number): Uint8Array {
  const w = new PdfWriter("selis-fixture-large-1000");
  const resources = helveticaResources(w);
  const pages: PageSpec[] = [];
  for (let i = 0; i < pageCount; i++) pages.push({ size: A4, content: largePage(i, pageCount) });
  const outlines = w.reserve();
  const kids = finishDocument(w, pages, resources, { Outlines: outlines });
  // Parts of 100 pages with two sections each: a two-level outline for the viewer.
  const parts: OutlineSpec[] = [];
  for (let start = 0; start < pageCount; start += 100) {
    const part = start / 100 + 1;
    parts.push({
      title: `Part ${part}: pages ${start + 1}-${Math.min(start + 100, pageCount)}`,
      page: start,
      children: [
        { title: `Section ${part}.1`, page: start },
        { title: `Section ${part}.2`, page: Math.min(start + 50, pageCount - 1) },
      ],
    });
  }
  writeOutline(w, outlines, parts, kids);
  w.setInfo({ Title: Str.ascii("Selis 1000-page fixture"), Producer: Str.ascii("selis fixtures generator") });
  return w.toBytes();
}

function buildAcroForm(): Uint8Array {
  const w = new PdfWriter("selis-fixture-acroform");
  const resources = helveticaResources(w);
  const helv = (resources.Font as Record<string, Ref>).F1 as Ref;
  const dr = { Font: { Helv: helv } };
  const pageRef = w.reserve();

  const textAp = (value: string, width: number, height: number) =>
    w.addStream(
      { Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, width, height], Resources: dr },
      `/Tx BMC q BT /Helv 12 Tf 0 g 4 ${(height - 12) / 2 + 2} Td ${lit(value)} Tj ET Q EMC`,
    );
  const box = (on: boolean) =>
    w.addStream(
      { Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 18, 18] },
      on ? "q 0 g 1.5 w 3 9 m 7 4 l 15 14 l S Q" : "",
    );

  const nameField = w.add({
    Type: n("Annot"),
    Subtype: n("Widget"),
    FT: n("Tx"),
    T: Str.ascii("full_name"),
    TU: Str.ascii("Full name"),
    V: Str.ascii("Ada Lovelace"),
    DA: Str.ascii("/Helv 12 Tf 0 g"),
    Rect: [160, 680, 460, 704],
    F: 4,
    P: pageRef,
    MK: { BC: [0.6, 0.6, 0.6], BG: [1, 1, 1] },
    AP: { N: textAp("Ada Lovelace", 300, 24) },
  });
  const emailField = w.add({
    Type: n("Annot"),
    Subtype: n("Widget"),
    FT: n("Tx"),
    T: Str.ascii("email"),
    TU: Str.ascii("Email"),
    DA: Str.ascii("/Helv 12 Tf 0 g"),
    Rect: [160, 640, 460, 664],
    F: 4,
    P: pageRef,
    MK: { BC: [0.6, 0.6, 0.6], BG: [1, 1, 1] },
    AP: { N: textAp("", 300, 24) },
  });
  const agree = w.add({
    Type: n("Annot"),
    Subtype: n("Widget"),
    FT: n("Btn"),
    T: Str.ascii("agree"),
    TU: Str.ascii("I agree"),
    V: n("Yes"),
    AS: n("Yes"),
    Rect: [160, 596, 178, 614],
    F: 4,
    P: pageRef,
    MK: { BC: [0.4, 0.4, 0.4], BG: [1, 1, 1] },
    AP: { N: { Yes: box(true), Off: box(false) } },
  });
  const plan = w.add({
    Type: n("Annot"),
    Subtype: n("Widget"),
    FT: n("Ch"),
    Ff: 1 << 17, // Combo
    T: Str.ascii("plan"),
    TU: Str.ascii("Plan"),
    Opt: [Str.ascii("Reader"), Str.ascii("Editor"), Str.ascii("Archivist")],
    V: Str.ascii("Editor"),
    DA: Str.ascii("/Helv 12 Tf 0 g"),
    Rect: [160, 548, 360, 572],
    F: 4,
    P: pageRef,
    MK: { BC: [0.6, 0.6, 0.6], BG: [1, 1, 1] },
    AP: { N: textAp("Editor", 200, 24) },
  });
  const fields = [nameField, emailField, agree, plan];
  const content = [
    `BT /F2 22 Tf 72 760 Td ${lit("Membership form")} Tj ET`,
    `BT /F1 12 Tf 72 688 Td ${lit("Full name")} Tj ET`,
    `BT /F1 12 Tf 72 648 Td ${lit("Email")} Tj ET`,
    `BT /F1 12 Tf 190 600 Td ${lit("I agree to the terms")} Tj ET`,
    `BT /F1 12 Tf 72 556 Td ${lit("Plan")} Tj ET`,
  ].join("\n");

  const pagesRef = w.reserve();
  const resRef = w.add({ ...resources, Font: { ...(resources.Font as PdfDict), Helv: helv } });
  const contents = w.addStream({}, content);
  w.set(pageRef, {
    Type: n("Page"),
    Parent: pagesRef,
    MediaBox: [0, 0, LETTER[0], LETTER[1]],
    Resources: resRef,
    Contents: contents,
    Annots: fields,
  });
  w.set(pagesRef, { Type: n("Pages"), Kids: [pageRef], Count: 1 });
  w.setRoot(
    w.add({
      Type: n("Catalog"),
      Pages: pagesRef,
      AcroForm: { Fields: fields, DR: dr, DA: Str.ascii("/Helv 12 Tf 0 g") },
    }),
  );
  w.setInfo({ Title: Str.ascii("AcroForm fixture") });
  return w.toBytes();
}

/** A TrueType font embedded as Type0/CIDFontType2 with Identity-H and a ToUnicode map. */
export class EmbeddedFont {
  readonly font: TrueTypeFont;
  readonly baseName: string;
  private readonly used = new Map<number, number>();

  constructor(font: TrueTypeFont, baseName: string) {
    this.font = font;
    this.baseName = baseName;
  }

  has(codePoint: number): boolean {
    return this.font.glyphId(codePoint) !== 0;
  }

  /** Hex string of glyph IDs for a run of characters this font covers. */
  encode(text: string): string {
    let hex = "<";
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      const gid = this.font.glyphId(cp);
      if (gid === 0) throw new Error(`glyph missing for U+${cp.toString(16)}`);
      this.used.set(gid, cp);
      hex += gid.toString(16).padStart(4, "0");
    }
    return `${hex}>`;
  }

  write(w: PdfWriter): Ref {
    const fontFile = w.addStream({ Length1: this.font.sfnt.length }, this.font.sfnt);
    const scale = 1000 / this.font.unitsPerEm;
    const descriptor = w.add({
      Type: n("FontDescriptor"),
      FontName: n(this.baseName),
      Flags: 32,
      FontBBox: [-600, -400, 2000, 1200],
      ItalicAngle: 0,
      Ascent: Math.round(this.font.ascent * scale),
      Descent: Math.round(this.font.descent * scale),
      CapHeight: 714,
      StemV: 80,
      FontFile2: fontFile,
    });
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    const widths: PdfValue[] = [];
    for (const gid of gids) widths.push(gid, [this.font.advance(gid)]);
    const cid = w.add({
      Type: n("Font"),
      Subtype: n("CIDFontType2"),
      BaseFont: n(this.baseName),
      CIDSystemInfo: { Registry: Str.ascii("Adobe"), Ordering: Str.ascii("Identity"), Supplement: 0 },
      FontDescriptor: descriptor,
      W: widths,
      CIDToGIDMap: n("Identity"),
    });
    const bfchars = gids
      .map((g) => `<${g.toString(16).padStart(4, "0")}> <${(this.used.get(g) as number).toString(16).padStart(4, "0")}>`)
      .join("\n");
    const toUnicode = w.addStream(
      {},
      [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
        "1 begincodespacerange <0000> <FFFF> endcodespacerange",
        `${gids.length} beginbfchar`,
        bfchars,
        "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n"),
    );
    return w.add({
      Type: n("Font"),
      Subtype: n("Type0"),
      BaseFont: n(this.baseName),
      Encoding: n("Identity-H"),
      DescendantFonts: [cid],
      ToUnicode: toUnicode,
    });
  }
}

const require = createRequire(import.meta.url);

function loadNotoSans(subset: "greek" | "latin"): TrueTypeFont {
  const path = require.resolve(`@fontsource/noto-sans/files/noto-sans-${subset}-400-normal.woff`);
  return parseTrueType(woffToSfnt(new Uint8Array(readFileSync(path))));
}

export const GREEK_TEXT = [
  "Η Σελίς κρατά κάθε έγγραφο στη συσκευή σου.",
  "Χωρίς λογαριασμό, χωρίς σύννεφο, χωρίς παρακολούθηση.",
  "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.",
  "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ — αβγδεζηθικλμνξοπρσςτυφχψω",
  "Τόνοι και διαλυτικά: ά έ ή ί ό ύ ώ ϊ ϋ ΐ ΰ",
  "Αριθμοί 0123456789 και σημεία στίξης: « » ; · ,",
];

type GreekFonts = { G: EmbeddedFont; L: EmbeddedFont };

function greekFonts(): GreekFonts {
  return {
    G: new EmbeddedFont(loadNotoSans("greek"), "AAAAAA+NotoSans-Greek"),
    L: new EmbeddedFont(loadNotoSans("latin"), "AAAAAB+NotoSans-Latin"),
  };
}

/** Splits text into runs per font of the Greek fixture; characters neither font has are dropped. */
function greekRuns(fonts: GreekFonts, text: string): Array<{ font: keyof GreekFonts; text: string }> {
  const runs: Array<{ font: keyof GreekFonts; text: string }> = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const which = fonts.G.has(cp) ? "G" : fonts.L.has(cp) ? "L" : null;
    if (!which) continue;
    const last = runs.at(-1);
    if (last?.font === which) last.text += ch;
    else runs.push({ font: which, text: ch });
  }
  return runs;
}

/**
 * The glyph codes the Greek fixture's content streams show `text` with (hex,
 * one entry per font run): what a redaction test searches the produced file
 * for, since content streams hold glyph codes, not Unicode.
 */
export function greekGlyphHex(text: string): string[] {
  const fonts = greekFonts();
  return greekRuns(fonts, text).map((r) => fonts[r.font].encode(r.text).slice(1, -1));
}

function buildGreek(): Uint8Array {
  const w = new PdfWriter("selis-fixture-greek");
  const fonts = greekFonts();
  const show = (text: string, size: number, x: number, y: number): string => {
    const runs = greekRuns(fonts, text).map((r) => ` /${r.font} ${size} Tf ${fonts[r.font].encode(r.text)} Tj`);
    return `BT ${x} ${y} Td${runs.join("")} ET`;
  };

  const page1 = [show("Ελληνικό κείμενο", 26, 56, 760), ...GREEK_TEXT.map((t, i) => show(t, 13, 56, 710 - i * 26))].join(
    "\n",
  );
  const page2 = [
    show("Δεύτερη σελίδα", 22, 56, 760),
    show("Αναζήτηση: «σελίδα», «έγγραφο».", 13, 56, 720),
    // A colour image: night mode must leave it as it is.
    "q 240 0 0 150 56 480 cm /Im1 Do Q",
  ].join("\n");

  // Content is generated before the fonts are written so the used-glyph sets are complete.
  const contents = [page1, page2];
  const resources = { Font: { G: fonts.G.write(w), L: fonts.L.write(w) }, XObject: { Im1: gradientImage(w, 64, 40) } };
  finishDocument(
    w,
    contents.map((content) => ({ size: A4, content })),
    resources,
    { Lang: Str.ascii("el-GR") },
  );
  w.setInfo({ Title: Str.utf16("Ελληνικό δοκιμαστικό") });
  return w.toBytes();
}

/** The words on the line of `leakyDocument()` that a redaction test removes. */
export const LEAKY_SECRET_LINE = "Secret: Lovelace Babbage Engine";

/**
 * A one-page document whose secret line ("Secret: Lovelace Babbage Engine",
 * baseline y = 690 from the bottom of a Letter page) is also named all over the
 * document's other parts: Info, XMP, outline, named destination, page label,
 * document JavaScript and an open action, an embedded file, a form field's
 * value / default / tooltip, two annotations elsewhere on the page and the
 * structure tree. Next to each, a neighbour that names none of the secret words
 * and must stay. Also a signature field and a push button with a script (what
 * a page import drops). For the redaction and import tests; not in the corpus.
 */
export function leakyDocument(): Uint8Array {
  const w = new PdfWriter("selis-fixture-leaky");
  const resources = helveticaResources(w);
  const helv = (resources.Font as Record<string, Ref>).F1 as Ref;
  const pageRef = w.reserve();
  const content = [
    `BT /F1 14 Tf 72 720 Td ${lit("Public line stays.")} Tj ET`,
    `BT /F1 14 Tf 72 690 Td ${lit(LEAKY_SECRET_LINE)} Tj ET`,
    `BT /F1 14 Tf 72 660 Td ${lit("Another public line.")} Tj ET`,
  ].join("\n");
  const contents = w.addStream({}, content);

  const textAp = (value: string) =>
    w.addStream({ Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 200, 20], Resources: { Font: { Helv: helv } } }, `/Tx BMC BT /Helv 11 Tf 2 6 Td ${lit(value)} Tj ET EMC`);
  const field = (name: string, value: string, tooltip: string, y: number) =>
    w.add({
      Type: n("Annot"),
      Subtype: n("Widget"),
      FT: n("Tx"),
      T: Str.ascii(name),
      TU: Str.ascii(tooltip),
      V: Str.ascii(value),
      DV: Str.ascii(value),
      DA: Str.ascii("/Helv 11 Tf 0 g"),
      Rect: [72, y, 272, y + 20],
      F: 4,
      P: pageRef,
      AP: { N: textAp(value) },
    });
  const secretField = field("notes_field", "Babbage Engine", "Ask Lovelace", 400);
  const publicField = field("public_field", "ok", "Public", 360);
  const note = (text: string, y: number) =>
    w.add({ Type: n("Annot"), Subtype: n("Text"), Rect: [500, y, 520, y + 20], Contents: Str.ascii(text), F: 4, P: pageRef });
  const freeText = w.add({
    Type: n("Annot"),
    Subtype: n("FreeText"),
    Rect: [300, 300, 500, 320],
    Contents: Str.ascii(""),
    DA: Str.ascii("/Helv 11 Tf 0 g"),
    F: 4,
    P: pageRef,
    AP: { N: textAp("Babbage was here") },
  });
  // What a page import drops (ADR 0008): a signature field and a push button with a script.
  const signature = w.add({ Type: n("Annot"), Subtype: n("Widget"), FT: n("Sig"), T: Str.ascii("approval"), Rect: [320, 200, 520, 240], F: 4, P: pageRef });
  const button = w.add({
    Type: n("Annot"),
    Subtype: n("Widget"),
    FT: n("Btn"),
    Ff: 1 << 16,
    T: Str.ascii("reset"),
    Rect: [72, 200, 172, 224],
    F: 4,
    P: pageRef,
    A: { S: n("JavaScript"), JS: Str.ascii("this.resetForm();") },
  });
  const annots = [secretField, publicField, note("Call Lovelace", 500), note("Unrelated", 460), freeText, signature, button];

  const js = (code: string) => w.add({ S: n("JavaScript"), JS: Str.ascii(code) });
  const file = (name: string, body: string) =>
    w.add({ Type: n("Filespec"), F: Str.ascii(name), UF: Str.ascii(name), EF: { F: w.addStream({ Type: n("EmbeddedFile") }, body) } });
  const xmp = w.addStream(
    { Type: n("Metadata"), Subtype: n("XML") },
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report on Lovelace</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    false,
  );
  const outlines = w.reserve();
  writeOutline(
    w,
    outlines,
    [
      { title: "Introduction", page: 0 },
      { title: "Lovelace notes", page: 0 },
    ],
    [pageRef],
  );
  const structRoot = w.reserve();
  const structElem = (alt: string, actual: string | null) =>
    w.add({ Type: n("StructElem"), S: n("Figure"), P: structRoot, Alt: Str.ascii(alt), ...(actual ? { ActualText: Str.ascii(actual) } : {}) });
  w.set(structRoot, { Type: n("StructTreeRoot"), K: [structElem("Lovelace photo", "Babbage"), structElem("Logo", null)] });

  // One page, written by hand: its widgets need the page's ref before it exists.
  const pagesRef = w.reserve();
  w.set(pageRef, {
    Type: n("Page"),
    Parent: pagesRef,
    MediaBox: [0, 0, 612, 792],
    Resources: resources,
    Contents: contents,
    Annots: annots,
  });
  w.set(pagesRef, { Type: n("Pages"), Kids: [pageRef], Count: 1 });
  w.setRoot(
    w.add({
      Type: n("Catalog"),
      Pages: pagesRef,
      Outlines: outlines,
      Metadata: xmp,
      MarkInfo: { Marked: true },
      StructTreeRoot: structRoot,
      OpenAction: js("this.print(); // Lovelace"),
      PageLabels: { Nums: [0, { S: n("D"), P: Str.ascii("Lovelace-") }] },
      AcroForm: { Fields: [secretField, publicField, signature, button], DA: Str.ascii("/Helv 11 Tf 0 g"), DR: { Font: { Helv: helv } } },
      // Name tree roots are indirect objects, as in most real files.
      Names: w.add({
        Dests: w.add({ Names: [Str.ascii("intro"), [pageRef, n("Fit")], Str.ascii("lovelace-section"), [pageRef, n("Fit")]] }),
        JavaScript: w.add({ Names: [Str.ascii("doc-open"), js("app.alert('Babbage');"), Str.ascii("harmless"), js("var x = 1;")] }),
        EmbeddedFiles: w.add({
          Names: [Str.ascii("notes.txt"), file("notes.txt", "Lovelace was here"), Str.ascii("public.txt"), file("public.txt", "nothing here")],
        }),
      }),
    }),
  );
  w.setInfo({ Title: Str.ascii("Report on Lovelace"), Author: Str.ascii("Babbage"), Subject: Str.ascii("Quarterly"), Keywords: Str.ascii("Engine, Lovelace") });
  return w.toBytes();
}

export const ENCRYPTED_PASSWORD = "selis";

/**
 * A one-page document with an owner password only (no user password): it opens
 * without asking, but carries a security handler and restricted permissions.
 * "Owner secret line." sits at baseline y = 720 (Helvetica 12). Not in the corpus.
 */
export function ownerPasswordDocument(): Uint8Array {
  const w = new PdfWriter("selis-fixture-owner-password");
  const resources = helveticaResources(w);
  finishDocument(
    w,
    [
      {
        size: A4,
        content: [`BT /F1 12 Tf 56 760 Td ${lit("Public line.")} Tj ET`, `BT /F1 12 Tf 56 720 Td ${lit("Owner secret line.")} Tj ET`].join("\n"),
      },
    ],
    resources,
  );
  // Print only (bit 3); no copying or modifying.
  w.encrypt("", "selis-owner", -3904 | 4);
  return w.toBytes();
}

function buildEncrypted(): Uint8Array {
  const w = new PdfWriter("selis-fixture-encrypted");
  const resources = helveticaResources(w);
  const pages: PageSpec[] = [1, 2].map((i) => ({
    size: A4,
    content: [
      `BT /F2 24 Tf 56 760 Td ${lit(`Encrypted page ${i}`)} Tj ET`,
      `BT /F1 12 Tf 56 720 Td ${lit(`RC4 128-bit, user password "${ENCRYPTED_PASSWORD}".`)} Tj ET`,
    ].join("\n"),
  }));
  finishDocument(w, pages, resources);
  w.setInfo({ Title: Str.ascii("Encrypted fixture") });
  w.encrypt(ENCRYPTED_PASSWORD, "selis-owner");
  return w.toBytes();
}

function buildMixed(): Uint8Array {
  const w = new PdfWriter("selis-fixture-mixed-sizes");
  const resources = helveticaResources(w);
  const specs: Array<{ label: string; size: [number, number]; rotate?: number }> = [
    { label: "A4 portrait", size: A4 },
    { label: "US Letter", size: LETTER },
    { label: "A5 landscape", size: [595.28, 419.53] },
    { label: "A3 portrait", size: [841.89, 1190.55] },
    { label: "Receipt 80 x 300 mm", size: [226.77, 850.39] },
    { label: "A4 with /Rotate 90", size: A4, rotate: 90 },
    { label: "Square 500 pt", size: [500, 500] },
  ];
  const pages: PageSpec[] = specs.map((s) => {
    const [pw, ph] = s.size;
    const content = [
      `q 0.85 0.85 0.85 RG 2 w 8 8 ${pw - 16} ${ph - 16} re S Q`,
      `q 0.141 0.263 0.561 RG 1 w 0 0 m ${pw} ${ph} l S 0 ${ph} m ${pw} 0 l S Q`,
      `BT /F2 16 Tf 24 ${ph - 40} Td ${lit(s.label)} Tj ET`,
      `BT /F1 10 Tf 24 ${ph - 58} Td ${lit(`${pw} x ${ph} pt`)} Tj ET`,
    ].join("\n");
    return s.rotate === undefined ? { size: s.size, content } : { size: s.size, content, rotate: s.rotate };
  });
  finishDocument(w, pages, resources);
  w.setInfo({ Title: Str.ascii("Mixed page sizes fixture") });
  return w.toBytes();
}

/** Lines of the erase fixture (ADR 0033): what an erase must remove, and its neighbours. */
export const ERASE_TEXT = {
  title: "Erase fixture",
  above: "Public line one.",
  secret: "Secret Wolfram Quartz.",
  below: "Public line two.",
  form: "Form Zebra Nimbus.",
  page2: "Page two keeps everything.",
  rotated: "Rotated Kestrel Saffron.",
  rotatedKeep: "Rotated page keeps this.",
} as const;

/** A 400 × 400 RGB gradient, drawn 200 pt wide (half a point per pixel). */
export const ERASE_IMAGE_SIZE = 400;

/**
 * Text, vector and image content for the content erase (ADR 0033), A4 points
 * from the bottom-left:
 * - page 1: title (y 780), three 12 pt lines at baselines 740 / 700 / 660 (the
 *   middle one is the secret), a blue filled rect (56–256 × 520–600), a red
 *   3 pt diagonal (300,520 → 540,600), a black stroked circle (centre 450,380,
 *   r 60), the gradient image (56–256 × 240–440), and a form XObject at
 *   (300, 620) with its own line and a green rect (310–430 × 630–660);
 * - page 2 draws the same image and form (shared objects: erasing page 1 must
 *   leave them whole here) and an unsigned signature field (the "document is
 *   signed" warning);
 * - page 3 is /Rotate 90 with a CropBox: a line to erase and one to keep.
 */
function buildErase(): Uint8Array {
  const w = new PdfWriter("selis-fixture-erase");
  const resources = helveticaResources(w);
  const helv = (resources.Font as Record<string, Ref>).F1 as Ref;
  const size = ERASE_IMAGE_SIZE;
  const data = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      data[i] = Math.round((x / (size - 1)) * 220) + 20;
      data[i + 1] = Math.round((y / (size - 1)) * 160) + 60;
      data[i + 2] = 200 - Math.round(((x + y) / (2 * size - 2)) * 120);
    }
  }
  const image = w.addStream({ Type: n("XObject"), Subtype: n("Image"), Width: size, Height: size, ColorSpace: n("DeviceRGB"), BitsPerComponent: 8 }, data);
  const form = w.addStream(
    { Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 300, 100], Resources: { Font: { F1: helv } } },
    [`BT /F1 12 Tf 10 60 Td ${lit(ERASE_TEXT.form)} Tj ET`, "q 0.1 0.6 0.2 rg 10 10 120 30 re f Q"].join("\n"),
  );
  const pageResources: PdfDict = { ...resources, XObject: { Im1: image, Fm1: form } };
  const circle = (cx: number, cy: number, r: number) => {
    const k = 0.5523 * r;
    return [
      `${cx + r} ${cy} m`,
      `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c`,
      `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c`,
      `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c`,
      `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c`,
      "h",
    ].join(" ");
  };
  const page1 = [
    `BT /F2 16 Tf 56 780 Td ${lit(ERASE_TEXT.title)} Tj ET`,
    `BT /F1 12 Tf 56 740 Td ${lit(ERASE_TEXT.above)} Tj ET`,
    `BT /F1 12 Tf 56 700 Td ${lit(ERASE_TEXT.secret)} Tj ET`,
    `BT /F1 12 Tf 56 660 Td ${lit(ERASE_TEXT.below)} Tj ET`,
    "q 0.2 0.4 0.8 rg 56 520 200 80 re f Q",
    "q 0.8 0.1 0.1 RG 3 w 300 520 m 540 600 l S Q",
    `q 0 0 0 RG 2 w ${circle(450, 380, 60)} S Q`,
    "q 200 0 0 200 56 240 cm /Im1 Do Q",
    "q 1 0 0 1 300 620 cm /Fm1 Do Q",
  ].join("\n");
  const page2 = [
    `BT /F1 12 Tf 56 760 Td ${lit(ERASE_TEXT.page2)} Tj ET`,
    "q 200 0 0 200 56 240 cm /Im1 Do Q",
    "q 1 0 0 1 300 620 cm /Fm1 Do Q",
  ].join("\n");
  const page3 = [
    `BT /F1 12 Tf 80 700 Td ${lit(ERASE_TEXT.rotated)} Tj ET`,
    `BT /F1 12 Tf 80 640 Td ${lit(ERASE_TEXT.rotatedKeep)} Tj ET`,
    "q 0.5 0.5 0.5 RG 1 w 80 600 m 400 600 l S Q",
  ].join("\n");

  const pagesRef = w.reserve();
  const resRef = w.add(pageResources);
  const p1 = w.add({ Type: n("Page"), Parent: pagesRef, MediaBox: [0, 0, A4[0], A4[1]], Resources: resRef, Contents: w.addStream({}, page1) });
  const p2Ref = w.reserve();
  const signature = w.add({ Type: n("Annot"), Subtype: n("Widget"), FT: n("Sig"), T: Str.ascii("approval"), Rect: [320, 120, 520, 160], F: 4, P: p2Ref });
  w.set(p2Ref, {
    Type: n("Page"),
    Parent: pagesRef,
    MediaBox: [0, 0, A4[0], A4[1]],
    Resources: resRef,
    Contents: w.addStream({}, page2),
    Annots: [signature],
  });
  const p3 = w.add({
    Type: n("Page"),
    Parent: pagesRef,
    MediaBox: [0, 0, A4[0], A4[1]],
    CropBox: [20, 20, A4[0] - 20, A4[1] - 20],
    Rotate: 90,
    Resources: resRef,
    Contents: w.addStream({}, page3),
  });
  w.set(pagesRef, { Type: n("Pages"), Kids: [p1, p2Ref, p3], Count: 3 });
  w.setRoot(w.add({ Type: n("Catalog"), Pages: pagesRef, AcroForm: { Fields: [signature], SigFlags: 1 } }));
  w.setInfo({ Title: Str.ascii("Erase fixture") });
  return w.toBytes();
}

/** Text of the shared-XObjects fixture (ADR 0009 amendment). */
export const SHARED_TEXT = { form: "Shared Form Heron.", page: (n: number) => `Page ${n} of the shared logo.` } as const;

/**
 * Copy-on-write for redaction (ADR 0009 amendment), A4 points from the
 * bottom-left: three pages draw the same 64 × 64 logo image (Im1) at
 * 56–176 × 680–800 and the same form XObject (Fm1: a line of text over an
 * orange rect, 300–500 × 680–760); page 2 draws the logo a second time at
 * 56–176 × 200–320, outside any area a test redacts. Redacting the logo or
 * the form on page 2 must leave pages 1 and 3, and the second logo, as they were.
 */
function buildSharedXObjects(): Uint8Array {
  const w = new PdfWriter("selis-fixture-shared-xobjects");
  const resources = helveticaResources(w);
  const helv = (resources.Font as Record<string, Ref>).F1 as Ref;
  const size = 64;
  const data = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const ring = Math.hypot(x - 31.5, y - 31.5) < 26;
      data[i] = ring ? 30 : 240;
      data[i + 1] = ring ? 90 + x * 2 : 200;
      data[i + 2] = ring ? 200 - y : 40;
    }
  }
  const image = w.addStream({ Type: n("XObject"), Subtype: n("Image"), Width: size, Height: size, ColorSpace: n("DeviceRGB"), BitsPerComponent: 8 }, data);
  const form = w.addStream(
    { Type: n("XObject"), Subtype: n("Form"), BBox: [0, 0, 200, 80], Resources: { Font: { F1: helv } } },
    ["q 0.95 0.55 0.1 rg 0 0 200 40 re f Q", `BT /F1 12 Tf 8 56 Td ${lit(SHARED_TEXT.form)} Tj ET`].join("\n"),
  );
  const pageResources: PdfDict = { ...resources, XObject: { Im1: image, Fm1: form } };
  const page = (k: number) =>
    [
      `BT /F1 12 Tf 56 820 Td ${lit(SHARED_TEXT.page(k))} Tj ET`,
      "q 120 0 0 120 56 680 cm /Im1 Do Q",
      "q 1 0 0 1 300 680 cm /Fm1 Do Q",
      ...(k === 2 ? ["q 120 0 0 120 56 200 cm /Im1 Do Q"] : []),
    ].join("\n");
  finishDocument(
    w,
    [1, 2, 3].map((k) => ({ size: A4, content: page(k) })),
    pageResources,
  );
  w.setInfo({ Title: Str.ascii("Shared XObjects fixture") });
  return w.toBytes();
}

/** Single-word lines of the rotated-text fixture (/Rotate and text-matrix tests). */
export const ROTATED_WORDS = {
  /** Upright words: [text, x, baseline y] in PDF user space. */
  upright: [
    ["Kestrel", 90, 700],
    ["Saffron", 330, 520],
    ["Marigold", 120, 300],
  ],
  /** A word drawn turned 90° counter-clockwise by its text matrix, from (470, 160) upwards. */
  turned: ["Vertical", 470, 160],
} as const;

/** The /Rotate of each page of the rotated-text fixture. */
export const ROTATED_PAGES = [0, 90, 180, 270] as const;

/**
 * The same page four times, /Rotate 0 / 90 / 180 / 270, each with a CropBox
 * that does not start at 0,0 (so the conversion must use the crop origin):
 * three upright 18 pt words far apart, and one word turned by its text matrix
 * (a rotated CTM for its glyphs). Selection, search, redaction and erase must
 * find each word where it is drawn on every page.
 */
function buildRotatedText(): Uint8Array {
  const w = new PdfWriter("selis-fixture-rotated-text");
  const resources = helveticaResources(w);
  const [word, tx, ty] = ROTATED_WORDS.turned;
  const content = [
    ...ROTATED_WORDS.upright.map(([text, x, y]) => `BT /F1 18 Tf ${x} ${y} Td ${lit(text)} Tj ET`),
    `BT /F1 18 Tf 0 1 -1 0 ${tx} ${ty} Tm ${lit(word)} Tj ET`,
  ].join("\n");
  const pagesRef = w.reserve();
  const resRef = w.add(resources);
  const kids = ROTATED_PAGES.map((rotate) =>
    w.add({
      Type: n("Page"),
      Parent: pagesRef,
      MediaBox: [0, 0, A4[0], A4[1]],
      CropBox: [30, 40, A4[0] - 10, A4[1] - 20],
      ...(rotate ? { Rotate: rotate } : {}),
      Resources: resRef,
      Contents: w.addStream({}, content),
    }),
  );
  w.set(pagesRef, { Type: n("Pages"), Kids: kids, Count: kids.length });
  w.setRoot(w.add({ Type: n("Catalog"), Pages: pagesRef }));
  w.setInfo({ Title: Str.ascii("Rotated text fixture") });
  return w.toBytes();
}

export const LARGE_PAGE_COUNT = 1000;

export const FIXTURES: readonly Fixture[] = [
  {
    name: "large-1000",
    file: "large-1000.pdf",
    description: "1000 A4 pages with text and vector figures (performance spike).",
    pageCount: LARGE_PAGE_COUNT,
    build: () => buildLarge(LARGE_PAGE_COUNT),
  },
  {
    name: "acroform",
    file: "acroform.pdf",
    description: "AcroForm with text fields, checkbox and combo box (with appearance streams).",
    pageCount: 1,
    build: buildAcroForm,
  },
  {
    name: "greek",
    file: "greek.pdf",
    description: "Greek text (with tonos/dialytika) in embedded Noto Sans, with ToUnicode maps.",
    pageCount: 2,
    build: buildGreek,
  },
  {
    name: "encrypted",
    file: "encrypted.pdf",
    description: `Standard security handler, RC4 128-bit (R3). User password "${ENCRYPTED_PASSWORD}".`,
    pageCount: 2,
    password: ENCRYPTED_PASSWORD,
    build: buildEncrypted,
  },
  {
    name: "mixed-sizes",
    file: "mixed-sizes.pdf",
    description: "A4, Letter, A5 landscape, A3, receipt, rotated and square pages.",
    pageCount: 7,
    build: buildMixed,
  },
  {
    name: "scanned-greek",
    file: "scanned-greek.pdf",
    description: "Two image-only A4 pages of Greek text (300 dpi JPEG, skewed, noisy): OCR input.",
    pageCount: SCANNED_TEXT.greek.length,
    build: () => buildScanned("greek"),
  },
  {
    name: "scanned-english",
    file: "scanned-english.pdf",
    description: "Two image-only A4 pages of English text (300 dpi JPEG, skewed, noisy): OCR input.",
    pageCount: SCANNED_TEXT.english.length,
    build: () => buildScanned("english"),
  },
  {
    name: "erase",
    file: "erase.pdf",
    description: "Text, vector paths, an image and a form shared by two pages, a rotated cropped page, a signature field (content erase).",
    pageCount: 3,
    build: buildErase,
  },
  {
    name: "shared-xobjects",
    file: "shared-xobjects.pdf",
    description: "A logo image and a form XObject shared by three pages, the logo drawn twice on page 2 (redaction copy-on-write).",
    pageCount: 3,
    build: buildSharedXObjects,
  },
  {
    name: "rotated-text",
    file: "rotated-text.pdf",
    description: "One page at /Rotate 0, 90, 180 and 270 with a CropBox: upright words and a word turned by its text matrix.",
    pageCount: ROTATED_PAGES.length,
    build: buildRotatedText,
  },
];
