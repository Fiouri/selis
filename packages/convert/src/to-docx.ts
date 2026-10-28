import { Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, TextRun } from "docx";
import type { StructuredPage } from "./structure";

/** An image placed on a page, as PNG or JPEG bytes. */
export type PlacedImage = { readonly type: "png" | "jpg"; readonly data: Uint8Array };

const TWIPS_PER_POINT = 20;
/** Word sizes images in pixels at 96 dpi. */
const PX_PER_POINT = 96 / 72;

/**
 * Editable Word document from structured pages (ADR 0035): one paragraph per text
 * block (headings as Heading 1/2, bold and italic runs kept, body sizes kept), images
 * in place at their size, and a page break where each PDF page ended. The page size
 * and side margins are the first page's.
 */
export async function toDocx(pages: readonly StructuredPage[], images: ReadonlyMap<string, PlacedImage>, title: string): Promise<Uint8Array> {
  const first = pages[0];
  const width = first?.width ?? 595.28;
  const height = first?.height ?? 841.89;
  const side = (value: number) => Math.round(Math.min(90, Math.max(18, value)) * TWIPS_PER_POINT);
  const margin = {
    top: side(54),
    bottom: side(54),
    left: side(first ? first.left : 72),
    right: side(first ? first.width - first.right : 72),
  };
  const children: Paragraph[] = [];
  pages.forEach((page, pageIndex) => {
    const before = children.length;
    page.blocks.forEach((block) => {
      if (block.kind === "image") {
        const image = images.get(`${String(pageIndex)}:${String(block.index)}`);
        if (!image) return;
        const maxWidth = (width - (margin.left + margin.right) / TWIPS_PER_POINT) * PX_PER_POINT;
        const scale = Math.min(1, maxWidth / Math.max(1, block.width * PX_PER_POINT));
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: image.type,
                data: image.data,
                transformation: { width: Math.round(block.width * PX_PER_POINT * scale), height: Math.round(block.height * PX_PER_POINT * scale) },
              }),
            ],
          }),
        );
        return;
      }
      const runs = block.spans.map((span, i) => {
        const text = i === 0 ? span.text.trimStart() : i === block.spans.length - 1 ? span.text.trimEnd() : span.text;
        return new TextRun({
          text,
          ...(span.bold ? { bold: true } : {}),
          ...(span.italic ? { italics: true } : {}),
          // Headings take their size from the Heading style.
          ...(block.heading === 0 ? { size: Math.max(2, Math.round(block.fontSize * 2)) } : {}),
        });
      });
      children.push(
        new Paragraph({
          children: runs,
          ...(block.heading === 1 ? { heading: HeadingLevel.HEADING_1 } : block.heading === 2 ? { heading: HeadingLevel.HEADING_2 } : {}),
          ...(block.indent > 0 ? { indent: { firstLine: Math.round(Math.min(block.indent, 72) * TWIPS_PER_POINT) } } : {}),
          spacing: { after: Math.round(block.fontSize * 0.6 * TWIPS_PER_POINT) },
        }),
      );
    });
    // A page break where the PDF page ended (none after the last page).
    if (pageIndex < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (children.length === before && pageIndex === pages.length - 1) children.push(new Paragraph({ children: [] }));
  });
  const doc = new Document({
    title,
    creator: "Selis",
    sections: [
      {
        properties: {
          page: {
            size: { width: Math.round(width * TWIPS_PER_POINT), height: Math.round(height * TWIPS_PER_POINT) },
            margin,
          },
        },
        children,
      },
    ],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
