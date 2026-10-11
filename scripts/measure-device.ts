/**
 * Performance gate on a real Android device (docs/spike-p0.md, docs/SPEC.md):
 * first page of the 1000-page fixture on a cold open < 1 s, WebView memory
 * (app + renderer PSS) < 600 MB while scrolling through it.
 *
 * Run through scripts/measure-device.sh, which sets up the scratch directory.
 *
 *   node scripts/measure-device.ts [--serial <adb serial>] [--runs 5]
 *        [--skip-build] [--no-doc] [--allow-emulator] [--fixture <1000-page pdf>]
 *
 * --fixture measures another 1000-page file instead of large-1000.pdf (e.g. the
 * P2 gate: the fixture with 50 annotations, written by the engine's sample
 * generator; see packages/engine/src/annotations.node.test.ts).
 *
 * 1. Picks the first connected physical device that is not a Galaxy S23
 *    (already measured), unless --serial names one.
 * 2. Builds a release-like APK (release profile: optimized Rust, minified JS;
 *    plus the `measure` feature, which only keeps WebView remote debugging on)
 *    for the device's ABI and signs it with the local Android debug key.
 * 3. Installs it, clears Selis' data, imports the 1000-page fixture with an
 *    "Open with" intent (MediaStore URI + read grant), then N times: cold start (force-stop, launch, tap the
 *    document), time to first page, full scroll with PSS sampled every 1.5 s.
 * 4. Cleans up (Selis data cleared, pushed fixture deleted, port forward removed) and
 *    appends a row to docs/spike-p0.md. Exit code: 0 pass, 1 gate failed,
 *    2 error, 3 no suitable device.
 *
 * Selis' data on the device is wiped (pm clear): use a test device.
 * Every external tool is started without a shell, with argument arrays.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "com.anywecon.selis";
const DEFAULT_FIXTURE = "large-1000.pdf";
const GATE_FIRST_PAGE_MS = 1000;
const GATE_PEAK_MB = 600;
const CDP_PORT = 9341;
/** Galaxy S23 / S23+ / S23 Ultra: flagships, measured in docs/spike-p0.md already. */
const S23_MODELS = /^SM-S91[168]/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".tmp", "measure");
mkdirSync(scratch, { recursive: true });

