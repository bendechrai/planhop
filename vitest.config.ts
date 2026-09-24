import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds dist/ (for the end-to-end tests) and regenerates docs/choose.js (for the page's model tests)
    globalSetup: ["test/global-setup.ts"],
  },
});
