/**
 * Viewer sharpness on an Android device or AVD (ADR 0002 amendment): for page 1 of
 * `small-text.pdf` (9 pt body text) at fit-width and at 100 % (1 pt = 4/3 CSS px), the
 * page box's CSS size, devicePixelRatio, the bitmap actually drawn, the tier cap, the
 * time until full resolution after scrolling / zooming stops, SSIM between the screen
 * and a PDFium reference render at the same device-pixel size, scroll FPS, and the
 * memory peak while scrolling the 1000-page fixture.
 *
 *   node scripts/measure-sharpness.ts --serial <s> --label <name> [--apk <debug apk>]
 *        [--profile pixel7|s23] [--skip-memory] [--fps-runs 3]
 *
 * Profiles switch the display with `wm size` / `wm density` (reset at the end):
 * pixel7 = 1080×2400 at 420 dpi (DPR 2.625), s23 = 1080×2340 at 480 dpi (DPR 3).
 * Needs a debuggable build (WebView DevTools). Selis' data on the device is wiped.
 * Results: .tmp/sharp/<label>-<profile>.json and the screenshots next to it.
 * Every external tool runs without a shell, with argument arrays.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { crop, type Rgba, ssim } from "../packages/fixtures/src/ssim.ts";

const PKG = "com.anywecon.selis";
const CDP_PORT = 9343;
const PUSH_DIR = "/sdcard/Download/selis-sharp";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".tmp", "sharp");
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROFILES = {
  pixel7: { size: "1080x2400", density: 420 },
  s23: { size: "1080x2340", density: 480 },
} as const;
type Profile = keyof typeof PROFILES;

type Options = { serial: string; label: string; apk: string | null; profile: Profile; memory: boolean; fpsRuns: number };

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { serial: "", label: "run", apk: null, profile: "pixel7", memory: true, fpsRuns: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--serial") options.serial = argv[++i] ?? "";
    else if (arg === "--label") options.label = argv[++i] ?? "run";
    else if (arg === "--apk") options.apk = resolve(argv[++i] ?? "");
    else if (arg === "--profile") {
      const p = argv[++i];
      if (p !== "pixel7" && p !== "s23") throw new Error(`unknown profile ${String(p)}`);
      options.profile = p;
    } else if (arg === "--skip-memory") options.memory = false;
    else if (arg === "--fps-runs") options.fpsRuns = Math.max(1, Number(argv[++i] ?? "1") || 1);
    else throw new Error(`unknown argument ${String(arg)}`);
  }
  if (!options.serial) throw new Error("--serial is required");
  return options;
}

function log(message: string): void {
  console.error(`[sharp] ${message}`);
}

let serial = "";
/** Every adb call fails after this instead of hanging on a frozen device. */
const ADB_TIMEOUT_MS = 120_000;
function adb(args: readonly string[]): string {
  return execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env, timeout: ADB_TIMEOUT_MS });
}
function adbBytes(args: readonly string[]): Buffer {
  return execFileSync("adb", ["-s", serial, ...args], { maxBuffer: 256 * 1024 * 1024, env, timeout: ADB_TIMEOUT_MS });
}

// ---- DevTools ------------------------------------------------------------------------------

type Cdp = {
  evaluate: <T>(expression: string) => Promise<T | undefined>;
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
};

async function openSocket(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (msg.id === undefined) return;
    pending.get(msg.id)?.(msg.result ?? msg.error);
    pending.delete(msg.id);
  });
  const send = (method: string, params: Record<string, unknown>) => {
    const mid = ++id;
    const reply = new Promise<unknown>((r) => pending.set(mid, r));
    ws.send(JSON.stringify({ id: mid, method, params }));
    return reply;
  };
  const evaluate = async <T>(expression: string): Promise<T | undefined> => {
    const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as
      | { result?: { value?: T }; exceptionDetails?: unknown }
      | undefined;
    if (result?.exceptionDetails) throw new Error(`page error: ${JSON.stringify(result.exceptionDetails)}`);
    return result?.result?.value;
  };
  return { evaluate, send, close: () => ws.close() };
}

