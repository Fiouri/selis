/**
 * One allow-list sanitiser for everything that is printed (ADR 0035): structure and
 * formatting elements only, no scripts, frames, forms, embeds, links to elsewhere or
 * event handlers; `src` only as an inline `data:` image; CSS without `@import`,
 * `url()` other than inline data, `image-set()`, `expression()` or bindings. Works
 * on a DOM (an inert `DOMParser` / `createHTMLDocument` document), so nothing it
 * looks at is fetched or run.
 */

/** Elements kept (with their allowed attributes); anything unknown is unwrapped. */
const ALLOWED = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "body", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
]);

/** Elements removed together with everything inside them. */
const DROPPED = new Set([
  "applet", "audio", "base", "basefont", "button", "canvas", "dialog", "embed", "fieldset", "form", "frame", "frameset", "head",
  "iframe", "input", "link", "map", "math", "meta", "noembed", "noframes", "noscript", "object", "option", "optgroup", "param",
  "picture", "portal", "script", "select", "slot", "source", "style", "svg", "template", "textarea", "title", "track", "video",
]);

const ATTRIBUTES = new Set([
  "align", "alt", "border", "cellpadding", "cellspacing", "class", "colspan", "dir", "height", "lang", "rowspan", "span", "start",
  "style", "title", "type", "valign", "width", "reversed", "color", "face", "size", "datetime", "abbr", "scope", "headers", "open",
]);

/** Inline images the print engines decode themselves. */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
const DATA_FONT = /^data:(font\/[a-z0-9.+-]+|application\/(font-[a-z0-9.+-]+|x-font-[a-z0-9.+-]+|vnd\.ms-fontobject|octet-stream));base64,[a-z0-9+/=\s]+$/i;

/**
 * Backslashes outside strings removed: an escape could spell `url(` or `@import` in a
 * way the checks below do not see. Escapes inside strings (`content: "\2022"`) stay.
 */
function stripEscapes(css: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i] ?? "";
    if (quote) {
      out += c;
      if (c === "\\") out += css[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c !== "\\") out += c;
  }
  return out;
}

/** CSS with every way to load or run something removed. */
export function sanitizeCss(css: string): string {
  return (
    stripEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ""))
      .replace(/@import[^;]*;?/gi, "")
      .replace(/@namespace[^;]*;?/gi, "")
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, a?: string, b?: string, c?: string) => {
        const value = (a ?? b ?? c ?? "").trim();
        return DATA_IMAGE.test(value) || DATA_FONT.test(value) ? `url("${value.replace(/["\\\n]/g, "")}")` : "none";
      })
      .replace(/(-webkit-)?image-set\s*\(/gi, "none-set(")
      .replace(/expression\s*\(/gi, "blocked(")
      .replace(/-moz-binding|behavior\s*:/gi, "x-blocked:")
  );
}

export type Sanitized = {
  /** The body's sanitised markup. */
  readonly html: string;
  /** Sanitised `<style>` contents found in the input, in order. */
  readonly css: string;
};

/** Sanitises `root` in place (an element of an inert document) and returns its markup and styles. */
export function sanitizeTree(root: Element): Sanitized {
  const styles: string[] = [];
  for (const style of Array.from(root.ownerDocument.querySelectorAll("style"))) styles.push(sanitizeCss(style.textContent));
  clean(root);
  return { html: root.innerHTML, css: styles.join("\n") };
}

/** Parses an HTML string inertly and sanitises it (used for `.html` files). */
export function sanitizeHtml(html: string): Sanitized {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return sanitizeTree(doc.body);
}

function clean(element: Element): void {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 8 /* comment */ || child.nodeType === 7 /* processing instruction */) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.localName.toLowerCase();
    if (DROPPED.has(tag) || el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      el.remove();
      continue;
    }
    clean(el);
    if (!ALLOWED.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    cleanAttributes(el, tag);
  }
}

function cleanAttributes(el: Element, tag: string): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (tag === "img" && name === "src" && DATA_IMAGE.test(attr.value.trim())) continue;
    if (name === "style") {
      el.setAttribute("style", sanitizeCss(attr.value));
      continue;
    }
    if (!ATTRIBUTES.has(name)) el.removeAttribute(attr.name);
  }
  // An image without an inline source would be fetched, or show a broken icon.
  if (tag === "img" && !el.hasAttribute("src")) el.replaceWith(el.ownerDocument.createTextNode(el.getAttribute("alt") ?? ""));
}
