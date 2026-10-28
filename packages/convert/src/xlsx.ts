import JSZip from "jszip";
import type { Sheet, SheetCell } from "./sheet-html";

/**
 * Reads the visible sheets of an .xlsx workbook (Office Open XML, SpreadsheetML) into
 * cells as Excel shows them: shared and inline strings, numbers by their number format
 * (decimals, thousands, percent, currency text), dates and times, booleans, errors,
 * merged cells and column widths. Formulas show their cached value; nothing is
 * recalculated, and macros (vbaProject.bin) are never read.
 */

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** Bounds a hostile or huge sheet: what fits on a few hundred printed pages. */
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 200;

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
  22: "yyyy-mm-dd h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("the workbook is damaged (invalid XML)");
  return doc;
}

function children(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(MAIN_NS, name));
}

async function xml(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  return file ? parseXml(await file.async("string")) : null;
}

/** Text of a string item (`<si>` or `<is>`): its `<t>` runs, phonetic runs left out. */
function itemText(item: Element): string {
  let text = "";
  for (const t of Array.from(item.getElementsByTagNameNS(MAIN_NS, "t"))) {
    if (t.parentElement?.localName === "rPh") continue;
    text += t.textContent;
  }
  return text;
}

/** "BC12" → { col: 54, row: 11 } (zero-based). */
export function cellRef(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^([A-Z]{1,3})(\d{1,7})$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1] ?? "") col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Whether a number format shows a date or time (letters outside quotes, escapes and brackets). */
export function isDateFormat(format: string): boolean {
  const bare = (format.split(";")[0] ?? "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(h+|m+|s+)\]/gi, "h")
    .replace(/\[[^\]]*\]/g, "");
  return /[dmyhs]/i.test(bare) && !/^[#0.,%E+-]*$/i.test(bare);
}

const MS_PER_DAY = 86_400_000;

/** An Excel serial date as text in the format's own order (ISO-like, unambiguous). */
export function formatDate(serial: number, format: string, date1904: boolean): string {
  // Serial of 1970-01-01. Day 60 is Excel's fictitious 29 Feb 1900: serials before it are one day off.
  const epoch = date1904 ? 24_107 : serial < 60 ? 25_568 : 25_569;
  const d = new Date(Math.round((serial - epoch) * MS_PER_DAY));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const bare = format.toLowerCase().replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  const hasDate = /[dy]/.test(bare) || /m{3,}/.test(bare) || (/m/.test(bare) && !/[hs]/.test(bare));
  const hasTime = /[hs]/.test(bare);
  const date = `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  let time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (/s/.test(bare)) time += `:${pad(d.getUTCSeconds())}`;
  if (/\[h\]/i.test(format)) time = `${String(Math.floor(serial * 24))}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (hasDate && hasTime) return `${date} ${time}`;
  return hasTime ? time : date;
}

/** A number as its format shows it (General, fixed decimals, thousands, percent, scientific, literal text). */
export function formatNumber(value: number, format: string): string {
  const sections = format.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  let section = sections[0] ?? "General";
  let negative = false;
  if (value < 0 && sections[1] !== undefined) {
    section = sections[1];
    negative = true;
  } else if (value === 0 && sections[2] !== undefined) section = sections[2];
  const shown = negative ? Math.abs(value) : value;
  const clean = section.replace(/\[[^\]]*\]/g, "");
  if (clean.trim() === "" || /^general$/i.test(clean.trim())) return general(value);
  if (clean.trim() === "@") return general(value);
  const pattern = clean.match(/[#0?][#0?,]*(\.[#0?]*)?(%)?(E[+-]0+)?/i);
  if (!pattern) return general(value);
  const literal = (s: string) => s.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/_./g, " ").replace(/\*./g, "");
  const prefix = literal(clean.slice(0, pattern.index));
  const suffix = literal(clean.slice((pattern.index ?? 0) + pattern[0].length));
  const decimals = (pattern[1] ?? ".").length - 1;
  const percent = clean.includes("%");
  const scientific = pattern[3] !== undefined;
  const thousands = /[#0],[#0]/.test(pattern[0]);
  const scaled = percent ? shown * 100 : shown;
  let body: string;
  if (scientific) body = scaled.toExponential(decimals).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
  else
    body = scaled.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: thousands,
    });
  return `${prefix}${body}${percent && !suffix.includes("%") ? "%" : ""}${suffix}`.trim();
}

/** Excel's General: up to 11 significant digits, no trailing zeros. */
function general(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-9 || abs >= 1e11)) return value.toExponential(5).replace(/\.?0+e/, "E").toUpperCase();
  return String(Number(value.toPrecision(11)));
}

type Styles = { formats: string[] };

async function readStyles(zip: JSZip, path: string | null): Promise<Styles> {
  const doc = path ? await xml(zip, path) : null;
  if (!doc) return { formats: [] };
  const custom = new Map<number, string>();
  for (const fmt of children(doc, "numFmt")) custom.set(Number(fmt.getAttribute("numFmtId")), fmt.getAttribute("formatCode") ?? "General");
  const xfs = children(doc, "cellXfs")[0];
  const formats = xfs
    ? children(xfs, "xf").map((xf) => {
        const id = Number(xf.getAttribute("numFmtId") ?? 0);
        return custom.get(id) ?? BUILTIN_FORMATS[id] ?? "General";
      })
    : [];
  return { formats };
}

type SheetRef = { name: string; path: string };