async function connect(timeoutMs = 30_000): Promise<Cdp> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = adb(["shell", "pidof", PKG]).trim();
      const socket = new RegExp(`@(webview_devtools_remote_${pid})`).exec(adb(["shell", "cat", "/proc/net/unix"]))?.[1];
      if (pid && socket) {
        adb(["forward", `tcp:${String(CDP_PORT)}`, `localabstract:${socket}`]);
        const targets = (await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl: string;
        }>;
        const page = targets.find((t) => t.type === "page");
        if (page) return await openSocket(page.webSocketDebuggerUrl);
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("WebView DevTools not reachable (debuggable build?)");
    await sleep(500);
  }
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// ---- App driving ---------------------------------------------------------------------------

const IPC_READY = "typeof window.__TAURI_INTERNALS__?.invoke === 'function' || null";
const CARD = '[data-testid="document-collection"] button';

async function importFixture(file: string): Promise<string> {
  const name = file.split(/[\\/]/).at(-1) ?? file;
  adb(["shell", "pm", "clear", PKG]);
  adb(["shell", "rm", "-rf", PUSH_DIR]);
  adb(["shell", "mkdir", "-p", PUSH_DIR]);
  adb(["push", file, `${PUSH_DIR}/${name}`]);
  adb(["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${PUSH_DIR}/${name}`]);
  const id = await waitFor(
    "the media scanner",
    () =>
      Promise.resolve(
        /_id=(\d+), relative_path=Download\/selis-sharp\//.exec(
          adb([
            "shell",
            "content",
            "query",
            "--uri",
            "content://media/external/downloads",
            "--projection",
            "_id:relative_path",
            "--where",
            `"_display_name='${name}'"`,
          ]),
        )?.[1] ?? null,
      ),
    20_000,
  );
  adb([
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `content://media/external/downloads/${id}`,
    "-t",
    "application/pdf",
    "--grant-read-uri-permission",
    "-n",
    `${PKG}/.MainActivity`,
  ]);
  const cdp = await connect();
  try {
    await waitFor("the IPC bridge", () => cdp.evaluate<boolean>(IPC_READY), 30_000);
    return await waitFor(
      "the imported document",
      () =>
        cdp.evaluate<string>(`(async () => {
          const docs = await window.__TAURI_INTERNALS__.invoke("list_documents", {
            query: { search: "", filter: "all", tagId: null, sort: "recent" },
          });
          return docs[0]?.id ?? null;
        })()`),
      90_000,
    );
  } finally {
    cdp.close();
  }
}

/** Cold start, open the only document from the library at page 1; returns a DevTools session. */
async function openDocument(docId: string): Promise<Cdp> {
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(1000);
  adb(["shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`]);
  const cdp = await connect();
  await waitFor("the IPC bridge", () => cdp.evaluate<boolean>(IPC_READY), 30_000);
  await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke("set_last_page", { id: ${JSON.stringify(docId)}, page: 0 })`);
  await waitFor("the library card", () => cdp.evaluate<boolean>(`document.querySelector('${CARD}') ? true : null`), 30_000);
  await sleep(1000);
  const at = await cdp.evaluate<{ x: number; y: number }>(`(() => {
    const r = document.querySelector('${CARD}').getBoundingClientRect();
    return { x: Math.round((r.left + r.width / 2) * devicePixelRatio), y: Math.round((r.top + r.height / 3) * devicePixelRatio) };
  })()`);
  if (!at) throw new Error("library card has no position");
  adb(["shell", "input", "tap", String(at.x), String(at.y)]);
  await waitFor("page 1", () => cdp.evaluate<boolean>(`document.querySelector('[data-page="1"] canvas')?.width > 0 || null`), 30_000);
  return cdp;
}

type PageMetrics = {
  dpr: number;
  zoom: number;
  box: { left: number; top: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** Canvases in the page box: the base and any tiles (backing store vs CSS size). */
  canvases: Array<{ width: number; height: number; cssWidth: number; cssHeight: number; left: number; top: number }>;
  tracker: unknown;
  samples: number[] | null;
};

const METRICS = `(() => {
  const box = document.querySelector('[data-page="1"]');
  const viewer = document.querySelector('[data-testid=pdf-viewer]');
  const r = box.getBoundingClientRect();
  const canvases = [...box.querySelectorAll('canvas')].map((c) => {
    const b = c.getBoundingClientRect();
    return { width: c.width, height: c.height, cssWidth: b.width, cssHeight: b.height, left: b.left, top: b.top };
  });
  const tracker = window.__selisSharpness;
  return {
    dpr: devicePixelRatio,
    zoom: Number(viewer.dataset.zoom),
    box: { left: r.left, top: r.top, width: r.width, height: r.height },
    viewport: { width: viewer.clientWidth, height: viewer.clientHeight },
    canvases,
    tracker: tracker ? tracker.snapshot() : null,
    samples: tracker ? [...tracker.samples] : null,
  };
})()`;

async function metrics(cdp: Cdp): Promise<PageMetrics> {
  const m = await cdp.evaluate<PageMetrics>(METRICS);
  if (!m) throw new Error("no metrics");
  return m;
}

/** Two-finger vertical pinch around (x, y) CSS px by `ratio` (real touch events). */
async function pinch(cdp: Cdp, x: number, y: number, ratio: number): Promise<void> {
  const start = 140;
  const steps = 12;
  const points = (d: number) => [
    { x, y: y - d / 2, id: 1 },
    { x, y: y + d / 2, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(start) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(start * (1 + ((ratio - 1) * i) / steps)) });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * Where the time between the end of a pinch and full resolution goes: render requests to
 * the engine worker, bitmaps drawn on the main thread (putImageData) and long tasks, in
 * ms after the touch ended.
 */
type ZoomTrace = {
  requests: number;
  draws: number;
  firstRequest: number;
  firstDraw: number;
  lastDraw: number;
  longTasks: Array<[number, number]>;
};

const ZOOM_CYCLES = 3;

const TRACE_ZOOM = `(() => {
  const t = { end: 0, requests: [], draws: [], long: [] };
  window.__selisZoomTrace = t;
  document.addEventListener('touchend', () => { t.end = performance.now(); }, { capture: true, once: true });
  if (!window.__selisTraceHooks) {
    window.__selisTraceHooks = true;
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      window.__selisZoomTrace?.draws.push(performance.now());
      return put.apply(this, args);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message && message.type === 'render') window.__selisZoomTrace?.requests.push(performance.now());
      return post.call(this, message, ...rest);
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__selisZoomTrace?.long.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask' });
  }
  return true;
})()`;

const READ_TRACE = `(() => {
  const t = window.__selisZoomTrace;
  const rel = (v) => Math.round(v - t.end);
  const after = (v) => v >= t.end;
  const requests = t.requests.filter(after);
  const draws = t.draws.filter(after);
  return {
    requests: requests.length,
    draws: draws.length,
    firstRequest: requests.length ? rel(requests[0]) : -1,
    firstDraw: draws.length ? rel(draws[0]) : -1,
    lastDraw: draws.length ? rel(draws[draws.length - 1]) : -1,
    longTasks: t.long.filter(([s]) => after(s)).map(([s, d]) => [rel(s), Math.round(d)]),
  };
})()`;

async function resetSamples(cdp: Cdp): Promise<void> {
  await cdp.evaluate("window.__selisSharpness?.reset() ?? null");
}

// ---- Reference render and SSIM -------------------------------------------------------------

type Reference = { render: (width: number, height: number) => Rgba };

async function reference(file: string): Promise<Reference> {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  const engine = new PdfiumNative(pdf, { fontFallback: null });
  const bytes = readFileSync(file);
  const doc = await engine
    .openDocumentBuffer({ id: "ref", content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, {})
    .toPromise();
  type PageCtx = { pagePtr: number; withFormHandle: (fn: (form: number) => void) => void; release: () => void };
  const context = (engine as unknown as { cache: { getContext: (id: string) => { acquirePage: (i: number) => PageCtx } } }).cache.getContext(
    doc.id,
  );
  const heapU8 = () => (pdf.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  return {
    // FPDF_RenderPageBitmap at exactly width × height device pixels: the reference PDFium render.
    render: (width, height) => {
      const page = context.acquirePage(0);
      const stride = width * 4;
      const heap = pdf.pdfium.wasmExports.malloc(stride * height);
      const bitmap = pdf.FPDFBitmap_CreateEx(width, height, 4, heap, stride);
      pdf.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      pdf.FPDF_RenderPageBitmap(bitmap, page.pagePtr, 0, 0, width, height, 0, 0x11);
      page.withFormHandle((form) => pdf.FPDF_FFLDraw(form, bitmap, page.pagePtr, 0, 0, width, height, 0, 0x11));
      const data = new Uint8ClampedArray(heapU8().subarray(heap, heap + stride * height));
      pdf.FPDFBitmap_Destroy(bitmap);
      pdf.pdfium.wasmExports.free(heap);
      page.release();
      return { data, width, height };
    },
  };
}

async function screenshot(file: string): Promise<Rgba> {
  const png = adbBytes(["exec-out", "screencap", "-p"]);
  writeFileSync(file, png);
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height);
  return { data: data.data, width: image.width, height: image.height };
}

/**
 * SSIM between the visible text area of page 1 on screen and the reference rendered at
 * the page box's device-pixel size. The WebView's offset on the screen (status bar) is
 * found by alignment; the band avoids the viewer's top bar and dock.
 */
function compare(screen: Rgba, m: PageMetrics, ref: Reference): { ssim: number; offset: { x: number; y: number }; area: string } {
  const width = Math.round(m.box.width * m.dpr);
  const height = Math.round(m.box.height * m.dpr);
  const page = ref.render(width, height);
  const viewTop = Math.max(m.box.top, m.viewport.height * 0.22);
  const viewBottom = Math.min(m.box.top + m.box.height, m.viewport.height * 0.78);
  const viewLeft = Math.max(m.box.left, 0);
  const viewRight = Math.min(m.box.left + m.box.width, m.viewport.width);
  // Page-relative device rect to compare.
  const px = Math.round((viewLeft - m.box.left) * m.dpr) + 4;
  const py = Math.round((viewTop - m.box.top) * m.dpr) + 4;
  const w = Math.floor((viewRight - viewLeft) * m.dpr) - 8;
  const h = Math.floor((viewBottom - viewTop) * m.dpr) - 8;
  const expected = crop(page, px, py, w, h);
  // Screen origin of the page box, up to the WebView's offset on the screen.
  const sx = Math.round(m.box.left * m.dpr);
  const sy = Math.round(m.box.top * m.dpr);
  const probe = crop(expected, 0, 0, Math.min(w, 400), Math.min(h, 300));
  let best = { score: -1, x: 0, y: 0 };
  for (let dy = 0; dy <= 260; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = sx + px + dx;
      const y = sy + py + dy;
      if (x < 0 || y < 0 || x + probe.width > screen.width || y + probe.height > screen.height) continue;
      const score = ssim(crop(screen, x, y, probe.width, probe.height), probe);
      if (score > best.score) best = { score, x: dx, y: dy };
    }
  }
  const shown = crop(screen, sx + px + best.x, sy + py + best.y, w, h);
  return { ssim: ssim(shown, expected), offset: { x: best.x, y: best.y }, area: `${String(w)}x${String(h)}` };
}

// ---- Scenarios -----------------------------------------------------------------------------

type Shot = {
  zoom: number;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  /** CSS width × DPR of the box, and what the base canvas holds. */
  wantWidth: number;
  baseBitmap: string;
  tiles: number;
  /** Smallest backing-store / (CSS size × DPR) ratio among the full-resolution canvases on screen. */
  minRatio: number;
  tracker: unknown;
  ssim: number;
  offset: { x: number; y: number };
  area: string;
};

async function shot(cdp: Cdp, ref: Reference, name: string): Promise<Shot> {
  await sleep(1500);
  const m = await metrics(cdp);
  const screen = await screenshot(join(out, `${name}.png`));
  const result = compare(screen, m, ref);
  const onScreen = m.canvases.filter(
    (c) => c.cssWidth > 0 && c.top < m.viewport.height && c.top + c.cssHeight > 0 && c.left < m.viewport.width && c.left + c.cssWidth > 0,
  );
  const tiles = m.canvases.length - 1;
  // With tiles, the full-resolution layer is the tiles; the base is the low-res pass under them.
  const layer = tiles > 0 ? onScreen.slice(1) : onScreen.slice(0, 1);
  const minRatio = Math.min(...layer.map((c) => c.width / (c.cssWidth * m.dpr)));
  const base = m.canvases[0];
  return {
    zoom: m.zoom,
    dpr: m.dpr,
    cssWidth: m.box.width,
    cssHeight: m.box.height,
    wantWidth: Math.round(m.box.width * m.dpr),
    baseBitmap: base ? `${String(base.width)}x${String(base.height)}` : "none",
    tiles,
    minRatio: Number(minRatio.toFixed(4)),
    tracker: m.tracker,
    ssim: Number(result.ssim.toFixed(4)),
    offset: result.offset,
    area: result.area,
  };
}

/** rAF frames per second over the whole swipe window, and only over frames where the content moved. */
type Fps = { fps: number; p95: number; over33: number; frames: number; motionFps: number; motionFrames: number };

/** `runs` fling sessions; the frame intervals of all of them together. */
async function scrollFpsRuns(cdp: Cdp, runs: number, screenWidth: number, screenHeight: number): Promise<Fps & { runs: Fps[] }> {
  const all: Fps[] = [];
  for (let i = 0; i < runs; i++) all.push(await scrollFps(cdp, screenWidth, screenHeight));
  const frames = all.reduce((n, r) => n + r.frames, 0);
  const motionFrames = all.reduce((n, r) => n + r.motionFrames, 0);
  return {
    fps: Number((all.reduce((n, r) => n + r.fps * r.frames, 0) / frames).toFixed(1)),
    p95: Math.max(...all.map((r) => r.p95)),
    over33: all.reduce((n, r) => n + r.over33, 0),
    frames,
    motionFps: motionFrames > 0 ? Number((all.reduce((n, r) => n + r.motionFps * r.motionFrames, 0) / motionFrames).toFixed(1)) : 0,
    motionFrames,
    runs: all,
  };
}

/** rAF frame intervals while flinging with real swipes. */
async function scrollFps(cdp: Cdp, screenWidth: number, screenHeight: number): Promise<Fps> {
  await cdp.evaluate(`(() => {
    // One loop at a time: a token per run, so the previous run's last callback stops.
    const run = (window.__fpsRun = (window.__fpsRun ?? 0) + 1);
    const frames = (window.__frames = []);
    const el = document.querySelector('[data-testid=pdf-viewer]');
    const tick = (t) => { if (window.__fpsRun !== run) return; frames.push([t, el.scrollTop]); if (frames.length < 100000) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return true;
  })()`);
  const x = String(Math.round(screenWidth / 2));
  for (let i = 0; i < 6; i++) {
    const down = i % 3 !== 2;
    const [a, b] = down ? [screenHeight * 0.75, screenHeight * 0.25] : [screenHeight * 0.25, screenHeight * 0.75];
    adb(["shell", "input", "swipe", x, String(Math.round(a)), x, String(Math.round(b)), "120"]);
    await sleep(900);
  }
  const frames = (await cdp.evaluate<Array<[number, number]>>("(() => { window.__fpsRun += 1; return window.__frames; })()")) ?? [];
  const gaps = frames.slice(1).map(([t], i) => t - (frames[i]?.[0] ?? t));
  const sorted = [...gaps].sort((a, b) => a - b);
  const total = (frames.at(-1)?.[0] ?? 0) - (frames[0]?.[0] ?? 0);
  // Frames while the content moves (the scroll position changed since the previous frame).
  const moving = frames.slice(1).flatMap(([t, top], i) => (top !== frames[i]?.[1] ? [t - (frames[i]?.[0] ?? t)] : []));
  const movingTime = moving.reduce((a, b) => a + b, 0);
  return {
    fps: Number(((gaps.length / total) * 1000).toFixed(1)),
    p95: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1)),
    over33: gaps.filter((g) => g > 33.4).length,
    frames: gaps.length,
    motionFps: movingTime > 0 ? Number(((moving.length / movingTime) * 1000).toFixed(1)) : 0,
    motionFrames: moving.length,
  };
}

/** Swipe flings at the current zoom; the tracker's samples are ms from stop to full resolution. */
async function stopTimes(cdp: Cdp, screenWidth: number, screenHeight: number): Promise<number[] | null> {
  await resetSamples(cdp);
  const x = String(Math.round(screenWidth / 2));
  for (let i = 0; i < 5; i++) {
    const [a, b] = i % 2 === 0 ? [screenHeight * 0.7, screenHeight * 0.45] : [screenHeight * 0.45, screenHeight * 0.6];
    adb(["shell", "input", "swipe", x, String(Math.round(a)), x, String(Math.round(b)), "250"]);
    await sleep(1500);
  }
  return (await metrics(cdp)).samples;
}

type Pss = { app: number; renderer: number; total: number };

function rendererPid(): string | null {
  const uid = /(?:userId|appId)=(\d+)/.exec(adb(["shell", "dumpsys", "package", PKG]))?.[1];
  if (!uid) return null;
  const tag = `/u0a${String(Number(uid) - 10000)}i`;
  for (const line of adb(["shell", "dumpsys", "activity", "processes"]).split(/\r?\n/)) {
    if (!line.includes("sandboxed_process") || !line.includes(tag)) continue;
    const pid = /(\d+):com\.(?:google\.)?android\.(?:webview|chrome)[^:]*:sandboxed/.exec(line)?.[1];
    if (pid) return pid;
  }
  return null;
}

function pssMb(target: string): number {
  const text = adb(["shell", "dumpsys", "meminfo", target]);
  return Math.round(Number(/TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? /\n\s*TOTAL\s+(\d+)/.exec(text)?.[1] ?? 0) / 1024);
}

function pss(): Pss {
  const app = pssMb(PKG);
  const pid = rendererPid();
  const renderer = pid ? pssMb(pid) : 0;
  return { app, renderer, total: app + renderer };
}

const SCROLL_TO_END = `(async () => {
  const el = document.querySelector('[data-testid=pdf-viewer]');
  while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
    el.scrollTop += el.clientHeight * 0.9;
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const last = document.querySelector('[data-page="1000"] canvas');
  return !!last && last.width > 0;
})()`;

/** Scrolls the 1000-page fixture top to bottom (as docs/spike-p0.md), then 40 pages at 2.5×, sampling PSS. */
async function memoryRun(docId: string): Promise<{ fit: Pss; zoomed: Pss; lastPage: boolean }> {
  const cdp = await openDocument(docId);
  try {
    await sleep(1500);
    let peak: Pss = { app: 0, renderer: 0, total: 0 };
    const sample = () => {
      const now = pss();
      if (now.total > peak.total) peak = now;
    };
    let timer = setInterval(sample, 1500);
    const lastPage = (await cdp.evaluate<boolean>(SCROLL_TO_END)) ?? false;
    clearInterval(timer);
    sample();
    const fit = peak;
    // Zoomed reading: double tap to 2.5× at the top, then scroll 40 pages.
    await cdp.evaluate("document.querySelector('[data-testid=pdf-viewer]').scrollTop = 0");
    await sleep(1500);
    const m = await metrics(cdp);
    const x = String(Math.round((m.viewport.width / 2) * m.dpr));
    const y = String(Math.round((m.viewport.height / 2) * m.dpr));
    adb(["shell", "input", "tap", x, y]);
    await sleep(120);
    adb(["shell", "input", "tap", x, y]);
    await sleep(2000);
    peak = { app: 0, renderer: 0, total: 0 };
    timer = setInterval(sample, 1500);
    await cdp.evaluate(`(async () => {
      const el = document.querySelector('[data-testid=pdf-viewer]');
      const target = el.scrollHeight / 1000 * 40;
      while (el.scrollTop < target) { el.scrollTop += el.clientHeight * 0.5; await new Promise((r) => setTimeout(r, 80)); }
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    })()`);
    clearInterval(timer);
    sample();
    return { fit, zoomed: peak, lastPage };
  } finally {
    cdp.close();
  }
}

// ---- Main ----------------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  serial = options.serial;
  const profile = PROFILES[options.profile];
  const smallText = join(root, "packages/fixtures/out/small-text.pdf");
  const large = join(root, "packages/fixtures/out/large-1000.pdf");
  if (options.apk) {
    log(`installing ${options.apk}`);
    const r = spawnSync("adb", ["-s", serial, "install", "-r", "-d", options.apk], { encoding: "utf8", env, timeout: ADB_TIMEOUT_MS });
    if (r.status !== 0) throw new Error(`install failed: ${r.stdout}${r.stderr}`);
  }
  adb(["shell", "wm", "size", profile.size]);
  adb(["shell", "wm", "density", String(profile.density)]);
  const [screenWidth, screenHeight] = profile.size.split("x").map(Number) as [number, number];
  const result: Record<string, unknown> = { label: options.label, profile: options.profile, date: new Date().toISOString() };
  try {
    const ref = await reference(smallText);
    const docId = await importFixture(smallText);
    const cdp = await openDocument(docId);
    try {
      const fit = await shot(cdp, ref, `${options.label}-${options.profile}-fit`);
      log(`fit-width: ${JSON.stringify(fit)}`);
      result.fit = fit;
      result.fitStops = await stopTimes(cdp, screenWidth, screenHeight);
      result.fitFps = await scrollFpsRuns(cdp, options.fpsRuns, screenWidth, screenHeight);
      log(`fit-width stops ${JSON.stringify(result.fitStops)} fps ${JSON.stringify(result.fitFps)}`);
      // Back to the top of page 1, then pinch to 100 % (1 pt = 4/3 CSS px).
      await cdp.evaluate("document.querySelector('[data-testid=pdf-viewer]').scrollTop = 0");
      await sleep(1500);
      // Fit-width → 100 % three times (back to fit-width in between): the time until
      // every visible page is sharp after each zoom, and where it went.
      const zoomStops: number[] = [];
      const zoomTraces: ZoomTrace[] = [];
      for (let cycle = 0; cycle < ZOOM_CYCLES; cycle++) {
        const m = await metrics(cdp);
        const ratio = (595.28 * (4 / 3)) / m.box.width;
        const x = m.viewport.width / 2;
        const y = m.box.top + Math.min(m.box.height, m.viewport.height) * 0.45;
        await resetSamples(cdp);
        await cdp.evaluate(TRACE_ZOOM);
        await pinch(cdp, x, y, ratio);
        await sleep(2500);
        zoomStops.push(Math.max(-1, ...((await metrics(cdp)).samples ?? [])));
        const trace = await cdp.evaluate<ZoomTrace>(READ_TRACE);
        if (trace) zoomTraces.push(trace);
        if (cycle === ZOOM_CYCLES - 1) break;
        await pinch(cdp, x, y, 1 / ratio);
        await sleep(1500);
        await cdp.evaluate("document.querySelector('[data-testid=pdf-viewer]').scrollTop = 0");
        await sleep(1500);
      }
      result.zoomStop = zoomStops;
      result.zoomTrace = zoomTraces;
      log(`zoom-to-sharp ${JSON.stringify(zoomStops)} trace ${JSON.stringify(zoomTraces)}`);
      const full = await shot(cdp, ref, `${options.label}-${options.profile}-100`);
      log(`100 %: ${JSON.stringify(full)}`);
      result.hundred = full;
      result.hundredStops = await stopTimes(cdp, screenWidth, screenHeight);
      result.hundredFps = await scrollFpsRuns(cdp, options.fpsRuns, screenWidth, screenHeight);
      log(`100 % stops ${JSON.stringify(result.hundredStops)} fps ${JSON.stringify(result.hundredFps)}`);
      result.limits = adb(["shell", "logcat", "-d"])
        .split(/\r?\n/)
        .filter((l) => l.includes("[selis:perf] ram="))
        .at(-1);
    } finally {
      cdp.close();
    }
    if (options.memory) {
      const largeId = await importFixture(large);
      result.memory = await memoryRun(largeId);
      log(`memory: ${JSON.stringify(result.memory)}`);
    }
  } finally {
    adb(["shell", "wm", "size", "reset"]);
    adb(["shell", "wm", "density", "reset"]);
    adb(["shell", "rm", "-rf", PUSH_DIR]);
    adb(["forward", "--remove", `tcp:${String(CDP_PORT)}`]);
    writeFileSync(join(out, `${options.label}-${options.profile}.json`), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
}

await main();
