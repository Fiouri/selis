/**
 * Puts the OCR assets (P4d, ADR 0018) where the app serves them, `apps/app/public/ocr/`
 * (git-ignored; npm pre-scripts run this before the front end is built, served or tested):
 *
 * - `worker.min.js` — tesseract.js's worker script;
 * - `tesseract-core-{simd-lstm,lstm}.{js,wasm}` — the LSTM-only Tesseract cores, with and
 *   without WebAssembly SIMD (the `.wasm.js` builds that inline the module as base64 are not
 *   shipped), next to the worker script: a core loaded by importScripts looks for its `.wasm`
 *   beside the worker, not beside itself;
 * - `tessdata/{eng,ell}.traineddata.gz` — tessdata_fast models from `packages/ocr/tessdata`,
 *   checked against the SHA-256 recorded in its README.
 *
 * Plain files with fixed names (not bundled): tesseract.js loads the core with importScripts.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const out = join(root, "apps", "app", "public", "ocr");
const require = createRequire(join(root, "packages", "ocr", "package.json"));

const MODELS: Record<string, string> = {
  eng: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
  ell: "4fba8a0b461038d51f1c20d043d4f2ac38c4e778f1b90830847f7bd8fa3ba726",
};

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) return;
  copyFileSync(from, to);
}

const tesseract = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
copy(join(tesseract, "dist", "worker.min.js"), join(out, "worker.min.js"));
for (const name of ["tesseract-core-simd-lstm", "tesseract-core-lstm"]) {
  for (const ext of [".js", ".wasm"]) copy(join(core, `${name}${ext}`), join(out, `${name}${ext}`));
}
for (const [lang, sha256] of Object.entries(MODELS)) {
  const file = join(root, "packages", "ocr", "tessdata", `${lang}.traineddata.gz`);
  const actual = createHash("sha256").update(gunzipSync(readFileSync(file))).digest("hex");
  if (actual !== sha256) {
    console.error(`copy-ocr-assets: ${lang}.traineddata does not match its recorded SHA-256 (${actual})`);
    process.exit(1);
  }
  copy(file, join(out, "tessdata", `${lang}.traineddata.gz`));
}
