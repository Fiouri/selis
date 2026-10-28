/**
 * The file-conversion corpus (ADR 0035): 12 Word and 8 Excel documents in English,
 * generated here (no third-party files). Each entry knows the words it carries, in
 * reading order, so a conversion can be checked for lost or reordered text; the page
 * counts LibreOffice gives them are in convert-reference.ts.
 */
import {
  AlignmentType,
  Document,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { createCanvas } from "@napi-rs/canvas";
import { buildXlsx, type XlsxSheet, type XlsxValue } from "./xlsx-writer.ts";

export type ConvertFixture = {
  readonly name: string;
  readonly file: string;
  readonly kind: "docx" | "xlsx";
  readonly description: string;
  /** The text in reading order (what a reader sees), for the word checks. */
  readonly words: readonly string[];
  build(): Promise<Uint8Array>;
};

// ---- English filler ------------------------------------------------------------------------

const WORDS = (
  "the of and to in is that for it as was with be by on not this are or from at which but have an they more one " +
  "all were there been has when who will no would their what so if out up about into than them can only other new some " +
  "could time these two may then first any like now my such make over our even most made after also did many before must " +
  "through back years where much your way well down should because each just those people how too little state good very " +
  "world still own see men work long here get both between life being under never day same another know while last might " +
  "us great old year off come since against go came right used take three himself few house use during without again place " +
  "around however home small found thought went say part once general high upon school every water report market plan " +
  "budget team review project number system order service company figure table page section result method study account " +
  "summary meeting quarter growth sales revenue customer product design office travel policy staff training safety"
).split(" ");

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(random: () => number, min = 8, max = 18): string {
  const count = min + Math.floor(random() * (max - min + 1));
  const words = Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)] ?? "the");
  const first = words[0] ?? "the";
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(" ")}.`;
}

function paragraphText(random: () => number, sentences = 4): string {
  return Array.from({ length: sentences }, () => sentence(random)).join(" ");
}

/**
 * Words as a reader sees them: split on whitespace, punctuation at the ends dropped. A number
 * glued to a word is split off: text extraction joins a footnote mark to the note ("1The") and
 * to the end of the sentence that cites it ("when.1").
 */
export function wordsOf(text: string): string[] {
  return text
    .replace(/(\p{N})(\p{L})|(\p{L}|[.,;:!?])(\p{N})/gu, (_m, n?: string, l?: string, a?: string, b?: string) => (n ? `${n} ${l ?? ""}` : `${a ?? ""} ${b ?? ""}`))
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");
}

// ---- Word ----------------------------------------------------------------------------------

const A4 = { width: 11906, height: 16838 };
const LETTER = { width: 12240, height: 15840 };
const MARGIN = { top: 1440, right: 1440, bottom: 1440, left: 1440 };

type Section = { size?: { width: number; height: number }; landscape?: boolean; children: Array<Paragraph | Table> };

/** Builds a document and records its text in order (paragraph by paragraph). */
class Doc {
  readonly text: string[] = [];
  readonly sections: Section[] = [];
  readonly footnotes: Record<number, { children: Paragraph[] }> = {};

  section(options: Omit<Section, "children"> = {}): Section {
    const section: Section = { ...options, children: [] };
    this.sections.push(section);
    return section;
  }

  para(section: Section, text: string, options: { heading?: 1 | 2 | 3; align?: "center" | "right" | "justify"; size?: number } = {}): void {
    this.text.push(text);
    const heading = options.heading === 1 ? HeadingLevel.HEADING_1 : options.heading === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
    const alignment = options.align === "center" ? AlignmentType.CENTER : options.align === "right" ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED;
    section.children.push(
      new Paragraph({
        ...(options.heading ? { heading } : {}),
        ...(options.align ? { alignment } : {}),
        children: [new TextRun({ text, ...(options.size ? { size: options.size * 2 } : {}) })],
      }),
    );
  }

  runs(section: Section, runs: ReadonlyArray<{ text: string; bold?: boolean; italics?: boolean }>): void {
    this.text.push(runs.map((r) => r.text).join(""));
    section.children.push(
      new Paragraph({ children: runs.map((r) => new TextRun({ text: r.text, ...(r.bold ? { bold: true } : {}), ...(r.italics ? { italics: true } : {}) })) }),
    );
  }

  async build(): Promise<Uint8Array> {
    const doc = new Document({
      creator: "Selis fixtures",
      styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
      numbering: {
        config: [
          {
            reference: "numbers",
            levels: [
              { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
              { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2)", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
            ],
          },
        ],
      },
      footnotes: this.footnotes,
      sections: this.sections.map((s) => {
        const size = s.size ?? A4;
        return {
          properties: {
            page: {
              size: s.landscape ? { width: size.height, height: size.width, orientation: PageOrientation.LANDSCAPE } : size,
              margin: MARGIN,
            },
          },
          children: s.children,
        };
      }),
    });
    return new Uint8Array(await Packer.toBuffer(doc));
  }
}

function png(width: number, height: number, hue: number): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${String(hue)}, 70%, 55%)`);
  gradient.addColorStop(1, `hsl(${String((hue + 60) % 360)}, 70%, 35%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, width - 20, height - 20);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

function wordFixture(name: string, description: string, fill: (doc: Doc, random: () => number) => void, seed: number): ConvertFixture {
  const make = () => {
    const doc = new Doc();
    fill(doc, rng(seed));
    return doc;
  };
  const probe = make();
  return {
    name,
    file: `${name}.docx`,
    kind: "docx",
    description,
    words: wordsOf(probe.text.join(" ")),
    build: () => make().build(),
  };
}

const WORD_FIXTURES: ConvertFixture[] = [
  wordFixture("letter-a4", "One-page letter on A4: address block, date, body, closing.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Northwind Office Supplies", { align: "right" });
    doc.para(s, "12 Harbour Road, Bristol", { align: "right" });
    doc.para(s, "3 March 2026");
    doc.para(s, "Dear Ms Taylor,");
    for (let i = 0; i < 4; i++) doc.para(s, paragraphText(r, 3));
    doc.para(s, "Yours sincerely,");
    doc.para(s, "James Carter");
  }, 11),
  wordFixture("report-headings", "Three-page report on Letter paper with three heading levels.", (doc, r) => {
    const s = doc.section({ size: LETTER });
    doc.para(s, "Quarterly Operations Report", { heading: 1 });
    for (let c = 1; c <= 3; c++) {
      doc.para(s, `Section ${String(c)} Overview`, { heading: 2 });
      for (let i = 0; i < 3; i++) doc.para(s, paragraphText(r, 5));
      doc.para(s, `Details for section ${String(c)}`, { heading: 3 });
      for (let i = 0; i < 2; i++) doc.para(s, paragraphText(r, 4));
    }
  }, 12),
  wordFixture("bold-italic", "Paragraphs mixing bold, italic and bold italic runs.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Formatting Sample", { heading: 1 });
    for (let i = 0; i < 10; i++) {
      doc.runs(s, [
        { text: `${sentence(r)} ` },
        { text: `${sentence(r, 4, 6)} `, bold: true },
        { text: `${sentence(r, 4, 6)} `, italics: true },
        { text: sentence(r, 3, 5), bold: true, italics: true },
      ]);
    }
  }, 13),
  wordFixture("lists", "Numbered and bulleted lists, two levels deep.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Checklist for the Spring Review", { heading: 1 });
    for (let i = 0; i < 8; i++) {
      const top = sentence(r, 5, 9);
      doc.text.push(top);
      s.children.push(new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun(top)] }));
      for (let j = 0; j < 2; j++) {
        const sub = sentence(r, 4, 8);
        doc.text.push(sub);
        s.children.push(new Paragraph({ numbering: { reference: "numbers", level: 1 }, children: [new TextRun(sub)] }));
      }
    }
    for (let i = 0; i < 6; i++) {
      const item = sentence(r, 5, 10);
      doc.text.push(item);
      s.children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] }));
    }
  }, 14),
  wordFixture("table-simple", "A 4-column table with a header row between paragraphs.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Team Budget", { heading: 1 });
    doc.para(s, paragraphText(r, 3));
    const header = ["Item", "Owner", "Quarter", "Amount"];
    const rows = Array.from({ length: 8 }, (_, i) => [`Item ${String(i + 1)} ${WORDS[i * 7] ?? "plan"}`, ["Anna", "Ben", "Chloe", "David"][i % 4] ?? "Anna", `Q${String((i % 4) + 1)}`, String(1200 + i * 350)]);
    doc.text.push([...header, ...rows.flat()].join(" "));
    s.children.push(table([header, ...rows]));
    doc.para(s, paragraphText(r, 3));
  }, 15),
  wordFixture("table-long", "A 60-row table that runs over several pages.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Inventory List", { heading: 1 });
    const header = ["Code", "Description", "Location", "Count"];
    const rows = Array.from({ length: 60 }, (_, i) => [`A${String(100 + i)}`, sentence(r, 3, 5), `Shelf ${String((i % 12) + 1)}`, String((i * 37) % 500)]);
    doc.text.push([...header, ...rows.flat()].join(" "));
    s.children.push(table([header, ...rows]));
  }, 16),
  wordFixture("images", "Three inline PNG images between paragraphs.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Site Photos", { heading: 1 });
    for (let i = 0; i < 3; i++) {
      doc.para(s, paragraphText(r, 3));
      s.children.push(new Paragraph({ children: [new ImageRun({ type: "png", data: png(480, 270, i * 100), transformation: { width: 360, height: 203 } })] }));
      doc.para(s, `Figure ${String(i + 1)}: ${sentence(r, 4, 7)}`);
    }
  }, 17),
  wordFixture("page-breaks", "Four short chapters separated by explicit page breaks.", (doc, r) => {
    const s = doc.section();
    for (let c = 1; c <= 4; c++) {
      doc.para(s, `Chapter ${String(c)}`, { heading: 1 });
      doc.para(s, paragraphText(r, 4));
      if (c < 4) s.children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }, 18),
  wordFixture("landscape", "A landscape document with wide paragraphs and a table.", (doc, r) => {
    const s = doc.section({ landscape: true });
    doc.para(s, "Annual Schedule", { heading: 1 });
    for (let i = 0; i < 3; i++) doc.para(s, paragraphText(r, 4));
    const header = ["Month", "Event", "Location", "Lead", "Budget", "Status"];
    const rows = Array.from({ length: 12 }, (_, i) => [
      ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][i] ?? "May",
      sentence(r, 2, 3),
      `Room ${String(100 + i)}`,
      ["Anna", "Ben", "Chloe"][i % 3] ?? "Anna",
      String(500 + i * 125),
      i % 2 === 0 ? "Planned" : "Booked",
    ]);
    doc.text.push([...header, ...rows.flat()].join(" "));
    s.children.push(table([header, ...rows]));
  }, 19),
  wordFixture("long-text", "Eight pages of body text.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Field Study Notes", { heading: 1 });
    for (let i = 0; i < 34; i++) doc.para(s, paragraphText(r, 5), { align: "justify" });
  }, 20),
  wordFixture("sizes-alignment", "Font sizes from 9 to 24 pt, centred, right-aligned and justified text.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Type Specimen", { align: "center", size: 24 });
    for (const size of [9, 10, 12, 14, 16, 20]) doc.para(s, `${String(size)} point text. ${sentence(r)}`, { size });
    doc.para(s, sentence(r), { align: "center" });
    doc.para(s, sentence(r), { align: "right" });
    for (let i = 0; i < 3; i++) doc.para(s, paragraphText(r, 4), { align: "justify" });
  }, 21),
  wordFixture("footnotes", "Paragraphs with footnote references and footnotes.", (doc, r) => {
    const s = doc.section();
    doc.para(s, "Research Summary", { heading: 1 });
    for (let i = 1; i <= 4; i++) {
      const body = paragraphText(r, 3);
      const note = sentence(r, 6, 10);
      doc.footnotes[i] = { children: [new Paragraph(note)] };
      doc.text.push(body);
      s.children.push(new Paragraph({ children: [new TextRun(body), new FootnoteReferenceRun(i)] }));
      doc.text.push(note);
    }
  }, 22),
];

function table(rows: readonly (readonly string[])[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells, r) =>
        new TableRow({
          tableHeader: r === 0,
          children: cells.map((text) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: r === 0 })] })] })),
        }),
    ),
  });
}

// ---- Excel ---------------------------------------------------------------------------------

/** What Excel shows for a value (the corpus only uses formats whose text is unambiguous). */
function shown(value: XlsxValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value.value);
}

function excelFixture(name: string, description: string, sheets: (random: () => number) => XlsxSheet[], seed: number, words?: (sheets: XlsxSheet[]) => string[]): ConvertFixture {
  const make = () => sheets(rng(seed));
  const probe = make();
  const text = words
    ? words(probe)
    : probe.flatMap((sheet) => [sheet.name, ...sheet.rows.flatMap((row) => row.map((v) => (typeof v === "string" ? v : "")))]).filter((t) => t !== "");
  return { name, file: `${name}.xlsx`, kind: "xlsx", description, words: wordsOf(text.join(" ")), build: () => buildXlsx(make()) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const EXCEL_FIXTURES: ConvertFixture[] = [
  excelFixture("sales-small", "One sheet: products by month with currency and percent formats.", (r) => [
    {
      name: "Sales",
      widths: [22, 12, 12, 12, 10],
      rows: [
        ["Product", "January", "February", "March", "Growth"],
        ...Array.from({ length: 28 }, (_, i) => [
          `${WORDS[(i * 5) % WORDS.length] ?? "item"} ${WORDS[(i * 11 + 3) % WORDS.length] ?? "set"}`,
          { value: Math.round(r() * 90000) / 100, format: '"$"#,##0.00' },
          { value: Math.round(r() * 90000) / 100, format: '"$"#,##0.00' },
          { value: Math.round(r() * 90000) / 100, format: '"$"#,##0.00' },
          { value: Math.round((r() - 0.3) * 1000) / 1000, format: "0.0%" },
        ]),
      ],
    },
  ], 31),
  excelFixture("dates", "Dates and times in several number formats.", () => [
    {
      name: "Calendar",
      widths: [24, 16, 16, 12],
      rows: [
        ["Event", "Date", "Starts", "Hours"],
        ...Array.from({ length: 24 }, (_, i) => [
          `Review meeting ${String(i + 1)}`,
          { value: 46023 + i * 9, format: "yyyy-mm-dd" },
          { value: 46023 + i * 9 + 0.375 + (i % 4) * 0.0625, format: "yyyy-mm-dd hh:mm" },
          { value: 1 + (i % 5) * 0.5, format: "0.0" },
        ]),
      ],
    },
  ], 32),
  excelFixture("multi-sheet", "Three visible sheets and one hidden sheet.", (r) =>
    ["North", "South", "West"]
      .map<XlsxSheet>((region) => ({
        name: region,
        widths: [20, 12, 12],
        rows: [["Office", "Staff", "Budget"], ...Array.from({ length: 15 }, (_, i) => [`${region} office ${String(i + 1)}`, Math.floor(r() * 80) + 5, Math.floor(r() * 500000)])],
      }))
      .concat([{ name: "Hidden notes", hidden: true, rows: [["This sheet is hidden and must not be printed"]] }]),
  33, (sheets) => sheets.filter((s) => !s.hidden).flatMap((s) => [s.name, ...s.rows.flatMap((row) => row.map((v) => (typeof v === "string" ? v : "")))]).filter((t) => t !== "")),
  excelFixture("merged-headers", "Merged header cells over grouped columns.", (r) => [
    {
      name: "Survey",
      widths: [20, 10, 10, 10, 10],
      merges: ["A1:A2", "B1:C1", "D1:E1"],
      rows: [
        ["Question", "First wave", null, "Second wave", null],
        [null, "Yes", "No", "Yes", "No"],
        ...Array.from({ length: 20 }, (_, i) => [`Question ${String(i + 1)} ${sentence(r, 2, 3)}`, Math.floor(r() * 100), Math.floor(r() * 100), Math.floor(r() * 100), Math.floor(r() * 100)]),
      ],
    },
  ], 34),
  excelFixture("wide-sheet", "Eighteen columns: fitted to the page width in landscape.", (r) => [
    {
      name: "Monthly",
      landscape: true,
      widths: [18, ...Array.from({ length: 17 }, () => 9)],
      rows: [
        ["Account", ...MONTHS, "Q1", "Q2", "Q3", "Q4", "Total"],
        ...Array.from({ length: 25 }, (_, i) => [`Account ${WORDS[(i * 3) % WORDS.length] ?? "x"}`, ...Array.from({ length: 17 }, () => Math.floor(r() * 10000))]),
      ],
    },
  ], 35),
  excelFixture("long-sheet", "Four hundred rows over several pages.", (r) => [
    {
      name: "Log",
      widths: [8, 30, 14, 10],
      rows: [["Line", "Entry", "Category", "Value"], ...Array.from({ length: 400 }, (_, i) => [i + 1, sentence(r, 2, 4), ["service", "travel", "office", "safety"][i % 4] ?? "office", Math.floor(r() * 1000)])],
    },
  ], 36),
  excelFixture("text-cells", "Long text in cells that wraps over several lines.", (r) => [
    {
      name: "Notes",
      widths: [16, 60],
      rows: [["Topic", "Note"], ...Array.from({ length: 18 }, (_, i) => [`Topic ${String(i + 1)}`, paragraphText(r, 2)])],
    },
  ], 37),
  excelFixture("formulas", "Totals as formulas with cached values.", (r) => {
    const values = Array.from({ length: 20 }, () => Math.floor(r() * 1000));
    return [
      {
        name: "Totals",
        widths: [20, 12, 12],
        rows: [
          ["Item", "Units", "Running"],
          ...values.map((v, i) => [`Line item ${String(i + 1)}`, v, { formula: `SUM(B$2:B${String(i + 2)})`, value: values.slice(0, i + 1).reduce((a, b) => a + b, 0) }] as XlsxValue[]),
          ["Total", { formula: "SUM(B2:B21)", value: values.reduce((a, b) => a + b, 0) }, null],
        ],
      },
    ];
  }, 38),
];

export const CONVERT_FIXTURES: readonly ConvertFixture[] = [...WORD_FIXTURES, ...EXCEL_FIXTURES];

/** Values as the converted table shows them, for numeric checks (unused cells left out). */
export { shown as shownExcelValue };
