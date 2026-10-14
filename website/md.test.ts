import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escapeHtml, inline, markdownToHtml, slug } from "./md";

describe("markdown subset", () => {
  it("escapes text and keeps only the supported inline forms", () => {
    expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe("&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;");
    expect(inline("**Bold** and `code <x>` and [a link](PRIVACY.md) and <https://example.com/x>", (h) => h.replace("PRIVACY.md", "../privacy/"))).toBe(
      '<strong>Bold</strong> and <code>code &lt;x&gt;</code> and <a href="../privacy/">a link</a> and <a href="https://example.com/x">https://example.com/x</a>',
    );
    expect(inline("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("joins wrapped paragraphs and list items, renders tables and headings with ids", () => {
    const md = "# Title\n\nFirst line\nsecond line.\n\n## Network use\n\n- One\n  continued.\n- Two\n\n| A | B |\n| --- | --- |\n| 1 | **2** |\n";
    const { title, html, headings } = markdownToHtml(md);
    expect(title).toBe("Title");
    expect(html).toBe(
      [
        "<p>First line second line.</p>",
        '<h2 id="network-use">Network use</h2>',
        "<ul><li>One continued.</li><li>Two</li></ul>",
        '<div class="table"><table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table></div>',
      ].join("\n"),
    );
    expect(headings).toEqual([{ level: 2, text: "Network use", id: "network-use" }]);
  });

  it("makes Greek slugs without accents", () => {
    expect(slug("Χρήση δικτύου")).toBe("χρηση-δικτυου");
  });

  it("converts both privacy policies without leaving Markdown behind", () => {
    for (const file of ["PRIVACY.md", "PRIVACY.el.md"]) {
      const { title, html } = markdownToHtml(readFileSync(join(import.meta.dirname, "..", "docs", file), "utf8"));
      expect(title.length).toBeGreaterThan(0);
      expect(html).not.toMatch(/\*\*|^#|\]\(/m);
      expect(html).toContain("<table>");
    }
  });
});
