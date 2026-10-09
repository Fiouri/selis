import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// Set by `tauri dev` / `tauri android dev` so a device can reach the dev server.
const host = process.env.TAURI_DEV_HOST;
const platform = process.env.TAURI_ENV_PLATFORM;

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
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
    // Android WebView / WKWebView (iOS 15+) / WebView2 all support ES2022.
    target: platform === "windows" ? "chrome105" : ["es2022", "safari15"],
    sourcemap: mode !== "production" ? true : false,
    chunkSizeWarningLimit: 1500,
  },
}));
