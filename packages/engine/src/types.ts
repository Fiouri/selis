/** Page size in PDF points (1/72 in), after the page's own /Rotate is applied. */
export type PageSize = { readonly width: number; readonly height: number };

export type EngineErrorCode = "password" | "format" | "closed" | "cancelled" | "init" | "unknown";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export type OpenOptions = {
  password?: string;
};

export type RenderOptions = {
  /** Aborting drops a queued render; the promise rejects with code "cancelled". */
  signal?: AbortSignal;
};

/** An open document inside the engine worker. */
export interface DocHandle {
  readonly id: string;
  readonly pageCount: number;
  readonly pages: readonly PageSize[];
  /** /Title from the document info dictionary, if any. */
  readonly title: string | null;
  /**
   * Renders one page. `scale` is device pixels per PDF point. The bitmap may be
   * smaller than requested when it would exceed the engine's pixel budget.
   * The caller owns the bitmap and must `close()` it (or transfer it) when done.
   */
  renderPage(index: number, scale: number, options?: RenderOptions): Promise<ImageBitmap>;
  close(): Promise<void>;
}

export interface PdfEngine {
  open(bytes: ArrayBuffer, options?: OpenOptions): Promise<DocHandle>;
  /** Terminates the worker and frees all WASM memory. */
  destroy(): void;
}
