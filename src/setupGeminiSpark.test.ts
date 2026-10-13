import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatGeminiSparkSetup, GEMINI_SPARK_LOCAL_MCP } from "./setupGeminiSpark.js";

const server = resolve(__dirname, "../build/index.js");
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runBuiltGuide(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-spark-setup-"));
  temporaryDirectories.push(dir);
  const config = join(dir, "invalid-config.json");
  writeFileSync(config, "{invalid JSON");
  return spawnSync(process.execPath, [server, "setup", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, HOME: dir, APPLE_NOTES_MCP_CONFIG_FILE: config },
  });
}

describe("Gemini Spark Local MCP setup guide", () => {
  it("keeps the README's exact form fields and command aligned with the guide", () => {
    const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");
    const section = readme.split("#### Gemini Spark (macOS Local MCP)\n")[1].split("\n#### ")[0];
    for (const value of Object.values(GEMINI_SPARK_LOCAL_MCP)) {
      expect(formatGeminiSparkSetup()).toContain(value);
      expect(section).toContain(value);
    }
    expect(section).toContain("setup --gemini-spark");
    expect(formatGeminiSparkSetup()).toContain("This server provides local stdio only");
    expect(formatGeminiSparkSetup()).toContain("does not verify a connection");
  });

  it.each([["--gemini-spark"], ["--gemini-spark", "--help"], ["--gemini-spark", "-h"]])(
    "the built command prints %j before reading server configuration",
    (...args) => {
      const result = runBuiltGuide(args);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${formatGeminiSparkSetup()}\n`);
      expect(result.stderr).toBe("");
    }
  );

  it.each([
    "--broker",
    "--uninstall",
    "--public-helper",
    "--native-helper",
    "--permissions-window",
    "--permissions",
    "--check",
    "--open",
  ])(
    "the built command refuses %s before helper builds, probes, or Shortcut imports",
    (otherTarget) => {
      const result = runBuiltGuide([otherTarget, "--gemini-spark"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/one setup target|cannot be combined/);
      expect(result.stderr).not.toContain("Failed to load");
    }
  );
});
