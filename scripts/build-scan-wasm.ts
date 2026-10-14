/**
 * Builds the document-scan module (`crates/selis-scan`, ADR 0016) for the WebView:
 * `packages/scan/wasm/selis_scan_simd.wasm` (WebAssembly SIMD: Android WebView, iOS 16.4+,
 * desktops) and `selis_scan_base.wasm` (the same without SIMD, for iOS 15–16.3). Runs before
 * the front end is built, served or tested (npm pre-scripts); cargo makes a rebuild with no
 * change about a second. Each variant has its own target folder: their RUSTFLAGS differ.
 *
 * The module has no start function and only three imports, all wasm-bindgen machinery that
 * imageproc's random-number dependency links in and nothing calls (see `wasm.ts`); a new
 * import fails the build here instead of at run time.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const outDir = join(root, "packages", "scan", "wasm");
const EXPECTED_IMPORTS = new Set([
  "__wbindgen_placeholder__.__wbindgen_describe",
  "__wbindgen_externref_xform__.__wbindgen_externref_table_grow",
  "__wbindgen_externref_xform__.__wbindgen_externref_table_set_null",
]);
/** The runtime's WebAssembly API (this file is type-checked without the DOM library). */
type WasmModuleApi = {
  new (bytes: Uint8Array): object;
  imports: (module: object) => Array<{ module: string; name: string }>;
};
const { Module: WasmModule } = (globalThis as unknown as { WebAssembly: { Module: WasmModuleApi } }).WebAssembly;

const variants = [
  { name: "simd", rustflags: "-C target-feature=+simd128" },
  { name: "base", rustflags: "" },
];

mkdirSync(outDir, { recursive: true });
for (const variant of variants) {
  const targetDir = join(root, "target", `scan-${variant.name}`);
  const env: NodeJS.ProcessEnv = { ...process.env, RUSTFLAGS: variant.rustflags };
  // Settings meant for the app's own (native) build must not leak into this one.
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.CARGO_BUILD_TARGET;
  const cargo = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "selis-scan", "--lib", "--target", "wasm32-unknown-unknown", "--profile", "wasm", "--target-dir", targetDir],
    { cwd: root, env, stdio: "inherit" },
  );
  if (cargo.error || cargo.status !== 0) {
    console.error(
      `build-scan-wasm: cargo failed for the ${variant.name} module (is the wasm32-unknown-unknown target installed? ` +
        "rustup target add wasm32-unknown-unknown)",
    );
    process.exit(cargo.status ?? 1);
  }
  const built = join(targetDir, "wasm32-unknown-unknown", "wasm", "selis_scan.wasm");
  const bytes = readFileSync(built);
  const imports = WasmModule.imports(new WasmModule(bytes)).map((i) => `${i.module}.${i.name}`);
  const unexpected = imports.filter((name) => !EXPECTED_IMPORTS.has(name));
  if (unexpected.length > 0) {
    console.error(`build-scan-wasm: unexpected imports in the ${variant.name} module: ${unexpected.join(", ")}`);
    process.exit(1);
  }
  const target = join(outDir, `selis_scan_${variant.name}.wasm`);
  if (!existsSync(target) || !readFileSync(target).equals(bytes)) copyFileSync(built, target);
}
