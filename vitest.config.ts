import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests that load the server entry point must never reach a permission
    // broker installed on the developer's Mac.
    // Nor may they depend on the host's Notes build (#337): tests that cover the
    // Notes Markdown-intent detection inject its metadata explicitly.
    env: { APPLE_NOTES_MCP_BROKER: "off", APPLE_NOTES_MCP_IGNORE_NOTES_INTENTS: "1" },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      exclude: [
        "node_modules/",
        "build/",
        "**/*.test.ts",
        "scripts/",
        "*.config.*",
        ".eslintrc.cjs",
      ],
      // Coverage thresholds - fail CI if not met
      thresholds: {
        // Per-file thresholds for core modules
        "src/services/**/*.ts": {
          statements: 80,
          branches: 80,
          functions: 90,
          lines: 80,
        },
        "src/utils/**/*.ts": {
          statements: 90,
          branches: 75,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
