import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/engine", "packages/fixtures", "packages/ocr", "packages/convert", "packages/scan", "packages/ui", "apps/app", "tools", "website"],
  },
});
