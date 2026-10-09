import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  define: { __SELIS_MOCK_IPC__: "true", __APP_VERSION__: JSON.stringify("0.0.0-test") },
  test: {
    name: "app",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
