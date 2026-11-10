/**
 * Install docs must not pin an exact package version (#328).
 *
 * The README and docs/ once told every client to run `apple-notes-mcp@2.15.1`.
 * Nothing updated that pin, so new users installed a release several versions
 * old, and a macOS 12 reporter kept hitting a bug (#325) that 2.16.2 had already
 * fixed. Examples use `@latest`; explaining how to pin uses the `X.Y.Z`
 * placeholder. CHANGELOG.md is exempt because version numbers are its content.
 *
 * Reads files from disk only; no server boot, no Notes.app, no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(__dirname, "..");
const PINNED = /apple-notes-mcp@\d+\.\d+\.\d+/gu;

function shippedDocs(): string[] {
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f));
  return ["README.md", "CLAUDE.md", ...docs];
}

describe("install docs do not pin an exact version", () => {
  it.each(shippedDocs())("%s", (file) => {
    const hits = readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .flatMap((line, i) => (line.match(PINNED) ?? []).map((m) => `${file}:${i + 1} ${m}`));
    expect(hits).toEqual([]);
  });
});
