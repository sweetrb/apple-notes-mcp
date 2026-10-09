// Classify verbatim runtime assets separately from bundle-only TypeScript.
// Kept under .github/ so this release-check code is not an npm runtime asset.
import { execFileSync } from "node:child_process";

const [base, head] = process.argv.slice(2);
if (!base || !head || process.argv.length !== 4) {
  console.error("Usage: node version-guard-changes.mjs BASE_SHA HEAD_SHA");
  process.exit(2);
}

// Disabling rename detection retains the removed path too: moving a runtime
// asset to an exempt directory still removes bytes users previously received.
const changed = execFileSync("git", [
  "diff",
  "--name-only",
  "--no-renames",
  "-z",
  base + "..." + head,
])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const testDirectory = /(^|\/)(__tests__|__mocks__)\//;
const nativeTest = /(^|\/)(tests?|__tests__|__mocks__)\//;
const nativeDocumentation = /\.(md|mdx|rst)$/i;
const nativeTestFile = /\.(test|spec)\.[^/]+$/;

const shipped = changed.filter((path) => {
  if (testDirectory.test(path)) return false;
  if (path.startsWith("build/") || path === "requirements.txt") return true;
  // Preserve the existing fail-safe rule for future non-TypeScript sidecars.
  if (path.startsWith("src/")) return !path.endsWith(".ts");
  // Native sources, headers and runtime resources are shipped and used directly.
  // Keep documentation and clearly named native test fixtures exempt.
  if (path.startsWith("native/")) {
    return !nativeDocumentation.test(path) && !nativeTest.test(path) && !nativeTestFile.test(path);
  }
  return path.startsWith("shortcuts/") && path.endsWith(".shortcut");
});
const typescript = changed.filter(
  (path) =>
    path.startsWith("src/") &&
    path.endsWith(".ts") &&
    !/\.(test|spec)\.ts$/.test(path) &&
    !testDirectory.test(path)
);
const bundle = changed.filter((path) => path.startsWith("build/"));

console.log(JSON.stringify({ changed, shipped, typescript, bundle }));
