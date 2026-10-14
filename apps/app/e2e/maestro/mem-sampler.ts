/**
 * Samples Selis' memory on a device until `<out.log>.stop` exists (or `seconds` pass):
 * `node mem-sampler.ts <serial> <out.log> [seconds=900]`.
 *
 * Each line: `<epoch ms> <app PSS kB> <renderer PSS kB> <app RSS kB> <renderer RSS kB>`. The
 * renderer is the WebView sandboxed process bound by our app (`…/u0aNNNi…` in `dumpsys activity
 * processes`), as in scripts/measure-device.ts: the project's memory gate is app + renderer PSS
 * (docs/spike-p0.md). RSS is kept for comparison; summed over two processes it counts the
 * WebView library mapped in both twice.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";

const PKG = "com.anywecon.selis";
const [serial, out, secondsArg] = process.argv.slice(2);
if (!serial || !out) throw new Error("usage: mem-sampler.ts <serial> <out.log> [seconds]");
const until = Date.now() + Number(secondsArg ?? 900) * 1000;

function adb(args: string[]): string {
  const r = spawnSync("adb", ["-s", serial ?? "", ...args], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return r.status === 0 ? r.stdout : "";
}

function meminfo(target: string): { pss: number; rss: number } {
  const text = adb(["shell", "dumpsys", "meminfo", target]);
  return {
    pss: Number(/TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? /\n\s*TOTAL\s+(\d+)/.exec(text)?.[1] ?? 0),
    rss: Number(/TOTAL RSS:\s+(\d+)/.exec(text)?.[1] ?? 0),
  };
}

let tag: string | null = null;
function rendererPid(): string | null {
  if (!tag) {
    const uid = /(?:userId|appId)=(\d+)/.exec(adb(["shell", "dumpsys", "package", PKG]))?.[1];
    if (!uid) return null;
    tag = `/u0a${String(Number(uid) - 10000)}i`;
  }
  for (const line of adb(["shell", "dumpsys", "activity", "processes"]).split(/\r?\n/)) {
    if (!line.includes("sandboxed_process") || !line.includes(tag)) continue;
    const pid = /(\d+):com\.(?:google\.)?android\.(?:webview|chrome)[^:]*:sandboxed/.exec(line)?.[1];
    if (pid) return pid;
  }
  return null;
}

const stop = `${out}.stop`;
rmSync(stop, { force: true });
writeFileSync(out, "");
let renderer: string | null = null;
let checked = 0;
while (Date.now() < until && !existsSync(stop)) {
  const app = meminfo(PKG);
  // The renderer can restart (app relaunch): look it up again every 10 s.
  if (!renderer || Date.now() - checked > 10_000) {
    renderer = rendererPid();
    checked = Date.now();
  }
  const r = renderer ? meminfo(renderer) : { pss: 0, rss: 0 };
  if (app.pss > 0 && !existsSync(stop)) appendFileSync(out, `${String(Date.now())} ${String(app.pss)} ${String(r.pss)} ${String(app.rss)} ${String(r.rss)}\n`);
}
