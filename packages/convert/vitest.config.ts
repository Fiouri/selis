import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "convert",
    // DOMParser, document.implementation: the converters run in the WebView.
    environment: "jsdom",
    testTimeout: 60_000,
  },
});