type Options = {
  serial: string | null;
  runs: number;
  build: boolean;
  doc: boolean;
  allowEmulator: boolean;
  /** Absolute path of the 1000-page file to measure. */
  fixture: string;
};

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    serial: null,
    runs: 5,
    build: true,
    doc: true,
    allowEmulator: false,
    fixture: join(root, "packages/fixtures/out", DEFAULT_FIXTURE),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--serial") options.serial = argv[++i] ?? null;
    else if (arg === "--runs") options.runs = Math.max(1, Number(argv[++i] ?? "5") || 5);
    else if (arg === "--skip-build") options.build = false;
    else if (arg === "--no-doc") options.doc = false;
    else if (arg === "--allow-emulator") options.allowEmulator = true;
    else if (arg === "--fixture") options.fixture = resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument ${String(arg)}`);
  }
  return options;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };

function adb(serial: string | null, args: readonly string[]): string {
  const full = serial ? ["-s", serial, ...args] : [...args];
  return execFileSync("adb", full, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
}

function log(message: string): void {
  console.error(`[measure] ${message}`);
}

type DeviceInfo = {
  serial: string;
  model: string;
  manufacturer: string;
  soc: string;
  ramGb: number;
  android: string;
  webview: string;
  abi: string;
};

function deviceInfo(serial: string): DeviceInfo {
  const prop = (name: string) => adb(serial, ["shell", "getprop", name]).trim();
  const memKb = Number(/MemTotal:\s+(\d+)/.exec(adb(serial, ["shell", "cat", "/proc/meminfo"]))?.[1] ?? 0);
  const socModel = prop("ro.soc.model") || prop("ro.board.platform") || prop("ro.hardware");
  const webview = /Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/.exec(
    adb(serial, ["shell", "dumpsys", "webviewupdate"]),
  );
  return {
    serial,
    model: prop("ro.product.model"),
    manufacturer: prop("ro.product.manufacturer"),
    soc: [prop("ro.soc.manufacturer"), socModel].filter(Boolean).join(" "),
    ramGb: Math.round((memKb / 1024 / 1024) * 10) / 10,
    android: `${prop("ro.build.version.release")} (API ${prop("ro.build.version.sdk")})`,
    webview: webview?.[2] ?? "unknown",
    abi: prop("ro.product.cpu.abi"),
  };
}

function pickDevice(options: Options): DeviceInfo | null {
  const serials = adb(null, ["devices"])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === "device")
    .map((parts) => parts[0] ?? "")
    .filter(Boolean);
  if (options.serial) {
    if (!serials.includes(options.serial)) throw new Error(`device ${options.serial} is not connected`);
    return deviceInfo(options.serial);
  }
  for (const serial of serials) {
    if (serial.startsWith("emulator-") && !options.allowEmulator) continue;
    const info = deviceInfo(serial);
    if (S23_MODELS.test(info.model)) {
      log(`skipping ${serial} (${info.model}, Galaxy S23 family: already measured)`);
      continue;
    }
    return info;
  }
  return null;
}

const RUST_TARGETS: Record<string, string> = {
  "arm64-v8a": "aarch64",
  "armeabi-v7a": "armv7",
  x86_64: "x86_64",
  x86: "i686",
};

function sdkDir(): string {
  const fromEnv = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (fromEnv) return fromEnv;
  const local = process.env.LOCALAPPDATA;
  return local ? join(local, "Android", "Sdk") : join(homedir(), "Android", "Sdk");
}

function newestChild(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const last = names.at(-1);
  return last ? join(dir, last) : null;
}

function findFiles(dir: string, match: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findFiles(path, match);
    return match(path) ? [path] : [];
  });
}

/** npm's CLI entry point, run with this node (no shell, no npm.cmd). */
function npmCli(): string {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv?.endsWith(".js") || fromEnv?.endsWith(".cjs")) return fromEnv;
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return bundled;
  throw new Error("npm-cli.js not found next to node: run through npm or set npm_execpath");
}

/** Release APK for one ABI, signed with the local debug key (never a real signing key). */
function buildApk(abi: string): string {
  const target = RUST_TARGETS[abi];
  if (!target) throw new Error(`unsupported ABI ${abi}`);
  const sdk = sdkDir();
  const buildEnv: NodeJS.ProcessEnv = { ...env, ANDROID_HOME: sdk };
  if (!buildEnv.NDK_HOME) {
    const ndk = newestChild(join(sdk, "ndk"));
    if (!ndk) throw new Error("no NDK found: set NDK_HOME");
    buildEnv.NDK_HOME = ndk;
  }
  // The dev machine's TLS-intercepting proxy (CLAUDE.md): trust the Windows store.
  if (platform() === "win32" && !buildEnv.GRADLE_OPTS) buildEnv.GRADLE_OPTS = "-Djavax.net.ssl.trustStoreType=Windows-ROOT";
  const logFile = join(scratch, "build.log");
  log(`building the release APK for ${abi} (log: ${logFile})`);
  const build = spawnSync(
    process.execPath,
    [npmCli(), "run", "tauri", "--", "android", "build", "--apk", "--target", target, "--features", "measure"],
    { cwd: root, env: buildEnv, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  writeFileSync(logFile, `${build.stdout}\n${build.stderr}`);
  if (build.status !== 0) throw new Error(`android build failed (exit ${String(build.status)}), see ${logFile}`);

  const outputs = join(root, "apps/app/src-tauri/gen/android/app/build/outputs/apk");
  const unsigned = findFiles(outputs, (f) => /release.*\.apk$/.test(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .at(0);
  if (!unsigned) throw new Error(`no release APK under ${outputs}`);

  const keystore = join(homedir(), ".android", "debug.keystore");
  if (!existsSync(keystore)) throw new Error(`${keystore} missing: build any debug APK once to create it`);
  const tools = newestChild(join(sdk, "build-tools"));
  const signer = tools ? join(tools, "lib", "apksigner.jar") : null;
  if (!signer || !existsSync(signer)) throw new Error("apksigner.jar not found in the newest Android build-tools");
  const signed = join(scratch, "selis-measure.apk");
  // The debug key's well-known password ("android"); not a secret.
  const sign = spawnSync(
    "java",
    ["-jar", signer, "sign", "--ks", keystore, "--ks-pass", "pass:android", "--ks-key-alias", "androiddebugkey", "--out", signed, unsigned],
    { env: buildEnv, encoding: "utf8" },
  );
  if (sign.status !== 0) throw new Error(`apksigner failed: ${sign.stderr}`);
  return signed;
}

function install(serial: string, apk: string): void {
  const attempt = spawnSync("adb", ["-s", serial, "install", "-r", "-d", apk], { encoding: "utf8", env });
  if (attempt.status === 0) return;
  const output = `${attempt.stdout}${attempt.stderr}`;
  if (!output.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")) throw new Error(`install failed: ${output}`);
  // Installed with another key (e.g. a CI build): replace it.
  log("an install signed with another key is present: uninstalling it first");
  adb(serial, ["uninstall", PKG]);
  adb(serial, ["install", apk]);
}

type Pss = { app: number; renderer: number; total: number };

function procPssMb(serial: string, target: string): number {
  const out = adb(serial, ["shell", "dumpsys", "meminfo", target]);
  const kb = Number(/TOTAL PSS:\s+(\d+)/.exec(out)?.[1] ?? /TOTAL\s+(\d+)/.exec(out)?.[1] ?? 0);
  return Math.round(kb / 1024);
}

/** The WebView renderer: the sandboxed process bound by our app (`.../u0aNNNi...`). */
function rendererPid(serial: string): string | null {
  const uid = /(?:userId|appId)=(\d+)/.exec(adb(serial, ["shell", "dumpsys", "package", PKG]))?.[1];
  if (!uid) return null;
  const tag = `/u0a${Number(uid) - 10000}i`;
  for (const line of adb(serial, ["shell", "dumpsys", "activity", "processes"]).split(/\r?\n/)) {
    if (!line.includes("sandboxed_process") || !line.includes(tag)) continue;
    const pid = /(\d+):com\.(?:google\.)?android\.(?:webview|chrome)[^:]*:sandboxed/.exec(line)?.[1];
    if (pid) return pid;
  }
  return null;
}

function pss(serial: string): Pss {
  const app = procPssMb(serial, PKG);
  const pid = rendererPid(serial);
  const renderer = pid ? procPssMb(serial, pid) : 0;
  return { app, renderer, total: app + renderer };
}

type Cdp = { evaluate: <T>(expression: string) => Promise<T | undefined>; close: () => void };

async function openSocket(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", rejectOpen, { once: true });
  });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (msg.id === undefined) return;
    pending.get(msg.id)?.(msg.result ?? msg.error);
    pending.delete(msg.id);
  });
  const evaluate = async <T>(expression: string): Promise<T | undefined> => {
    const mid = ++id;
    const reply = new Promise<unknown>((r) => pending.set(mid, r));
    ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const result = (await reply) as { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    if (result?.exceptionDetails) throw new Error(`page error: ${JSON.stringify(result.exceptionDetails)}`);
    return result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

/** Chrome DevTools Protocol on the app's WebView (needs the `measure` build feature). */
async function connect(serial: string, timeoutMs = 20_000): Promise<Cdp> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = adb(serial, ["shell", "pidof", PKG]).trim();
      const socket = new RegExp(`@(webview_devtools_remote_${pid})`).exec(adb(serial, ["shell", "cat", "/proc/net/unix"]))?.[1];
      if (pid && socket) {
        adb(serial, ["forward", `tcp:${CDP_PORT}`, `localabstract:${socket}`]);
        const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((t) => t.type === "page");
        if (page) return await openSocket(page.webSocketDebuggerUrl);
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("WebView DevTools not reachable (is this a `measure` build?)");
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

const IPC_READY = "typeof window.__TAURI_INTERNALS__?.invoke === 'function' || null";

function launch(serial: string): void {
  adb(serial, ["shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`]);
}

