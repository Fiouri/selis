import { escapeHtml, type PageSetup } from "./html";

/** One cell as shown: its text, right-aligned when it is a number or a date. */
export type SheetCell = { readonly text: string; readonly numeric?: boolean; readonly colSpan?: number; readonly rowSpan?: number };

export type Sheet = {
  readonly name: string;
  /** Rows of cells; `null` marks a cell covered by a merged cell to its left or above. */
  readonly rows: ReadonlyArray<ReadonlyArray<SheetCell | null>>;
  /** Column widths in characters where the file gives them. */
  readonly widths?: ReadonlyArray<number | undefined>;
};

/** Printable width of A4 portrait / landscape with 15 mm margins, in points. */
const PORTRAIT_PT = (180 / 25.4) * 72;
const LANDSCAPE_PT = (267 / 25.4) * 72;
/** A character of the body font is about half the font size wide. */
const CHAR_EM = 0.55;
const MAX_FONT = 10;
const MIN_FONT = 6;
const MIN_COLUMN = 3;
const MAX_COLUMN = 48;

function columnWidths(sheet: Sheet): number[] {
  const count = Math.max(0, ...sheet.rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < count; c++) {
    let longest = 0;
    for (const row of sheet.rows) {
      const cell = row[c];
      if (cell && (cell.colSpan ?? 1) === 1) longest = Math.max(longest, ...cell.text.split("\n").map((l) => l.length));
    }
    const given = sheet.widths?.[c];
    const chars = given !== undefined ? Math.max(given, Math.min(longest, given * 1.5)) : longest + 1;
    widths.push(Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, chars)));
  }
  return widths;
}

/** Font size (pt) that fits `chars` characters across `widthPt`. */
function fittingFont(chars: number, widthPt: number): number {
  return Math.min(MAX_FONT, widthPt / Math.max(1, chars * CHAR_EM));
}

/**
 * Sheets as tables scaled to the page width, one sheet per page run. The print engine
 * paginates by rows (a row never splits). Landscape when a sheet would need a font
 * below 7 pt in portrait.
 */
export function sheetsToHtml(sheets: readonly Sheet[]): { body: string; css: string; page: PageSetup } {
  const layouts = sheets.map((sheet) => {
    const widths = columnWidths(sheet);
    return { sheet, widths, chars: widths.reduce((a, b) => a + b, 0) };
  });
  const landscape = layouts.some((l) => fittingFont(l.chars, PORTRAIT_PT) < 7);
  const usable = landscape ? LANDSCAPE_PT : PORTRAIT_PT;
  const sections = layouts.map(({ sheet, widths, chars }, index) => {
    const font = Math.max(MIN_FONT, fittingFont(chars, usable));
    const cols = widths.map((w) => `<col style="width:${((w / Math.max(1, chars)) * 100).toFixed(3)}%">`).join("");
    const rows = sheet.rows
      .map((row) => {
        const cells = row
          .map((cell) => {
            if (cell === null) return "";
            const span = `${(cell.colSpan ?? 1) > 1 ? ` colspan="${String(cell.colSpan)}"` : ""}${
              (cell.rowSpan ?? 1) > 1 ? ` rowspan="${String(cell.rowSpan)}"` : ""
            }`;
            return `<td${span}${cell.numeric ? ' class="n"' : ""}>${escapeHtml(cell.text)}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("\n");
    const title = sheets.length > 1 || sheet.name ? `<h2>${escapeHtml(sheet.name)}</h2>` : "";
    return `<section class="sheet${index > 0 ? " next" : ""}">${title}<table style="font-size:${font.toFixed(2)}pt"><colgroup>${cols}</colgroup><tbody>
${rows}
</tbody></table></section>`;
  });
  const css = `
.sheet.next { break-before: page; }
.sheet h2 { font-size: 12pt; margin: 0 0 6pt; }
.sheet table { width: 100%; table-layout: fixed; border-collapse: collapse; line-height: 1.15; }
.sheet td { border: 0.5pt solid #bbb; padding: 1pt 3pt; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
.sheet td.n { text-align: right; }
.sheet tr { break-inside: avoid; }
`;
  const page: PageSetup = {
    width: landscape ? "297mm" : "210mm",
    height: landscape ? "210mm" : "297mm",
    margin: { top: "15mm", right: "15mm", bottom: "15mm", left: "15mm" },
  };
  return { body: sections.join("\n"), css, page };
}
