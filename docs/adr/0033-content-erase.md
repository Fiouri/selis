# ADR 0033 — Content erase: area erase and delete object

- Status: accepted
- Date: 2026-10-20

## Context

P7b asks for an "Erase" tool in the editing dock, separate from the annotation eraser: remove
page content itself (a stain, a stamp, an old logo, a line of text) under a brush or rectangle,
or delete one page object (an image, a text run, a path). What is erased must leave the file
(through the redaction path of ADR 0009), the area is painted white, with the background colour
around it or with a picked colour, and no black box or annotation is left. Every apply is a new
version labelled "Erase"; the original is kept.

Measured on the EmbedPDF 2.15.1 PDFium build before deciding (`erase.node.test.ts` keeps these
as tests):

- `EPDFText_RedactInQuads` (EmbedPDF `redactTextInRects`, `recurseForms`) removes the glyphs
  under the quads, inside form XObjects too, and blanks the **image pixels** under them in the
  image data (raw and JPEG). It draws nothing (no overlay, unlike `EPDFPage_ApplyRedactions`,
  which always paints the /Redact annotation's appearance, red border included).
- It leaves **vector paths whole**: a filled rect or a stroke through the area is only hidden
  by whatever is painted over it.
- It changes **shared objects in place**: an image drawn on two pages lost its pixels on both.
  (ADR 0009's redaction has the same exposure; see Consequences.)
- On a `/Rotate` page EmbedPDF's text rects are not turned (width and height stay in the
  unrotated orientation); the viewer's own coordinates and EmbedPDF's point conversion are right.

## Decision

**Area erase** (`packages/engine/src/erase.ts`, worker; one apply = one page, any number of
rects) runs on scratch copies:

1. **Un-share.** In the page content (and recursively in the forms it draws) every image or
   form XObject whose drawn bounds meet the area gets its own copy under a new name
   (`/SelisE<n>`, the `Do` operand rewritten, the page and the copied forms given resource
   dictionaries of their own). PDFium then changes only the copies; other pages and other
   draws keep the originals.
2. **PDFium** `redactTextInRects` with the viewer rects: glyphs and image pixels.
3. **Paths** (`content-stream.ts` + `path-clip.ts`): the content stream is read operator by
   operator with the CTM and line width (`q Q cm w gs`), and every painted path that meets the
   area is cut geometrically and written back in place; all other bytes stay as they were.
   - Fills keep their parts in the complement of the area: the complement is cut into disjoint
     rectangular cells and each closed subpath is clipped to each cell (Sutherland–Hodgman,
     cubic curves split exactly at the cell edges by de Casteljau). Clipping to a convex cell
     keeps every point's winding number, so non-zero and even-odd stay right; all pieces go
     into one path, so the shared cell edges cancel (no seams).
   - Strokes are split where they cross the area's edge and the pieces inside go. The area is
     first shrunk by half the line width (in page space), so the outside renders as before;
     the cut ends lie inside the area under the fill. A cut closed outline becomes one open
     run that starts after the cut, so its other corners stay joins.
   - `B`/`b` paths become a fill and a stroke; a path that also sets a clip (`W n`) keeps
     clipping with its whole outline (a clip draws nothing).
4. **Fill** last, in default user space over the area (`q r g b rg … re f Q`), the page's
   content wrapped in `q … Q`.
5. **Full rewrite** (`pdf-objects.ts`, as ADR 0009): one fresh file with only the objects
   still reachable, so the old content stream and the original image data (when no other page
   draws it) do not survive. An owner-password handler is dropped, as for redaction.

Fill colours: white (default), **Match background** = per-channel median of a 4 pt ring around
the area, rendered from page content only (`sampleColor`), and **Pick** = an eyedropper (the
median of a 1.5 pt spot where the user taps). The colour is computed before applying, so the
preview shows it.

**Delete object**: the page's top-level PDFium objects (text run, path, image, shading, form
XObject) with their bounds in viewer coordinates (`pageObjects`). Tapping outlines the topmost
object under the finger; a long press cycles through the overlapping ones. Delete removes that
one object on a scratch copy (`FPDFPage_RemoveObject` + `FPDFPage_GenerateContent`), refuses
when the page no longer has that object (kind and bounds within 0.5 pt), then rewrites the file.

**UI and versions.** Erase is a tool in the annotate dock. Brush (3 sizes; a stroke is a chain
of squares, drawn exactly as they will be erased) and rectangle strokes are a preview only,
undoable one by one until "Apply"; nothing goes into the document before that (no annotation).
Apply first commits pending annotation edits as their own version, then erases and commits a
version labelled `erase` (schema 8: `versions.label` accepts it). The apply and a delete are
undoable while the document is open (the bytes from before are reloaded, like redaction); the
original and every earlier version stay in the history. A document with any `/Sig` field warns
once per open document that erasing invalidates the signature.

## Consequences

- Verified with an independent reader (`erase.node.test.ts`, pdf.js oracle + raw/inflated
  bytes): the erased words are gone for PDFium and pdf.js and from the bytes (positive control
  first); the image samples under the area are white in the stream itself and unchanged
  outside it; no point of any painted path lies inside the area (strokes: beyond half their
  width); a page sharing the image and form with the erased one renders pixel-identically;
  a rotated, cropped page maps the area as the viewer draws it; delete removes exactly one
  object (count − 1, the others unchanged, the page unchanged outside its bounds); `qpdf --check`.
- **Outside the area** (2 px margin at 2 px/pt) straight edges, fills, text and images render
  pixel-identically. A curve cut at the edge is split exactly, but the rasteriser flattens the
  two halves slightly differently from the whole: anti-aliased pixels along it may move
  (measured ≤ 65/255 on ≤ 0.02 % of the page's pixels; the test allows 80 and 0.02 %).
- PDFium removes **whole glyphs** that meet the area (ADR 0009): a glyph crossing the edge goes
  entirely, also outside it.
- Not cut: **shadings** (`sh`) and **pattern cells** under the area are covered by the fill,
  not removed; a **soft mask** of an erased image keeps its shape. A **dashed** stroke cut by the
  area restarts its dash pattern after the cut. **Annotations** (notes, highlights, form fields)
  are not page content and stay; the annotation eraser removes them.
- A content stream in an encoding other than Flate or none cannot be rewritten: the erase is
  refused with an error (PDFium-generated content is always Flate).
- ADR 0009's redaction has the shared-object exposure measured above (a redacted area over an
  image or form drawn on several pages changes it on all of them); the un-share step here is
  the fix to reuse there (follow-up).
