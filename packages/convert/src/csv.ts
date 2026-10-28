/**
 * RFC 4180 CSV reader: quoted fields, `""` escapes, CR/LF/CRLF line ends, a UTF-8 BOM,
 * and the separator (`,` `;` or tab) detected from the first line outside quotes.
 */

export type Separator = "," | ";" | "\t";

/** The separator that occurs most often in the first record (`,` on a tie or none). */
export function detectSeparator(text: string): Separator {
  const counts: Record<Separator, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && (c === "," || c === ";" || c === "\t")) counts[c]++;
  }
  let best: Separator = ",";
  for (const sep of [";", "\t"] as const) if (counts[sep] > counts[best]) best = sep;
  return best;
}

/** Rows of fields. A trailing line end does not add an empty row. */
export function parseCsv(input: string, separator: Separator = detectSeparator(input.replace(/^\uFEFF/, ""))): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i] ?? "";
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === separator) endField();
    else if (c === "\r") {
      endRow();
      if (text[i + 1] === "\n") i++;
    } else if (c === "\n") endRow();
    else field += c;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
