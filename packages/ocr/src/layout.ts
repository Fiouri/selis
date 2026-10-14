/**
 * From Tesseract's word boxes on a rendered page to the words of an invisible text layer, in
 * the page's view coordinates (points, top-left origin, as the editor uses): where each word's
 * baseline starts, how wide it is and what font size fits it. Pure functions.
 */

export type Box = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

export type OcrWord = { readonly text: string; readonly confidence: number; readonly bbox: Box };
export type OcrLine = { readonly words: readonly OcrWord[]; readonly bbox: Box; readonly baseline: Box };
/** One recognised page, in the pixels of the image that was read. */
export type OcrPage = { readonly width: number; readonly height: number; readonly lines: readonly OcrLine[] };

/** A word of the text layer, in page view points. */
export type LayerWord = {
  readonly text: string;
  /** Left end of the baseline. */
  readonly x: number;
  readonly y: number;
  /** The width the word must span (it is scaled horizontally to it). */
  readonly width: number;
  readonly fontSize: number;
};

/**
 * Words Tesseract is less sure of than this (0–100) are left out. Low: a searchable layer
 * gains more from a right word read with doubt (tessdata_fast is often unsure of Greek it
 * reads correctly) than it loses to noise, which scores near 0.
 */
export const MIN_CONFIDENCE = 10;
/** Font size as a share of the line box (accents above, descenders below the em). */
const EM_PER_LINE_BOX = 0.82;

function baselineAt(baseline: Box, x: number): number {
  const dx = baseline.x1 - baseline.x0;
  if (Math.abs(dx) < 1e-6) return baseline.y0;
  return baseline.y0 + ((x - baseline.x0) * (baseline.y1 - baseline.y0)) / dx;
}

/**
 * Tesseract's text as it should be searched: NFKC (its Greek output uses the micro sign µ for
 * μ, and ligatures such as ﬁ), trimmed.
 */
export function cleanText(text: string): string {
  return text.normalize("NFKC").trim();
}

/**
 * The text-layer words of `page` for a page of `pageWidth × pageHeight` points: each word over
 * its own box. Readers put the spaces back from the gaps between the boxes (the embedded font
 * has no space glyph to write them with).
 */
export function layoutWords(page: OcrPage, pageWidth: number, pageHeight: number): LayerWord[] {
  const sx = pageWidth / Math.max(1, page.width);
  const sy = pageHeight / Math.max(1, page.height);
  const out: LayerWord[] = [];
  for (const line of page.lines) {
    const lineHeight = line.bbox.y1 - line.bbox.y0;
    if (lineHeight <= 0) continue;
    const fontSize = lineHeight * EM_PER_LINE_BOX * sy;
    const words = line.words
      .map((w) => ({ ...w, text: cleanText(w.text) }))
      .filter((w) => w.text !== "" && w.bbox.x1 > w.bbox.x0 && w.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    for (const word of words) {
      // The line's baseline under this word (fitted across the line: words with and without
      // descenders sit on the same line).
      const base = Math.min(line.bbox.y1, Math.max(line.bbox.y0, baselineAt(line.baseline, word.bbox.x0)));
      out.push({ text: word.text, x: word.bbox.x0 * sx, y: base * sy, width: (word.bbox.x1 - word.bbox.x0) * sx, fontSize });
    }
  }
  return out;
}

/** Normalises text for comparing words: NFC, no surrounding punctuation, case kept. */
export function wordKey(word: string): string {
  return word.normalize("NFC").replace(/^[«"'([]+|[»"'.,:;!?)\]]+$/gu, "");
}
