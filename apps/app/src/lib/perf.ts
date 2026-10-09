/**
 * Local-only performance marks for the P0 spike (first page time). Printed to
 * the console, which Tauri forwards to logcat on Android. Never sent anywhere.
 */
let viewerStart: number | null = null;
let reported = false;

export function markViewerStart(): void {
  viewerStart = performance.now();
  reported = false;
}

export function markStep(step: string, sinceStartMs = viewerStart === null ? 0 : performance.now() - viewerStart): void {
  console.info(`[selis:perf] ${step}=${Math.round(sinceStartMs)}ms`);
}

/** Called after a page bitmap is on screen; only the first one per viewer counts. */
export function reportFirstPage(pageIndex: number): void {
  if (reported || viewerStart === null) return;
  reported = true;
  const ms = performance.now() - viewerStart;
  (window as unknown as { __selisFirstPageMs?: number }).__selisFirstPageMs = ms;
  console.info(`[selis:perf] first-page=${Math.round(ms)}ms page=${pageIndex + 1}`);
}
