/**
 * Reading structure from a PDF page's text objects (ADR 0035, "Export as Word"):
 * runs → lines (overlapping vertical extents) → columns (a vertical gap through the
 * text) → paragraphs (line gaps, indents, size changes) → headings by font size against
 * the document's body size. Images sit in the flow at their position. Coordinates are
 * page points, top-left origin, as the engine reports them.
 */

export type StyledRun = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
};

export type PageContent = {
  readonly width: number;
  readonly height: number;
  readonly runs: readonly StyledRun[];
  /** Image placements on the page (their pixels are fetched separately). */
  readonly images: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>;
};

export type Span = { readonly text: string; readonly bold: boolean; readonly italic: boolean };

export type Block =
  | { readonly kind: "paragraph"; readonly spans: readonly Span[]; readonly heading: 0 | 1 | 2; readonly fontSize: number; readonly indent: number }
  | { readonly kind: "image"; readonly index: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export type StructuredPage = { readonly width: number; readonly height: number; readonly blocks: readonly Block[]; readonly left: number; readonly right: number };

type Line = { x: number; y: number; right: number; bottom: number; runs: StyledRun[]; fontSize: number };

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The font size most characters of the document are set in (the body size). */
export function bodyFontSize(pages: readonly PageContent[]): number {
  const weight = new Map<number, number>();
  for (const page of pages) {
    for (const run of page.runs) {
      const size = Math.round(run.fontSize * 2) / 2;
      weight.set(size, (weight.get(size) ?? 0) + run.text.trim().length);
    }
  }
  let best = 0;
  let most = -1;
  for (const [size, count] of weight) {
    if (count > most || (count === most && size < best)) {
      best = size;
      most = count;
    }
  }
  return best || 11;
}

/** Heading level for a font size against the body size: ≥ 1.6× → 1, ≥ 1.25× → 2. */
export function headingLevel(fontSize: number, body: number): 0 | 1 | 2 {
  if (body <= 0) return 0;
  if (fontSize >= body * 1.6) return 1;
  if (fontSize >= body * 1.25) return 2;
  return 0;
}

/** Runs grouped into lines (vertical overlap with the line's middle), each sorted left to right. */
export function toLines(runs: readonly StyledRun[]): Line[] {
  const sorted = runs.filter((r) => r.text.trim() !== "" && r.height > 0).sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
  const lines: Line[] = [];
  for (const run of sorted) {
    const mid = run.y + run.height / 2;
    const line = lines.find((l) => {
      const lineMid = (l.y + l.bottom) / 2;
      return Math.abs(lineMid - mid) < Math.min(l.bottom - l.y, run.height) * 0.5 && !overlapsHorizontally(l, run);
    });
    if (line) {
      line.runs.push(run);
      line.x = Math.min(line.x, run.x);
      line.right = Math.max(line.right, run.x + run.width);
      line.y = Math.min(line.y, run.y);
      line.bottom = Math.max(line.bottom, run.y + run.height);
      line.fontSize = Math.max(line.fontSize, run.fontSize);
    } else {
      lines.push({ x: run.x, y: run.y, right: run.x + run.width, bottom: run.y + run.height, runs: [run], fontSize: run.fontSize });
    }
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Another run already covers this span of the line (a second column at the same height). */
function overlapsHorizontally(line: Line, run: StyledRun): boolean {
  return line.runs.some((r) => run.x < r.x + r.width - 0.5 && r.x < run.x + run.width - 0.5);
}

/**
 * Column bands of a page: x ranges separated by a vertical gap (≥ 4 % of the page width,
 * in the middle 70 %) that no text crosses. One band for single-column pages.
 */
export function columns(runs: readonly StyledRun[], pageWidth: number): Array<[number, number]> {
  const text = runs.filter((r) => r.text.trim() !== "");
  if (text.length === 0 || pageWidth <= 0) return [[0, pageWidth]];
  const step = pageWidth / 400;
  const covered = new Uint8Array(400);
  for (const r of text) {
    const from = Math.max(0, Math.floor(r.x / step));
    const to = Math.min(399, Math.ceil((r.x + r.width) / step));
    for (let i = from; i <= to; i++) covered[i] = 1;
  }
  const minGap = Math.ceil(0.04 * 400);
  const bands: Array<[number, number]> = [];
  let start = 0;
  let gap = 0;
  for (let i = 0; i < 400; i++) {
    if (covered[i]) {
      if (gap >= minGap && i - gap > 0.15 * 400 && i < 0.85 * 400 && bands.length < 3) {
        bands.push([start * step, (i - gap) * step]);
        start = i;
      }
      gap = 0;
    } else gap++;
  }
  bands.push([start * step, pageWidth]);
  // A gap only counts if text sits on both sides of it over a good part of the page.
  if (bands.length > 1) {
    const counts = bands.map(([a, b]) => text.filter((r) => r.x + r.width / 2 >= a && r.x + r.width / 2 < b).length);
    if (counts.some((c) => c < text.length * 0.1)) return [[0, pageWidth]];
  }
  return bands;
}

function spansOf(line: Line): Span[] {
  const spans: Span[] = [];
  let previous: StyledRun | null = null;
  for (const run of line.runs) {
    let text = run.text.replace(/[\r\n]+/g, " ");
    if (previous) {
      const gap = run.x - (previous.x + previous.width);
      if (gap > Math.min(run.fontSize, previous.fontSize) * 0.15 && !/\s$/.test(previous.text) && !/^\s/.test(text)) text = ` ${text}`;
    }
    const last = spans.at(-1);
    if (last && last.bold === run.bold && last.italic === run.italic) spans[spans.length - 1] = { ...last, text: last.text + text };
    else spans.push({ text, bold: run.bold, italic: run.italic });
    previous = run;
  }
  return spans;
}

function joinSpans(into: Span[], next: readonly Span[]): void {
  const last = into.at(-1);
  const first = next[0];
  if (last && first) {
    const spaced = /\s$/.test(last.text) || /^\s/.test(first.text) ? first.text : ` ${first.text}`;
    const head = { ...first, text: spaced };
    if (last.bold === head.bold && last.italic === head.italic) into[into.length - 1] = { ...last, text: last.text + head.text };
    else into.push(head);
    into.push(...next.slice(1));
    return;
  }
  into.push(...next);
}

/** One page's blocks in reading order: columns left to right, top to bottom in each. */
export function structurePage(page: PageContent, body: number): StructuredPage {
  const bands = columns(page.runs, page.width);
  const blocks: Block[] = [];
  const allLines = toLines(page.runs);
  const left = allLines.length > 0 ? Math.min(...allLines.map((l) => l.x)) : 72;
  const right = allLines.length > 0 ? Math.max(...allLines.map((l) => l.right)) : page.width - 72;
  bands.forEach(([from, to], band) => {
    const inBand = (x: number, width: number) => x + width / 2 >= from && (x + width / 2 < to || band === bands.length - 1);
    const lines = toLines(page.runs.filter((r) => inBand(r.x, r.width)));
    const images = page.images
      .map((img, index) => ({ ...img, index }))
      .filter((img) => inBand(img.x, img.width))
      .sort((a, b) => a.y - b.y);
    const spacing = median(lines.slice(1).map((l, i) => l.y - (lines[i]?.y ?? 0)).filter((d) => d > 0));
    const bandLeft = lines.length > 0 ? Math.min(...lines.map((l) => l.x)) : from;
    let current: { spans: Span[]; fontSize: number; heading: 0 | 1 | 2; indent: number; last: Line } | null = null;
    const flush = () => {
      if (current) blocks.push({ kind: "paragraph", spans: current.spans, heading: current.heading, fontSize: current.fontSize, indent: current.indent });
      current = null;
    };
    let nextImage = 0;
    for (const line of lines) {
      while (nextImage < images.length && (images[nextImage]?.y ?? 0) < line.y) {
        flush();
        const img = images[nextImage++];
        if (img) blocks.push({ kind: "image", index: img.index, x: img.x, y: img.y, width: img.width, height: img.height });
      }
      const size = median(line.runs.map((r) => r.fontSize));
      const heading = headingLevel(size, body);
      const indent = Math.max(0, line.x - bandLeft);
      if (current) {
        const prev: Line = current.last;
        const gap = line.y - prev.bottom;
        const step = line.y - prev.y;
        const sizeChange = Math.abs(size - current.fontSize) > Math.max(0.6, current.fontSize * 0.12);
        const looseGap = spacing > 0 ? step > spacing * 1.35 : gap > (prev.bottom - prev.y) * 0.6;
        const newIndent = indent - current.indent > size * 1.2 && heading === 0;
        if (sizeChange || looseGap || newIndent || heading !== current.heading) flush();
      }
      if (current) {
        joinSpans(current.spans, spansOf(line));
        current.last = line;
      } else {
        current = { spans: spansOf(line), fontSize: size, heading, indent, last: line };
      }
    }
    flush();
    for (; nextImage < images.length; nextImage++) {
      const img = images[nextImage];
      if (img) blocks.push({ kind: "image", index: img.index, x: img.x, y: img.y, width: img.width, height: img.height });
    }
  });
  return { width: page.width, height: page.height, blocks, left, right };
}

export function structureDocument(pages: readonly PageContent[]): StructuredPage[] {
  const body = bodyFontSize(pages);
  return pages.map((page) => structurePage(page, body));
}

/** Paragraph text without styling. */
export function blockText(block: Block): string {
  return block.kind === "paragraph" ? block.spans.map((s) => s.text).join("").replace(/\s+/g, " ").trim() : "";
}
