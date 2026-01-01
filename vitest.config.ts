import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
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
