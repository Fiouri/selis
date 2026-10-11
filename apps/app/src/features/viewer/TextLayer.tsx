import { type DocHandle, EngineError, type TextRun } from "@selis/engine";
import { memo, useEffect, useState } from "react";

let measureContext: CanvasRenderingContext2D | null = null;

/** Width of `text` in a generic sans font at `fontSize` px (to stretch spans onto the glyphs). */
function measure(text: string, fontSize: number): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return 0;
  measureContext.font = `${fontSize}px sans-serif`;
  return measureContext.measureText(text).width;
}

/**
 * Invisible, selectable text over a rendered page (like a scanned-book OCR
 * layer): native selection handles and the system "Copy" menu work on it.
 * Each run is stretched horizontally to cover its glyphs on the bitmap.
 */
export const TextLayer = memo(function TextLayer({ doc, index, scale }: { doc: DocHandle; index: number; scale: number }) {
  const [runs, setRuns] = useState<readonly TextRun[]>([]);

  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        const result = await doc.textRuns(index);
        if (life.alive) setRuns(result);
      } catch (err) {
        if (!(err instanceof EngineError && err.code === "closed")) console.warn(`selis: no text layer for page ${index + 1}`, err);
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [doc, index]);

  return (
    <div className="selis-text-layer absolute inset-0" data-testid="text-layer">
      {runs.map((run, i) => {
        const height = run.height * scale;
        const width = run.width * scale;
        const fontSize = Math.max(1, height * 0.86);
        const natural = measure(run.text, fontSize);
        return (
          <span
            key={i}
            style={{
              left: run.x * scale,
              top: run.y * scale,
              height,
              fontSize,
              lineHeight: `${height}px`,
              transform: natural > 0 ? `scaleX(${width / natural})` : undefined,
            }}
          >
            {run.text}
          </span>
        );
      })}
    </div>
  );
});
