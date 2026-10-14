import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "scan",
    environment: "node",
    testTimeout: 60_000,
  },
});