const PUSH_DIR = "/sdcard/Download/selis-measure";

/** The pushed fixture's MediaStore id, once the media scanner has indexed it. */
async function mediaId(serial: string, fixture: string): Promise<string> {
  return waitFor(
    "the media scanner",
    () => {
      const out = adb(serial, [
        "shell",
        "content",
        "query",
        "--uri",
        "content://media/external/downloads",
        "--projection",
        "_id:relative_path",
        "--where",
        `"_display_name='${basename(fixture)}'"`,
      ]);
      return Promise.resolve(/_id=(\d+), relative_path=Download\/selis-measure\//.exec(out)?.[1] ?? null);
    },
    20_000,
  );
}

/**
 * Imports the fixture the way a user does with "Open with": a VIEW intent with a
 * MediaStore URI and a read grant (the app has no storage permission; files that
 * adb writes elsewhere are not readable by it). Returns the document id.
 */
async function importFixture(serial: string, fixture: string): Promise<string> {
  const name = basename(fixture);
  adb(serial, ["shell", "pm", "clear", PKG]);
  adb(serial, ["shell", "mkdir", "-p", PUSH_DIR]);
  adb(serial, ["push", fixture, `${PUSH_DIR}/${name}`]);
  adb(serial, ["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${PUSH_DIR}/${name}`]);
  const uri = `content://media/external/downloads/${await mediaId(serial, fixture)}`;
  adb(serial, [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    uri,
    "-t",
    "application/pdf",
    "--grant-read-uri-permission",
    "-n",
    `${PKG}/.MainActivity`,
  ]);
  const cdp = await connect(serial);
  try {
    await waitFor("the IPC bridge", () => cdp.evaluate<boolean>(IPC_READY), 20_000);
    // The import runs through the app's import machine; wait for its library row.
    return await waitFor(
      "the imported document",
      () =>
        cdp.evaluate<string>(`(async () => {
          const docs = await window.__TAURI_INTERNALS__.invoke("list_documents", {
            query: { search: "", filter: "all", tagId: null, sort: "recent" },
          });
          return docs.find((d) => d.pageCount === 1000)?.id ?? null;
        })()`),
      60_000,
    );
  } finally {
    cdp.close();
  }
}

/** Removes the pushed fixture and its MediaStore row (the library has its own copy). */
function removeFixture(serial: string): void {
  // A media scan of a deleted file does not drop its row on every Android version.
  // The folder has its own row too.
  adb(serial, ["shell", "rm", "-rf", PUSH_DIR]);
  adb(serial, [
    "shell",
    "content",
    "delete",
    "--uri",
    "content://media/external/file",
    "--where",
    `"_data LIKE '%/Download/selis-measure%'"`,
  ]);
}

type Run = { firstPageMs: number | null; peak: Pss; lastPageRendered: boolean; alive: boolean };

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

const CARD = '[data-testid="document-collection"] button';

/** Cold start, open the document from the library, first page, full scroll with memory sampling. */
async function coldRun(serial: string, docId: string): Promise<Run> {
  adb(serial, ["shell", "am", "force-stop", PKG]);
  await sleep(1000);
  launch(serial);
  const cdp = await connect(serial);
  try {
    await waitFor("the IPC bridge", () => cdp.evaluate<boolean>(IPC_READY), 20_000);
    // Opens at page 1 like every earlier spike run (the reader remembers the last page).
    await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke("set_last_page", { id: ${JSON.stringify(docId)}, page: 0 })`);
    await waitFor("the library card", () => cdp.evaluate<boolean>(`document.querySelector('${CARD}') ? true : null`), 20_000);
    await sleep(1000);
    // A real touch (not el.click()): the same input path as a finger. Coordinates
    // from the DOM, so no UiAutomator dump, which would switch on the WebView's
    // accessibility tree and slow it down.
    const at = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('${CARD}').getBoundingClientRect();
      return { x: Math.round((r.left + r.width / 2) * devicePixelRatio), y: Math.round((r.top + r.height / 3) * devicePixelRatio) };
    })()`);
    if (!at) throw new Error("library card has no position");
    adb(serial, ["shell", "input", "tap", String(at.x), String(at.y)]);
    let firstPageMs: number | null = null;
    try {
      firstPageMs = await waitFor("the first page", () => cdp.evaluate<number>("window.__selisFirstPageMs ?? null"), 20_000);
    } catch {
      // Reported as "none" and as a failure.
    }
    await sleep(1500);

    let peak: Pss = { app: 0, renderer: 0, total: 0 };
    const sample = () => {
      try {
        const now = pss(serial);
        if (now.total > peak.total) peak = now;
      } catch {
        // The app died: reported below.
      }
    };
    const sampler = setInterval(sample, 1500);
    let lastPageRendered = false;
    try {
      lastPageRendered = (await cdp.evaluate<boolean>(SCROLL_TO_END)) ?? false;
    } finally {
      clearInterval(sampler);
    }
    sample();
    const alive = adb(serial, ["shell", "pidof", PKG]).trim() !== "";
    return { firstPageMs: firstPageMs === null ? null : Math.round(firstPageMs), peak, lastPageRendered, alive };
  } finally {
    cdp.close();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

const DOC_HEADING = "## Real-device runs (`scripts/measure-device.sh`)";
const DOC_INTRO = [
  "",
  "One row per run of the script: release-like build (release profile + the `measure` feature for",
  "WebView remote debugging), 1000-page fixture, cold open from the library, full scroll.",
  "Gate: every first page < 1 s, peak app + renderer PSS < 600 MB.",
  "",
  "| Date | Device | SoC | RAM | Android · WebView | First page, cold (median, range) | Peak PSS app + renderer | Result |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

function appendRow(row: string): string {
  const path = join(root, "docs", "spike-p0.md");
  const lines = readFileSync(path, "utf8").split("\n");
  if (!lines.includes(DOC_HEADING)) {
    while (lines.at(-1) === "") lines.pop();
    lines.push("", DOC_HEADING, ...DOC_INTRO, "");
  }
  let at = lines.indexOf(DOC_HEADING) + 1;
  while (at < lines.length && !(lines[at] ?? "").startsWith("|")) at++;
  while (at < lines.length && (lines[at] ?? "").startsWith("|")) at++;
  lines.splice(at, 0, row);
  writeFileSync(path, lines.join("\n"));
  return path;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const device = pickDevice(options);
  if (!device) {
    console.log(
      "No suitable device: connect a physical mid-range Android device with USB debugging on " +
        "(emulators and the Galaxy S23 family are skipped; --serial overrides).",
    );
    return 3;
  }
  log(
    `device ${device.serial}: ${device.manufacturer} ${device.model}, ${device.soc}, ${device.ramGb} GB, ` +
      `Android ${device.android}, WebView ${device.webview}`,
  );

  if (!existsSync(options.fixture) && basename(options.fixture) === DEFAULT_FIXTURE) {
    log("generating fixtures");
    execFileSync(process.execPath, [npmCli(), "run", "fixtures"], { cwd: root, stdio: "inherit" });
  }
  if (!existsSync(options.fixture)) throw new Error(`${options.fixture} missing`);
  const apk = options.build ? buildApk(device.abi) : join(scratch, "selis-measure.apk");
  if (!existsSync(apk)) throw new Error(`${apk} missing (run without --skip-build)`);
  install(device.serial, apk);

  const runs: Run[] = [];
  try {
    const docId = await importFixture(device.serial, options.fixture);
    for (let i = 1; i <= options.runs; i++) {
      const run = await coldRun(device.serial, docId);
      runs.push(run);
      log(
        `run ${i}/${options.runs}: first page ${run.firstPageMs ?? "none"} ms, peak ${run.peak.total} MB ` +
          `(app ${run.peak.app} + renderer ${run.peak.renderer}), page 1000 ${run.lastPageRendered ? "rendered" : "NOT rendered"}` +
          (run.alive ? "" : ", APP DIED"),
      );
    }
  } finally {
    // No fixture and no library copy are left behind; the app stays installed.
    try {
      removeFixture(device.serial);
      adb(device.serial, ["shell", "pm", "clear", PKG]);
      adb(device.serial, ["forward", "--remove", `tcp:${CDP_PORT}`]);
    } catch (err) {
      log(`cleanup incomplete: ${String(err)}`);
    }
  }

  const measured = runs.map((r) => r.firstPageMs).filter((v): v is number => v !== null);
  const peak = runs.reduce<Pss>((max, r) => (r.peak.total > max.total ? r.peak : max), { app: 0, renderer: 0, total: 0 });
  const failures = [
    ...(measured.length < runs.length ? ["first page not shown in every run"] : []),
    ...(measured.some((v) => v >= GATE_FIRST_PAGE_MS) ? [`first page ≥ ${GATE_FIRST_PAGE_MS} ms`] : []),
    ...(peak.total >= GATE_PEAK_MB ? [`peak ≥ ${GATE_PEAK_MB} MB`] : []),
    ...(runs.some((r) => !r.alive) ? ["app died"] : []),
    ...(runs.some((r) => !r.lastPageRendered) ? ["page 1000 not rendered"] : []),
  ];
  const pass = failures.length === 0;
  const date = new Date().toISOString();
  writeFileSync(join(scratch, `result-${device.serial}.json`), JSON.stringify({ date, device, runs, peak, pass, failures }, null, 2));

  const firstCell = measured.length
    ? `${median(measured)} ms (${Math.min(...measured)}–${Math.max(...measured)}, ${runs.length} run${runs.length === 1 ? "" : "s"})`
    : "none";
  const result = pass ? "**PASS**" : `**FAIL** (${failures.join("; ")})`;
  const row =
    `| ${date.slice(0, 10)} | ${device.manufacturer} ${device.model}` +
    `${basename(options.fixture) === DEFAULT_FIXTURE ? "" : ` (${basename(options.fixture)})`} | ${device.soc} | ${device.ramGb} GB | ` +
    `${device.android} · ${device.webview} | ${firstCell} | ${peak.total} MB (${peak.app} + ${peak.renderer}) | ${result} |`;
  console.log(row);
  if (options.doc) log(`appended to ${appendRow(row)}`);
  return pass ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`[measure] error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
