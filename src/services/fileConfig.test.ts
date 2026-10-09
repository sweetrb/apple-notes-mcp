import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadFileConfig, fileConfigPath } from "@/services/fileConfig.js";

vi.mock("fs", { spy: true });

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anmcp-cfg-"));
  file = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadFileConfig (#24)", () => {
  it.each(["default", "environment override", "explicit argument"])(
    "never reads a %s config in a brokered child",
    (source) => {
      writeFileSync(
        file,
        JSON.stringify({
          APPLE_NOTES_MCP_PUBLIC_HELPER_DIR: "/attacker/helper",
          APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
          APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS: "1",
          APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1",
          NODE_OPTIONS: "--import=/attacker/code.js",
        })
      );
      const env: NodeJS.ProcessEnv = { APPLE_NOTES_MCP_BROKERED: "1" };
      if (source === "environment override") env.APPLE_NOTES_MCP_CONFIG_FILE = file;
      const before = { ...env };
      vi.mocked(existsSync).mockClear();
      vi.mocked(readFileSync).mockClear();
      expect(loadFileConfig(env, source === "explicit argument" ? file : undefined)).toEqual([]);
      expect(env).toEqual(before);
      expect(existsSync).not.toHaveBeenCalled();
      expect(readFileSync).not.toHaveBeenCalled();
    }
  );

  it("still loads config when the brokered marker is not enabled", () => {
    writeFileSync(file, JSON.stringify({ APPLE_NOTES_MCP_TIMEOUT_MS: "45000" }));
    const env: NodeJS.ProcessEnv = { APPLE_NOTES_MCP_BROKERED: "0" };
    expect(loadFileConfig(env, file)).toEqual(["APPLE_NOTES_MCP_TIMEOUT_MS"]);
    expect(env.APPLE_NOTES_MCP_TIMEOUT_MS).toBe("45000");
  });

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
