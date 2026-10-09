import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

/**
 * Smoke tests of the real UI bundle in mobile viewports, with the in-memory
 * mock backend (`vite build --mode mock`) instead of Rust. The mock build
 * carries the same strict CSP as the Tauri app.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "pixel-7", use: { ...devices["Pixel 7"] } },
    { name: "iphone-15", use: { ...devices["iPhone 15"] } },
  ],
  webServer: {
    command: `npm run build:mock && npm run preview:mock`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
