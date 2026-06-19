import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadFileConfig, fileConfigPath } from "@/services/fileConfig.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anmcp-cfg-"));
  file = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadFileConfig (#24)", () => {
  it("applies file values for keys not already in env", () => {
    writeFileSync(file, JSON.stringify({ APPLE_NOTES_MCP_MAX_BUFFER: "1048576", DEBUG: "1" }));
    const env: NodeJS.ProcessEnv = {};
    const applied = loadFileConfig(env, file);
    expect(env.APPLE_NOTES_MCP_MAX_BUFFER).toBe("1048576");
    expect(env.DEBUG).toBe("1");
    expect(applied.sort()).toEqual(["APPLE_NOTES_MCP_MAX_BUFFER", "DEBUG"]);
  });

  it("never overrides a value already set in the environment", () => {
    writeFileSync(file, JSON.stringify({ APPLE_NOTES_MCP_MAX_BUFFER: "1" }));
    const env: NodeJS.ProcessEnv = { APPLE_NOTES_MCP_MAX_BUFFER: "999" };
    loadFileConfig(env, file);
    expect(env.APPLE_NOTES_MCP_MAX_BUFFER).toBe("999");
  });

  it("treats empty-string env as unset and fills it", () => {
    writeFileSync(file, JSON.stringify({ DEBUG: "1" }));
    const env: NodeJS.ProcessEnv = { DEBUG: "" };
    loadFileConfig(env, file);
    expect(env.DEBUG).toBe("1");
  });

  it("ignores non-string values", () => {
    writeFileSync(file, JSON.stringify({ A: "ok", B: 5, C: true }));
    const env: NodeJS.ProcessEnv = {};
    expect(loadFileConfig(env, file)).toEqual(["A"]);
  });

  it("tolerates a missing file and a corrupt file", () => {
    expect(loadFileConfig({}, join(dir, "nope.json"))).toEqual([]);
    writeFileSync(file, "{ not json");
    expect(loadFileConfig({}, file)).toEqual([]);
  });

  it("defaults the path to the app-support dir, honoring the override", () => {
    expect(fileConfigPath({})).toMatch(/apple-notes-mcp\/config\.json$/);
    expect(fileConfigPath({ APPLE_NOTES_MCP_CONFIG_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });
});
