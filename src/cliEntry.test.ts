import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const sourceDir = dirname(entryPath);
const pureModules = new Set([entryPath, join(sourceDir, "cli.ts"), join(sourceDir, "cliEntry.ts")]);
const runtimeSentinel = "RUNTIME_MODULE_EVALUATED";
let fixtureDir: string;
let bundlePath: string;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "apple-notes-cli-entry-"));
  mkdirSync(join(fixtureDir, "build"));
  bundlePath = join(fixtureDir, "build", "index.mjs");
  writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(fixtureDir, "invalid-config.json"), "{ invalid configuration");
  // Build the real executable. Every runtime source module fails as soon as it
  // evaluates, so these child processes cannot reach Notes, stores, or servers.
  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    plugins: [
      {
        name: "forbid-runtime-initialization",
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
            if (!path.startsWith(`${sourceDir}/`) || pureModules.has(path)) return;
            return {
              contents: `throw new Error("${runtimeSentinel}");\n${readFileSync(path, "utf8")}`,
              loader: "ts",
            };
          });
        },
      },
    ],
  });
}, 30_000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, APPLE_NOTES_MCP_CONFIG_FILE: join(fixtureDir, "invalid-config.json") },
  });
}

describe("bundled CLI exits before runtime initialization", () => {
  it.each([
    ["--help"],
    ["-h"],
    ["help"],
    ["setup", "--help"],
    ["setup", "--public-helper", "--check", "--help"],
    ["setup", "--permissions", "--probe-automation", "--open", "-h"],
  ])("prints help without evaluating runtime modules: %j", (...args) => {
    const result = run(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: apple-notes-mcp/);
    expect(result.stderr).toBe("");
  });

  it.each(["--version", "-v"])("prints %s without reading user configuration", (arg) => {
    const result = run([arg]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["setup", "--broker"],
    ["setup", "--broker", "--help"],
    ["setup", "--public-helper", "--native-helper"],
    ["setup", "--open"],
    ["setpu"],
    ["--help", "--broker"],
  ])("rejects invalid arguments before runtime initialization: %j", (...args) => {
    const result = run(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: apple-notes-mcp");
    expect(result.stderr).not.toMatch(/RUNTIME_MODULE_EVALUATED|Failed to load/);
  });

  it.each([
    [],
    ["setup"],
    ["setup", "--check"],
    ["setup", "--public-helper", "--check"],
    ["setup", "--native-helper", "--check"],
    ["setup", "--permissions-window", "--check"],
    ["setup", "--permissions", "--check"],
    ["templates", "--help"],
    ["anchors", "--help"],
  ])("preserves valid runtime routes: %j", (...args) => {
    const result = run(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(runtimeSentinel);
  });
});
