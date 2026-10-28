/** HTML helpers shared by the converters. */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The print page: A4 portrait with 15 mm margins unless the document says otherwise.
 * Lengths are CSS lengths (`210mm`, `8.5in`, `612pt`).
 */
export type PageSetup = {
  readonly width: string;
  readonly height: string;
  readonly margin: { readonly top: string; readonly right: string; readonly bottom: string; readonly left: string };
};

export const A4_PAGE: PageSetup = { width: "210mm", height: "297mm", margin: { top: "15mm", right: "15mm", bottom: "15mm", left: "15mm" } };

/**
 * Nothing in a converted document may load anything: images are inlined as `data:`
 * URLs, styles are inline, scripts never run (the print web views also have
 * JavaScript off and block every request; this is the second fence).
 */
export const CONVERT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** Body text font stack: the platform's sans (Roboto on Android, SF on iOS). */
const BODY_FONT = "system-ui, -apple-system, Roboto, 'Noto Sans', 'Segoe UI', Arial, sans-serif";

/** A complete, self-contained HTML document for the print engine. */
export function printDocument(title: string, body: string, options: { css?: string; page?: PageSetup } = {}): string {
  const page = options.page ?? A4_PAGE;
  const m = page.margin;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CONVERT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
@page { size: ${page.width} ${page.height}; margin: ${m.top} ${m.right} ${m.bottom} ${m.left}; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: ${BODY_FONT}; font-size: 11pt; line-height: 1.35; color: #000; background: #fff; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
${options.css ?? ""}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