async function workbook(zip: JSZip): Promise<{ sheets: SheetRef[]; date1904: boolean; shared: string | null; styles: string | null }> {
  const book = await xml(zip, "xl/workbook.xml");
  if (!book) throw new Error("not an Excel workbook (xl/workbook.xml missing)");
  const rels = await xml(zip, "xl/_rels/workbook.xml.rels");
  const targets = new Map<string, { target: string; type: string }>();
  if (rels) {
    for (const rel of Array.from(rels.getElementsByTagName("Relationship"))) {
      if (rel.getAttribute("TargetMode") === "External") continue;
      targets.set(rel.getAttribute("Id") ?? "", { target: rel.getAttribute("Target") ?? "", type: rel.getAttribute("Type") ?? "" });
    }
  }
  const byType = (suffix: string) => {
    for (const { target, type } of targets.values()) if (type.endsWith(suffix)) return resolve("xl/workbook.xml", target);
    return null;
  };
  const sheets: SheetRef[] = [];
  for (const sheet of children(book, "sheet")) {
    const state = sheet.getAttribute("state");
    if (state === "hidden" || state === "veryHidden") continue;
    const target = targets.get(sheet.getAttributeNS(REL_NS, "id") ?? "");
    if (!target || !target.type.endsWith("/worksheet")) continue;
    sheets.push({ name: sheet.getAttribute("name") ?? "", path: resolve("xl/workbook.xml", target.target) });
  }
  const pr = children(book, "workbookPr")[0];
  const date1904 = pr?.getAttribute("date1904") === "1" || pr?.getAttribute("date1904") === "true";
  return { sheets, date1904, shared: byType("/sharedStrings"), styles: byType("/styles") };
}

function cellText(c: Element, shared: readonly string[], styles: Styles, date1904: boolean): SheetCell | undefined {
  const type = c.getAttribute("t") ?? "n";
  const v = children(c, "v")[0]?.textContent ?? null;
  if (type === "inlineStr") {
    const is = children(c, "is")[0];
    return is ? { text: itemText(is) } : undefined;
  }
  if (v === null) return undefined;
  if (type === "s") return { text: shared[Number(v)] ?? "" };
  if (type === "str") return { text: v };
  if (type === "b") return { text: v === "1" ? "TRUE" : "FALSE" };
  if (type === "e") return { text: v };
  const value = Number(v);
  if (!Number.isFinite(value)) return { text: v };
  const format = styles.formats[Number(c.getAttribute("s") ?? 0)] ?? "General";
  if (type === "d") return { text: v.replace("T", " ").replace(/Z$/, ""), numeric: true };
  if (isDateFormat(format)) return { text: formatDate(value, format, date1904), numeric: true };
  return { text: formatNumber(value, format), numeric: true };
}

async function readSheet(zip: JSZip, ref: SheetRef, shared: readonly string[], styles: Styles, date1904: boolean): Promise<Sheet> {
  const doc = await xml(zip, ref.path);
  if (!doc) return { name: ref.name, rows: [] };
  const grid: Array<Array<SheetCell | null>> = [];
  let width = 0;
  for (const row of children(doc, "row")) {
    const r = Number(row.getAttribute("r") ?? grid.length + 1) - 1;
    if (r < 0 || r >= MAX_ROWS) continue;
    let next = 0;
    for (const c of children(row, "c")) {
      const at = cellRef(c.getAttribute("r") ?? "") ?? { col: next, row: r };
      next = at.col + 1;
      if (at.col >= MAX_COLUMNS) continue;
      const cell = cellText(c, shared, styles, date1904);
      if (!cell || cell.text === "") continue;
      const line = (grid[r] ??= []);
      line[at.col] = cell;
      width = Math.max(width, at.col + 1);
    }
  }
  for (const merge of children(doc, "mergeCell")) {
    const [from, to] = (merge.getAttribute("ref") ?? "").split(":").map(cellRef);
    if (!from || !to || from.row >= MAX_ROWS || from.col >= MAX_COLUMNS) continue;
    const rows = Math.min(to.row, MAX_ROWS - 1) - from.row + 1;
    const cols = Math.min(to.col, MAX_COLUMNS - 1) - from.col + 1;
    const line = (grid[from.row] ??= []);
    line[from.col] = { ...(line[from.col] ?? { text: "" }), rowSpan: rows, colSpan: cols };
    width = Math.max(width, from.col + cols);
    for (let y = from.row; y < from.row + rows; y++) {
      for (let x = from.col; x < from.col + cols; x++) if (y !== from.row || x !== from.col) (grid[y] ??= [])[x] = null;
    }
  }
  // Trailing empty rows go; empty rows in between stay (they are spacing in the sheet).
  let height = grid.length;
  while (height > 0 && (grid[height - 1] ?? []).length === 0) height--;
  const rows: Array<Array<SheetCell | null>> = [];
  for (let y = 0; y < height; y++) {
    const line = grid[y] ?? [];
    rows.push(Array.from({ length: width }, (_, x) => (line[x] === undefined ? { text: "" } : (line[x] ?? null))));
  }
  const widths: Array<number | undefined> = [];
  for (const col of children(doc, "col")) {
    const w = Number(col.getAttribute("width"));
    if (!Number.isFinite(w) || w <= 0) continue;
    const min = Number(col.getAttribute("min") ?? 1) - 1;
    const max = Math.min(Number(col.getAttribute("max") ?? min + 1), width);
    for (let x = min; x < max; x++) widths[x] = w;
  }
  return { name: ref.name, rows, widths };
}

export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(bytes);
  const book = await workbook(zip);
  const sharedDoc = book.shared ? await xml(zip, book.shared) : null;
  const shared = sharedDoc ? children(sharedDoc, "si").map(itemText) : [];
  const styles = await readStyles(zip, book.styles);
  const sheets: Sheet[] = [];
  for (const ref of book.sheets) sheets.push(await readSheet(zip, ref, shared, styles, book.date1904));
  return sheets;
}
