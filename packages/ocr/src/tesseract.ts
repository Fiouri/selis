/**
 * Tesseract (tesseract.js 7, Apache-2.0) in its own Web Worker (P4d, ADR 0018). Everything is
 * local: the worker script, the LSTM-only WebAssembly core (with or without SIMD) and the
 * tessdata_fast models are app assets (`scripts/copy-ocr-assets.ts`); nothing is fetched from a
 * CDN, nothing is cached in IndexedDB, and the worker starts from its URL (no blob: worker, so
 * the app's CSP stays as it is).
 */
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import type { OcrLine, OcrPage } from "./layout";

export type OcrLanguages = "ell+eng" | "ell" | "eng";

export type OcrPaths = {
  /** tesseract.js's worker script (browser); omitted in Node. */
  readonly workerPath?: string;
  /** The core script to load (a `.js` file next to its `.wasm`); omitted in Node. */
  readonly corePath?: string;
  /** Folder (URL or, in Node, a path) with `<lang>.traineddata.gz`. */
  readonly langPath: string;
};

/** Asset paths under the app's `ocr/` folder (see scripts/copy-ocr-assets.ts). */
export function appOcrPaths(base: string, simd: boolean): OcrPaths {
  const root = base.endsWith("/") ? base : `${base}/`;
  return {
    workerPath: `${root}worker.min.js`,
    // Next to the worker: the core fetches its .wasm relative to the worker's URL.
    corePath: `${root}${simd ? "tesseract-core-simd-lstm.js" : "tesseract-core-lstm.js"}`,
    langPath: `${root}tessdata`,
  };
}

export type Ocr = {
  /** Reads one page image (PNG or JPEG bytes) rendered at `dpi`. */
  recognize: (image: Blob | Uint8Array, dpi: number) => Promise<OcrPage>;
  terminate: () => Promise<void>;
};

type ImageSize = { width: number; height: number };

/** Width and height of a PNG or JPEG (the recognised boxes are in its pixels). */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1] ?? 0;
      const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0), width: ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0) };
      }
      i += 2 + length;
    }
  }
  return null;
}

/** Loading the worker, core and models; a load that broke (a missing asset) never settles. */
const START_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function createOcr(languages: OcrLanguages, paths: OcrPaths): Promise<Ocr> {
  const starting = createWorker(languages.split("+"), OEM.LSTM_ONLY, {
    ...(paths.workerPath ? { workerPath: paths.workerPath } : {}),
    ...(paths.corePath ? { corePath: paths.corePath } : {}),
    langPath: paths.langPath,
    gzip: true,
    cacheMethod: "none",
    workerBlobURL: false,
    legacyCore: false,
    legacyLang: false,
  });
  const worker: Worker = await withTimeout(starting, START_TIMEOUT_MS, "starting the OCR worker");
  // A page of running text; the resolution is set per image (`recognize`).
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1" });
  return {
    recognize: async (image, dpi) => {
      const bytes = image instanceof Uint8Array ? image : new Uint8Array(await image.arrayBuffer());
      const size = imageSize(bytes);
      if (!size) throw new Error("not a PNG or JPEG image");
      // PNGs from the engine carry no resolution: without it Tesseract guesses from the glyphs.
      await worker.setParameters({ user_defined_dpi: String(Math.round(dpi)) });
      // Both builds take bytes as they are. The cast is for the app's (browser) type check,
      // where ImageLike names Node's Buffer; with Node's types it is a no-op.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const { data } = await worker.recognize(bytes as unknown as Parameters<Worker["recognize"]>[0], {}, { blocks: true, text: false });
      const lines: OcrLine[] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            lines.push({
              bbox: line.bbox,
              baseline: line.baseline,
              words: line.words.map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
            });
          }
        }
      }
      return { width: size.width, height: size.height, lines };
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}
