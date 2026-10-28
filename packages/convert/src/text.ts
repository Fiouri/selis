import { escapeHtml } from "./html";

/** Plain text as pre-wrapped lines in a monospace-free body font, tabs kept. */
export function textToHtml(text: string): string {
  const body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return `<div class="plain-text">${escapeHtml(body)}</div>`;
}

export const TEXT_CSS = ".plain-text { white-space: pre-wrap; tab-size: 4; }";
