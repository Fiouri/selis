import { createPdfEngine, DEFAULT_RENDER_LIMITS, type PdfEngine, type RenderLimits, renderLimitsFor } from "@selis/engine";
import { api } from "./api";

let engine: PdfEngine | null = null;
let limits: RenderLimits = DEFAULT_RENDER_LIMITS;

/** One PDF engine worker for the whole app, started on first use (not at launch). */
export function getEngine(): PdfEngine {
  engine ??= createPdfEngine(limits);
  return engine;
}

/** Limits for the current device (conservative until `installRenderLimits` resolves). */
export function currentRenderLimits(): RenderLimits {
  return limits;
}

export function setRenderLimits(next: RenderLimits): void {
  limits = next;
  engine?.setLimits(next);
}

/** Queries device RAM (local IPC, no network) and picks the render tier. */
export async function installRenderLimits(): Promise<void> {
  try {
    const memory = await api.deviceMemory();
    const next = renderLimitsFor(memory.totalBytes);
    setRenderLimits(next);
    console.info(
      `[selis:perf] ram=${(memory.totalBytes / 1e9).toFixed(1)}GB (${memory.source}) maxRenderScale=${next.maxRenderScale} cache=${next.cacheMaxPages}p/${Math.round(next.cacheMaxBytes / 1048576)}MB`,
    );
  } catch (err) {
    console.warn("selis: device memory unavailable, keeping conservative render limits", err);
  }
}
