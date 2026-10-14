import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "ocr",
    environment: "node",
    testTimeout: 180_000,
  },
});
