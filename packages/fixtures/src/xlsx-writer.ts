/**
 * A minimal SpreadsheetML (.xlsx) writer for the conversion corpus: shared strings,
 * numbers with number formats, booleans, cached formula values, merged cells, column
 * widths and a fit-to-width page setup. Only what the corpus needs.
 */
import JSZip from "jszip";

export type XlsxValue =
  | string
  | number
  | boolean
  | null
  | { readonly value: number; readonly format: string }
  | { readonly formula: string; readonly value: number; readonly format?: string };

export type XlsxSheet = {
  readonly name: string;
  readonly rows: ReadonlyArray<ReadonlyArray<XlsxValue>>;
  readonly widths?: readonly number[];
  readonly merges?: readonly string[];
  readonly landscape?: boolean;
  readonly hidden?: boolean;
};

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export async function buildXlsx(sheets: readonly XlsxSheet[]): Promise<Uint8Array> {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const formats: string[] = [];
  const shared = (text: string) => {
    let i = stringIndex.get(text);
    if (i === undefined) {
      i = strings.length;
      strings.push(text);
      stringIndex.set(text, i);
    }
    return i;
  };
  // Style 0 is General; each custom format gets an xf (numFmtId 164 + n).
  const styleFor = (format: string) => {
    let i = formats.indexOf(format);
    if (i < 0) {
      i = formats.length;
      formats.push(format);
    }
    return i + 1;
  };
  const zip = new JSZip();
  sheets.forEach((sheet, s) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            if (value === null || value === "") return "";
            const ref = `${columnName(c)}${String(r + 1)}`;
            if (typeof value === "string") return `<c r="${ref}" t="s"><v>${String(shared(value))}</v></c>`;
            if (typeof value === "number") return `<c r="${ref}"><v>${String(value)}</v></c>`;
            if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? "1" : "0"}</v></c>`;
            if ("formula" in value) {
              const style = value.format ? ` s="${String(styleFor(value.format))}"` : "";
              return `<c r="${ref}"${style}><f>${esc(value.formula)}</f><v>${String(value.value)}</v></c>`;
            }
            return `<c r="${ref}" s="${String(styleFor(value.format))}"><v>${String(value.value)}</v></c>`;
          })
          .join("");
        return `<row r="${String(r + 1)}">${cells}</row>`;
      })
      .join("");
    const cols = sheet.widths
      ? `<cols>${sheet.widths.map((w, i) => `<col min="${String(i + 1)}" max="${String(i + 1)}" width="${String(w)}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const merges = sheet.merges?.length ? `<mergeCells count="${String(sheet.merges.length)}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    zip.file(
      `xl/worksheets/sheet${String(s + 1)}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${cols}<sheetData>${rows}</sheetData>${merges}<pageMargins left="0.59" right="0.59" top="0.59" bottom="0.59" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${sheet.landscape ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/></worksheet>`,
    );
  });
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map((_, s) => `<Override PartName="/xl/worksheets/sheet${String(s + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((sheet, s) => `<sheet name="${esc(sheet.name)}" sheetId="${String(s + 1)}"${sheet.hidden ? ' state="hidden"' : ""} r:id="rId${String(s + 1)}"/>`)
      .join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, s) => `<Relationship Id="rId${String(s + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(s + 1)}.xml"/>`)
      .join("")}<Relationship Id="rId${String(sheets.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${String(
      sheets.length + 2,
    )}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(strings.length)}" uniqueCount="${String(strings.length)}">${strings
      .map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`)
      .join("")}</sst>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${String(formats.length)}">${formats
      .map((f, i) => `<numFmt numFmtId="${String(164 + i)}" formatCode="${esc(f)}"/>`)
      .join(
        "",
      )}</numFmts><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${String(
      formats.length + 1,
    )}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${formats
      .map((_, i) => `<xf numFmtId="${String(164 + i)}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`)
      .join("")}</cellXfs></styleSheet>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
