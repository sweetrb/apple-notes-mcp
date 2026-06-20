import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests live under test/ and run against real Notes.app.
// They are NOT part of the default `npm test` (unit) run — invoke them
// explicitly with `npm run test:integration` (or `npm run test:all`).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
