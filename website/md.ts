/**
 * The Markdown subset docs/PRIVACY*.md use, to HTML: headings, paragraphs (hard-wrapped lines
 * joined), "- " lists with continuation lines, pipe tables, **bold**, `code`, [text](url) and
 * <url> links. Everything else is escaped text. No dependency, no raw HTML pass-through.
 */

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Inline formatting of one line of source text (escaped on the way). */
export function inline(text: string, rewriteLink: (href: string) => string = (h) => h): string {
  const out: string[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out.push(escapeHtml(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(`<code>${escapeHtml(m[1])}</code>`);
    else if (m[2] !== undefined) out.push(`<strong>${inline(m[2], rewriteLink)}</strong>`);
    else if (m[3] !== undefined && m[4] !== undefined) out.push(`<a href="${escapeHtml(rewriteLink(m[4]))}">${inline(m[3], rewriteLink)}</a>`);
    else if (m[5] !== undefined) out.push(`<a href="${escapeHtml(m[5])}">${escapeHtml(m[5])}</a>`);
    last = m.index + m[0].length;
  }
  out.push(escapeHtml(text.slice(last)));
  return out.join("");
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export type Heading = { level: number; text: string; id: string };

export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

const HEADING = /^(#{1,4}) (.+)$/;
const BLOCK_START = /^(#{1,4} |- |\|)/;

/** Converts the document; the first `# ` heading is returned as the title, not rendered. */
export function markdownToHtml(source: string, rewriteLink?: (href: string) => string): { title: string; html: string; headings: Heading[] } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const at = (n: number): string => lines[n] ?? "";
  const html: string[] = [];
  const headings: Heading[] = [];
  let title = "";
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      if (level === 1 && !title) title = text;
      else {
        const id = slug(text);
        headings.push({ level, text, id });
        html.push(`<h${String(level)} id="${id}">${inline(text, rewriteLink)}</h${String(level)}>`);
      }
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && at(i).startsWith("|")) rows.push(at(i++));
      const [head, , ...body] = rows;
      const th = cells(head ?? "")
        .map((c) => `<th scope="col">${inline(c, rewriteLink)}</th>`)
        .join("");
      const tr = body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c, rewriteLink)}</td>`).join("")}</tr>`).join("");
      html.push(`<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && at(i).trim() !== "" && !HEADING.test(at(i))) {
        const current = at(i);
        if (current.startsWith("- ")) items.push(current.slice(2).trim());
        else items[items.length - 1] = `${items.at(-1) ?? ""} ${current.trim()}`;
        i++;
      }
      html.push(`<ul>${items.map((it) => `<li>${inline(it, rewriteLink)}</li>`).join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && at(i).trim() !== "" && !BLOCK_START.test(at(i))) para.push(at(i++).trim());
    html.push(`<p>${inline(para.join(" "), rewriteLink)}</p>`);
  }
  return { title, html: html.join("\n"), headings };
}
