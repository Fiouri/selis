import { parseCsv } from "./csv";
import { A4_PAGE, type PageSetup, printDocument } from "./html";
import { decodeText, type SourceKind } from "./kind";
import { MARKDOWN_CSS, markdownToHtml } from "./markdown";
import { sanitizeCss, sanitizeHtml, sanitizeTree } from "./sanitize";
import { sheetsToHtml } from "./sheet-html";
import { TEXT_CSS, textToHtml } from "./text";
import { readXlsx } from "./xlsx";

/** A print-ready, sanitised, self-contained HTML document and how many words it carries. */
export type PrintableHtml = { readonly html: string; readonly page: PageSetup };

/**
 * Converts a document to print HTML (ADR 0035). Every path ends in the allow-list
 * sanitiser; DOCX is laid out by docx-preview in an inert document (nothing it creates
 * loads or runs), XLSX/CSV become tables fitted to the page, text and Markdown are
 * escaped, HTML is parsed inertly.
 */
export async function toPrintableHtml(kind: SourceKind, bytes: Uint8Array, title: string): Promise<PrintableHtml> {
  switch (kind) {
    case "docx":
      return docxToHtml(bytes, title);
    case "xlsx": {
      const { body, css, page } = sheetsToHtml(await readXlsx(bytes));
      return finish(title, body, css, page);
    }
    case "csv": {
      const rows = parseCsv(decodeText(bytes));
      const { body, css, page } = sheetsToHtml([{ name: "", rows: rows.map((r) => r.map((text) => ({ text, numeric: /^-?[\d.,]+%?$/.test(text.trim()) }))) }]);
      return finish(title, body, css, page);
    }
    case "txt":
      return finish(title, textToHtml(decodeText(bytes)), TEXT_CSS, A4_PAGE);
    case "md":
      return finish(title, markdownToHtml(decodeText(bytes)), MARKDOWN_CSS, A4_PAGE);
    case "html": {
      const { html, css } = sanitizeHtml(decodeText(bytes));
      return { html: printDocument(title, html, { css, page: A4_PAGE }), page: A4_PAGE };
    }
  }
}

/** Converter output that is ours (escaped text, our tables) still goes through the sanitiser. */
function finish(title: string, body: string, css: string, page: PageSetup): PrintableHtml {
  const { html } = sanitizeHtml(body);
  return { html: printDocument(title, html, { css: sanitizeCss(css), page }), page };
}

/** Lengths docx-preview writes (`612pt`, `1in`, `2.54cm`) kept as CSS lengths. */
function length(value: string, fallback: string): string {
  return /^\d+(\.\d+)?(pt|px|in|cm|mm)$/.test(value.trim()) ? value.trim() : fallback;
}

async function docxToHtml(bytes: Uint8Array, title: string): Promise<PrintableHtml> {
  const { renderAsync } = await import("docx-preview");
  // An inert document: elements created in it never fetch images or run anything.
  const doc = document.implementation.createHTMLDocument(title);
  const body = doc.createElement("div");
  const styles = doc.createElement("div");
  doc.body.append(styles, body);
  await renderAsync(bytes, body, styles, {
    className: "docx",
    inWrapper: false,
    ignoreWidth: false,
    ignoreHeight: true,
    ignoreFonts: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    experimental: false,
    useBase64URL: true,
    renderChanges: false,
    renderHeaders: false,
    renderFooters: false,
    renderFootnotes: true,
    renderEndnotes: true,
    renderComments: false,
    renderAltChunks: false,
    debug: false,
  });
  // The page setup of the first section becomes the print page; sections then flow
  // without their own padding (the page margins take its place).
  const first = body.querySelector<HTMLElement>("section.docx");
  const style = first?.style;
  const page: PageSetup = style
    ? {
        width: length(style.width, A4_PAGE.width),
        height: length(style.minHeight || style.height, A4_PAGE.height),
        margin: {
          top: length(style.paddingTop, A4_PAGE.margin.top),
          right: length(style.paddingRight, A4_PAGE.margin.right),
          bottom: length(style.paddingBottom, A4_PAGE.margin.bottom),
          left: length(style.paddingLeft, A4_PAGE.margin.left),
        },
      }
    : A4_PAGE;
  const sections = Array.from(body.querySelectorAll<HTMLElement>("section.docx"));
  sections.forEach((section, i) => {
    section.removeAttribute("style");
    if (i > 0) section.setAttribute("style", "break-before: page;");
  });
  const { html, css } = sanitizeTree(doc.body);
  const flow = `
section.docx { width: auto !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; box-shadow: none !important; background: transparent !important; }
section.docx > article { margin: 0 !important; }
`;
  return { html: printDocument(title, html, { css: `${css}\n${flow}`, page }), page };
}
