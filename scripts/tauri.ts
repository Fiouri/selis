/**
 * `npm run tauri -- …`: the Tauri CLI with the native build settings that depend on where the
 * Android NDK lives (ADR 0015).
 *
 * qpdf-sys generates its Rust bindings with bindgen for targets it has none for (Android, iOS).
 * bindgen asks a `clang` for the target's system headers: for Android that must be the NDK's
 * clang, which knows the NDK sysroot. When `NDK_HOME` is set and `CLANG_PATH` is not, this
 * points `CLANG_PATH` at it. (libclang itself is found by clang-sys: LLVM on the developer
 * machine, the runner's LLVM in CI.) Everything else passes through unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const env = { ...process.env };
const ndk = env.NDK_HOME;
if (ndk && !env.CLANG_PATH) {
  const host = process.platform === "win32" ? "windows-x86_64" : process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
  const clang = join(ndk, "toolchains", "llvm", "prebuilt", host, "bin", process.platform === "win32" ? "clang.exe" : "clang");
  if (existsSync(clang)) env.CLANG_PATH = clang;
}

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js", { paths: [join(import.meta.dirname, "..", "apps", "app")] });
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
