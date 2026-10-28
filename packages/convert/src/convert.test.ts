import { CONVERT_FIXTURES } from "@selis/fixtures/convert";
import { describe, expect, it } from "vitest";
import { detectSeparator, parseCsv } from "./csv";
import { detectKind } from "./kind";
import { markdownToHtml } from "./markdown";
import { sanitizeCss, sanitizeHtml } from "./sanitize";
import { sheetsToHtml } from "./sheet-html";
import { cellRef, formatDate, formatNumber, isDateFormat, readXlsx } from "./xlsx";

const fixture = async (name: string) => {
  const f = CONVERT_FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f.build();
};

describe("CSV", () => {
  it("reads quotes, doubled quotes, embedded line ends, CRLF and a BOM", () => {
    const rows = parseCsv('\uFEFFname,note\r\n"Smith, J","said ""hi""\nthen left"\r\nx,\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["x", ""],
    ]);
  });

  it("detects ; and tab separators from the first line, outside quotes", () => {
    expect(detectSeparator('a;b;"c,d"\n1;2;3')).toBe(";");
    expect(detectSeparator("a\tb\tc")).toBe("\t");
    expect(detectSeparator('"a;b",c')).toBe(",");
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("kinds", () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
  it("go by extension, then MIME type; Office files must be ZIPs, text must not be binary", () => {
    expect(detectKind("Report.DOCX", null, zip)).toBe("docx");
    expect(detectKind("Report.docx", null, new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBeNull();
    expect(detectKind("data", "text/csv", new TextEncoder().encode("a,b"))).toBe("csv");
    expect(detectKind("notes.md", null, new TextEncoder().encode("# Hi"))).toBe("md");
    expect(detectKind("notes.txt", null, new Uint8Array([0x41, 0, 0x42]))).toBeNull();
    expect(detectKind("photo.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("Markdown", () => {
  it("renders headings, emphasis, code, lists, quotes, rules and tables, and escapes raw HTML", () => {
    const html = markdownToHtml(
      [
        "# Title",
        "",
        "Some **bold** and *italic* and `x < y` text.",
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "---",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```",
        "<script>alert(1)</script>",
        "```",
        "",
        "<b onclick=x>raw</b> [link](https://example.com) ![alt](https://example.com/i.png)",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>x &lt; y</code>");
    expect(html).toMatch(/<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b onclick=x&gt;raw&lt;/b&gt; link alt");
    expect(html).not.toContain("https://");
  });
});

describe("sanitiser", () => {
  it("drops scripts, frames, forms, handlers, remote URLs and CSS loads; keeps inline images", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const { html, css } = sanitizeHtml(`<html><head><style>@import url(https://x/y.css); p { background: url('https://x/bg.png'); color: red } li::before { content: "\\2022" }</style>
      <link rel=stylesheet href="https://x/s.css"><meta http-equiv=refresh content="0;url=https://x"><base href="https://x/"></head>
      <body><p onclick="steal()" style="background-image:url(https://x/t.png)">Hello <a href="https://x">link</a></p>
      <script>steal()</script><iframe src="https://x"></iframe><object data="x"></object><form action="https://x"><input name=a></form>
      <img src="https://x/track.gif" alt="remote"><img src="${png}" alt="inline"><svg><image href="https://x/a.png"/></svg>
      <custom-el>kept text</custom-el><!-- comment --></body></html>`);
    expect(html).not.toMatch(/script|iframe|object|form|input|onclick|https?:|<svg|<link|<meta|<base|comment/i);
    expect(html).toContain("Hello <a>link</a>");
    expect(html).toContain(`<img src="${png}" alt="inline">`);
    expect(html).toContain("remote");
    expect(html).toContain("kept text");
    expect(css).not.toMatch(/@import|https?:/);
    expect(css).toContain("color: red");
    expect(css).toContain('content: "\\2022"');
  });

  it("removes escaped and image-set loads from CSS", () => {
    const css = sanitizeCss("a { background: u\\72l(https://x); b: image-set('https://x/a.png' 1x); c: expression(alert(1)); -moz-binding: url(x) }");
    // `u72l(…)` is no CSS function any more: nothing in it is fetched.
    expect(css).not.toMatch(/url\(|expression\(|image-set\(|-moz-binding/i);
  });
});

describe("Excel", () => {
  it("formats numbers and dates the way the cell's format shows them", () => {
    expect(formatNumber(1234.5, '"$"#,##0.00')).toBe("$1,234.50");
    expect(formatNumber(-0.1234, "0.0%")).toBe("-12.3%");
    expect(formatNumber(1234.5, "General")).toBe("1234.5");
    expect(formatNumber(-5, "#,##0;(#,##0)")).toBe("(5)");
    expect(formatNumber(12345.678, "0.00E+00")).toBe("1.23E+04");
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat('0.0" days"')).toBe(false);
    expect(isDateFormat("[h]:mm:ss")).toBe(true);
    expect(formatDate(46023, "yyyy-mm-dd", false)).toBe("2026-01-01");
    expect(formatDate(46023.375, "yyyy-mm-dd hh:mm", false)).toBe("2026-01-01 09:00");
    expect(formatDate(1, "yyyy-mm-dd", false)).toBe("1900-01-01");
    expect(formatDate(0, "yyyy-mm-dd", true)).toBe("1904-01-01");
    expect(cellRef("BC12")).toEqual({ col: 54, row: 11 });
  });

  it("reads the corpus: visible sheets, shared strings, formats, merges, cached formula values", async () => {
    const multi = await readXlsx(await fixture("multi-sheet"));
    expect(multi.map((s) => s.name)).toEqual(["North", "South", "West"]);
    const sales = (await readXlsx(await fixture("sales-small")))[0];
    expect(sales?.rows[0]?.map((c) => c?.text)).toEqual(["Product", "January", "February", "March", "Growth"]);
    expect(sales?.rows[1]?.[1]?.text).toMatch(/^\$[\d,]+\.\d\d$/);
    expect(sales?.rows[1]?.[4]?.text).toMatch(/^-?\d+\.\d%$/);
    const dates = (await readXlsx(await fixture("dates")))[0];
    expect(dates?.rows[1]?.[1]?.text).toBe("2026-01-01");
    expect(dates?.rows[1]?.[2]?.text).toBe("2026-01-01 09:00");
    const merged = (await readXlsx(await fixture("merged-headers")))[0];
    expect(merged?.rows[0]?.[0]).toMatchObject({ text: "Question", rowSpan: 2 });
    expect(merged?.rows[0]?.[1]).toMatchObject({ text: "First wave", colSpan: 2 });
    expect(merged?.rows[0]?.[2]).toBeNull();
    const formulas = (await readXlsx(await fixture("formulas")))[0];
    const total = formulas?.rows.at(-1);
    expect(total?.[0]?.text).toBe("Total");
    expect(Number(total?.[1]?.text)).toBeGreaterThan(0);
  });

  it("fits a wide sheet to a landscape page and a narrow one to portrait", async () => {
    const wide = sheetsToHtml(await readXlsx(await fixture("wide-sheet")));
    expect(wide.page.width).toBe("297mm");
    const narrow = sheetsToHtml(await readXlsx(await fixture("sales-small")));
    expect(narrow.page.width).toBe("210mm");
    expect(narrow.body).toMatch(/<table style="font-size:\d+(\.\d+)?pt">/);
  });
});
