// Runs bench-core.js inside the Selis WebView on a device (debug build) over the DevTools socket.
// usage: node run-device.mjs <serial> <port> <rust.wasm>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [serial, portArg, wasmPath] = process.argv.slice(2);
const port = Number(portArg);
const PKG = "com.anywecon.selis";
const adb = (args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

adb(["shell", "am", "force-stop", PKG]);
adb(["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
let ws;
for (let i = 0; ; i++) {
  try {
    const pid = adb(["shell", "pidof", PKG]).trim();
    const socket = new RegExp(`@(webview_devtools_remote_${pid})`).exec(adb(["shell", "cat", "/proc/net/unix"]))?.[1];
    if (pid && socket) {
      adb(["forward", `tcp:${port}`, `localabstract:${socket}`]);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        break;
      }
    }
  } catch {}
  if (i > 60) throw new Error("no devtools");
  await sleep(500);
}
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const evaluate = (expression) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });

const cvSource = readFileSync(new URL("../opencv/opencv.js", import.meta.url), "utf8");
const core = readFileSync(new URL("./bench-core.js", import.meta.url), "utf8");
const wasm = readFileSync(wasmPath).toString("base64");
const t0 = Date.now();
const load = await evaluate(`(function(){ ${cvSource}\n; return typeof window.cv; })()`);
console.error("opencv loaded", JSON.stringify(load.result), Date.now() - t0, "ms");
const reply = await evaluate(`(async () => { ${core}\n const bytes = Uint8Array.from(atob("${wasm}"), c => c.charCodeAt(0)); return selisBench(window.cv, bytes, { iterations: 200 }); })()`);
if (reply.result?.exceptionDetails || reply.exceptionDetails) console.log(JSON.stringify(reply.result?.exceptionDetails ?? reply.exceptionDetails));
else console.log(JSON.stringify(reply.result.result.value));
ws.close();
adb(["forward", "--remove", `tcp:${port}`]);
