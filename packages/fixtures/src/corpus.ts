/**
 * Synthetic PDF corpus. Every byte is generated here — no third-party documents.
 * Text is original filler written for this project.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseTrueType, type TrueTypeFont, woffToSfnt } from "./font.ts";
import { n, type PdfDict, PdfWriter, type PdfValue, type Ref, Str } from "./pdf-writer.ts";

export type FixtureName = "large-1000" | "acroform" | "greek" | "encrypted" | "mixed-sizes";

export type Fixture = {
  readonly name: FixtureName;
  readonly file: string;
  readonly description: string;
  readonly pageCount: number;
  /** User password, when the file is encrypted. */
  readonly password?: string;
  build(): Uint8Array;
};

const A4: [number, number] = [595.28, 841.89];
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

/** Builds a page tree with all pages under one /Pages node and sets the catalog. */
function finishDocument(w: PdfWriter, pages: PageSpec[], resources: PdfDict, catalogExtra: PdfDict = {}): void {
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
    const height = 20 + ((index * 7 + b * 13) % 120);
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
  finishDocument(w, pages, resources);
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
class EmbeddedFont {
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

const GREEK_TEXT = [
  "Η Σελίς κρατά κάθε έγγραφο στη συσκευή σου.",
  "Χωρίς λογαριασμό, χωρίς σύννεφο, χωρίς παρακολούθηση.",
  "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.",
  "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ — αβγδεζηθικλμνξοπρσςτυφχψω",
  "Τόνοι και διαλυτικά: ά έ ή ί ό ύ ώ ϊ ϋ ΐ ΰ",
  "Αριθμοί 0123456789 και σημεία στίξης: « » ; · ,",
];

function buildGreek(): Uint8Array {
  const w = new PdfWriter("selis-fixture-greek");
  const greek = new EmbeddedFont(loadNotoSans("greek"), "AAAAAA+NotoSans-Greek");
  const latin = new EmbeddedFont(loadNotoSans("latin"), "AAAAAB+NotoSans-Latin");

  /** Splits text into runs per font; characters neither font has are dropped. */
  const show = (text: string, size: number, x: number, y: number): string => {
    let out = `BT ${x} ${y} Td`;
    let current: "G" | "L" | null = null;
    let run = "";
    const flush = () => {
      if (!current || !run) return;
      const font = current === "G" ? greek : latin;
      out += ` /${current} ${size} Tf ${font.encode(run)} Tj`;
      run = "";
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      const which = greek.has(cp) ? "G" : latin.has(cp) ? "L" : null;
      if (!which) continue;
      if (which !== current) {
        flush();
        current = which;
      }
      run += ch;
    }
    flush();
    return `${out} ET`;
  };

  const page1 = [show("Ελληνικό κείμενο", 26, 56, 760), ...GREEK_TEXT.map((t, i) => show(t, 13, 56, 710 - i * 26))].join(
    "\n",
  );
  const page2 = [show("Δεύτερη σελίδα", 22, 56, 760), show("Αναζήτηση: «σελίδα», «έγγραφο».", 13, 56, 720)].join("\n");

  // Content is generated before the fonts are written so the used-glyph sets are complete.
  const contents = [page1, page2];
  const resources = { Font: { G: greek.write(w), L: latin.write(w) } };
  finishDocument(
    w,
    contents.map((content) => ({ size: A4, content })),
    resources,
    { Lang: Str.ascii("el-GR") },
  );
  w.setInfo({ Title: Str.utf16("Ελληνικό δοκιμαστικό") });
  return w.toBytes();
}

export const ENCRYPTED_PASSWORD = "selis";

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
];
