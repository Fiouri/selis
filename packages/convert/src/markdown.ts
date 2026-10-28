import { escapeHtml } from "./html";

/**
 * A CommonMark subset for printing: ATX and setext headings, paragraphs, emphasis,
 * code spans and fenced code, bullet and numbered lists (nested by indentation),
 * block quotes, thematic breaks and GFM pipe tables. Raw HTML is shown as text,
 * links as their text (nothing is loaded or followed), images as their alt text.
 */
export function markdownToHtml(input: string): string {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines).join("\n");
}

export const MARKDOWN_CSS = `
h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1.1em 0 0.45em; break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13.5pt; } h4, h5, h6 { font-size: 11.5pt; }
p, ul, ol, blockquote, pre, table { margin: 0 0 0.7em; }
pre { white-space: pre-wrap; font-family: ui-monospace, 'Roboto Mono', Menlo, Consolas, monospace; font-size: 9.5pt; background: #f4f4f4; padding: 6pt 8pt; }
code { font-family: ui-monospace, 'Roboto Mono', Menlo, Consolas, monospace; font-size: 0.92em; background: #f4f4f4; padding: 0 2pt; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3pt solid #ccc; padding-left: 9pt; color: #333; }
hr { border: 0; border-top: 1px solid #999; margin: 1em 0; }
table { border-collapse: collapse; }
th, td { border: 1px solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { background: #eee; }
`;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( *)([-*+])[ \t]+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const TABLE_RULE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

function blocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) code.push(lines[i++] ?? "");
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const atx = line.match(ATX);
    if (atx) {
      const level = String((atx[1] ?? "#").length);
      out.push(`<h${level}>${inline(atx[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) inner.push((lines[i++] ?? "").match(QUOTE)?.[1] ?? "");
      out.push(`<blockquote>${blocks(inner).join("\n")}</blockquote>`);
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const end = listEnd(lines, i);
      out.push(list(lines.slice(i, end)));
      i = end;
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && next.includes("-") && TABLE_RULE.test(next)) {
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") rows.push(lines[i++] ?? "");
      out.push(table(rows));
      continue;
    }
    // A paragraph (or a setext heading) up to a blank line or another block.
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const more = lines[i] ?? "";
      const setext = more.match(SETEXT);
      if (setext) {
        const level = (setext[1] ?? "=").startsWith("=") ? "1" : "2";
        out.push(`<h${level}>${inline(para.map((l) => l.trim()).join(" "))}</h${level}>`);
        para.length = 0;
        i++;
        break;
      }
      if (more.trim() === "" || FENCE.test(more) || ATX.test(more) || QUOTE.test(more) || BULLET.test(more) || ORDERED.test(more) || RULE.test(more)) break;
      para.push(more);
      i++;
    }
    if (para.length > 0) out.push(`<p>${inline(para.map((l) => l.trim()).join("\n"))}</p>`);
  }
  return out;
}

/**
 * Index after the list that starts at `start`: its items, their continuation and nested
 * lines, blank lines inside. A top-level item of the other kind (bullet ↔ numbered) starts
 * a new list.
 */
function listEnd(lines: readonly string[], start: number): number {
  const ordered = ORDERED.test(lines[start] ?? "");
  const sameKind = (line: string) => (ordered ? ORDERED.test(line) : BULLET.test(line)) && !line.startsWith(" ");
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      const next = lines[i + 1] ?? "";
      if (next.startsWith(" ") || sameKind(next)) {
        i++;
        continue;
      }
      break;
    }
    if (line.startsWith(" ") || sameKind(line)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

type Item = { indent: number; ordered: boolean; start: number; text: string[] };

function list(lines: readonly string[]): string {
  const items: Item[] = [];
  for (const line of lines) {
    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet) items.push({ indent: (bullet[1] ?? "").length, ordered: false, start: 1, text: [bullet[3] ?? ""] });
    else if (ordered) items.push({ indent: (ordered[1] ?? "").length, ordered: true, start: Number(ordered[2]), text: [ordered[3] ?? ""] });
    else if (line.trim() !== "") items.at(-1)?.text.push(line.trim());
  }
  return nest(items, 0, items.length);
}

/** Items [from, to) as one list at the first item's indent, deeper items nested under their parent. */
function nest(items: readonly Item[], from: number, to: number): string {
  const first = items[from];
  if (!first) return "";
  const tag = first.ordered ? "ol" : "ul";
  const start = first.ordered && first.start !== 1 ? ` start="${String(first.start)}"` : "";
  const parts: string[] = [];
  let i = from;
  while (i < to) {
    const item = items[i];
    if (!item) break;
    let j = i + 1;
    while (j < to && (items[j]?.indent ?? 0) > item.indent) j++;
    const children = j > i + 1 ? nest(items, i + 1, j) : "";
    parts.push(`<li>${inline(item.text.join("\n"))}${children}</li>`);
    i = j;
  }
  return `<${tag}${start}>${parts.join("")}</${tag}>`;
}

function cells(row: string): string[] {
  let body = row.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function table(rows: readonly string[]): string {
  const [head = "", ...body] = rows;
  const th = cells(head)
    .map((c) => `<th>${inline(c)}</th>`)
    .join("");
  const tr = body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Inline markup: code spans first (their content is literal), then images, links, emphasis. */
function inline(text: string): string {
  const parts = text.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    html += spans(parts[i] ?? "");
    const code = parts[i + 2];
    if (code !== undefined) html += `<code>${escapeHtml(/^ .* $/s.test(code) ? code.slice(1, -1) : code)}</code>`;
  }
  return html.replace(/ {2,}\n|\\\n/g, "<br>").replace(/\n/g, " ");
}

function spans(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  html = html.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  html = html.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  html = html.replace(/(^|[^*\w])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_\w])_(?=\S)([\s\S]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  html = html.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return html.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1");
}
