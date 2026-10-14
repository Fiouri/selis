/**
 * Local-only measurements of the live scan (P4c AC: detection ≥ 10 fps on the S23, no UI
 * thread stall over 200 ms): detections per second, detection time in the worker, and the
 * longest gap between animation frames while the camera runs. Printed to the console (logcat
 * on Android, `[selis:perf] scan …`) and kept on `window.__selisScan` for the device checks.
 * Never sent anywhere.
 */

export type ScanStatsSnapshot = {
  /** Detections finished per second over the session. */
  fps: number;
  detectMsP50: number;
  detectMsP95: number;
  /** Share of detections that found a page. */
  foundShare: number;
  /** Longest gap between two animation frames, ms. */
  maxFrameGapMs: number;
  /** Animation frame gaps over 200 ms. */
  stalls: number;
  seconds: number;
};

type Recorder = { start: () => void; detected: (ms: number, found: boolean) => void; stop: () => void };

const STALL_MS = 200;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

export function scanStats(): Recorder {
  let startedAt = 0;
  let frame = 0;
  let lastFrame = 0;
  let maxGap = 0;
  let stalls = 0;
  let found = 0;
  const times: number[] = [];
  const tick = (now: number) => {
    if (lastFrame > 0) {
      const gap = now - lastFrame;
      maxGap = Math.max(maxGap, gap);
      if (gap > STALL_MS) stalls += 1;
    }
    lastFrame = now;
    frame = requestAnimationFrame(tick);
  };
  return {
    start: () => {
      startedAt = performance.now();
      frame = requestAnimationFrame(tick);
    },
    detected: (ms, hit) => {
      times.push(ms);
      if (hit) found += 1;
    },
    stop: () => {
      cancelAnimationFrame(frame);
      const seconds = (performance.now() - startedAt) / 1000;
      // Sessions shorter than a second say nothing (the camera was barely up).
      if (seconds < 1 || times.length === 0) return;
      const sorted = [...times].sort((a, b) => a - b);
      const snapshot: ScanStatsSnapshot = {
        fps: Math.round((times.length / seconds) * 10) / 10,
        detectMsP50: Math.round(percentile(sorted, 0.5) * 10) / 10,
        detectMsP95: Math.round(percentile(sorted, 0.95) * 10) / 10,
        foundShare: Math.round((found / times.length) * 100) / 100,
        maxFrameGapMs: Math.round(maxGap),
        stalls,
        seconds: Math.round(seconds * 10) / 10,
      };
      const w = window as unknown as { __selisScan?: ScanStatsSnapshot[] };
      (w.__selisScan ??= []).push(snapshot);
      console.info(
        `[selis:perf] scan fps=${String(snapshot.fps)} detect=${String(snapshot.detectMsP50)}/${String(snapshot.detectMsP95)}ms found=${String(snapshot.foundShare)} maxFrameGap=${String(snapshot.maxFrameGapMs)}ms stalls=${String(snapshot.stalls)} seconds=${String(snapshot.seconds)}`,
      );
    },
  };
}
