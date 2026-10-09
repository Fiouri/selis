import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/engine", "packages/fixtures", "packages/ui", "apps/app", "tools"],
  },
});
