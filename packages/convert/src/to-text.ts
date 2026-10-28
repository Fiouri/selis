import { blockText, type Span, type StructuredPage } from "./structure";

/** Plain text: paragraphs separated by a blank line, pages by a form feed. */
export function toPlainText(pages: readonly StructuredPage[]): string {
  return `${pages
    .map((page) =>
      page.blocks
        .map(blockText)
        .filter((t) => t !== "")
        .join("\n\n"),
    )
    .join("\n\n\f\n\n")
    .trim()}\n`;
}

const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]#<>|])/g, "\\$1").replace(/^(\s*)([-+]|\d+\.)(\s)/, "$1\\$2$3");

function spansToMarkdown(spans: readonly Span[]): string {
  return spans
    .map((span) => {
      const text = escapeMarkdown(span.text.replace(/\s+/g, " "));
      const core = text.trim();
      if (core === "" || (!span.bold && !span.italic)) return text;
      const mark = span.bold && span.italic ? "***" : span.bold ? "**" : "*";
      const lead = text.slice(0, text.indexOf(core));
      const trail = text.slice(text.indexOf(core) + core.length);
      return `${lead}${mark}${core}${mark}${trail}`;
    })
    .join("")
    .trim();
}

/** Markdown: `#` / `##` headings, emphasis, a rule between pages; images are left out. */
export function toMarkdown(pages: readonly StructuredPage[]): string {
  return `${pages
    .map((page) =>
      page.blocks
        .flatMap((block) => {
          if (block.kind !== "paragraph") return [];
          const text = block.heading > 0 ? escapeMarkdown(blockText(block)) : spansToMarkdown(block.spans);
          if (text === "") return [];
          return [block.heading > 0 ? `${"#".repeat(block.heading)} ${text}` : text];
        })
        .join("\n\n"),
    )
    .filter((p) => p !== "")
    .join("\n\n---\n\n")
    .trim()}\n`;
}
