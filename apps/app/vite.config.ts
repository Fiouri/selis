import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import tauriConf from "./src-tauri/tauri.conf.json" with { type: "json" };

/**
 * The mock (browser) build gets the same CSP as the Tauri app, as a <meta>, so
 * Playwright exercises the worker + WASM under the production policy. Only
 * blob: is added (mock documents are blob URLs); frame-ancestors is header-only.
 */
function mockCsp(): Plugin {
  const directives = Object.entries(tauriConf.app.security.csp)
    .filter(([name]) => name !== "frame-ancestors")
    .map(([name, value]) => (name === "connect-src" ? `${name} ${value} blob:` : `${name} ${value}`));
  return {
    name: "selis-mock-csp",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: directives.join("; ") }, injectTo: "head-prepend" },
    ],
  };
}

// Set by `tauri dev` / `tauri android dev` so a device can reach the dev server.
const host = process.env.TAURI_DEV_HOST;
const platform = process.env.TAURI_ENV_PLATFORM;

export default defineConfig(({ mode, command }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "mock" && command === "build" ? [mockCsp()] : [])],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    // Browser-only build with an in-memory backend (Playwright, UI work without Rust).
    __SELIS_MOCK_IPC__: JSON.stringify(mode === "mock"),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: "ws", host, port: 5183 } } : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },
  worker: {
    format: "es",
  },
  build: {
    // The mock (Playwright) build never shares an output folder with the Tauri bundle:
    // a concurrent e2e run must not end up inside an APK.
    outDir: mode === "mock" ? "dist-mock" : "dist",
    // Android WebView / WKWebView (iOS 15+) / WebView2 all support ES2022.
    target: platform === "windows" ? "chrome105" : ["es2022", "safari15"],
    sourcemap: mode !== "production" ? true : false,
    chunkSizeWarningLimit: 1500,
  },
}));
