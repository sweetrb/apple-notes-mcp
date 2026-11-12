/**
 * Security regression: child processes are spawned by absolute path.
 *
 * A bare name (`execFileSync("sqlite3", ...)`) is resolved through the server's
 * PATH, so a writable directory early in PATH could substitute its own
 * `osascript` or `sqlite3` and see every query and script the server runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { osascriptPath } from "@/utils/systemBinaries.js";

const SRC = resolve(__dirname, "..");
const SPAWN = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*(["'`])([^"'`]*)\1/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe("spawned binaries", () => {
  const saved = process.env.APPLE_NOTES_MCP_TEST_OSASCRIPT;
  afterEach(() => {
    if (saved === undefined) delete process.env.APPLE_NOTES_MCP_TEST_OSASCRIPT;
    else process.env.APPLE_NOTES_MCP_TEST_OSASCRIPT = saved;
  });

  it("names every literal command by absolute path", () => {
    const bare: string[] = [];
    for (const file of sources(SRC)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(SPAWN)) {
        if (!m[2].startsWith("/")) bare.push(`${file.slice(SRC.length + 1)}: ${m[2]}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("runs /usr/bin/osascript unless the test override is set", () => {
    delete process.env.APPLE_NOTES_MCP_TEST_OSASCRIPT;
    expect(osascriptPath()).toBe("/usr/bin/osascript");
    process.env.APPLE_NOTES_MCP_TEST_OSASCRIPT = "/tmp/fake-osascript";
    expect(osascriptPath()).toBe("/tmp/fake-osascript");
  });
});
