import { describe, expect, it } from "vitest";
import { CLI_USAGE, SETUP_USAGE, parseCliArgs } from "./cli.js";

describe("CLI routing before effects", () => {
  it("keeps the no-argument stdio entry point", () => {
    expect(parseCliArgs([])).toEqual({ kind: "mcp" });
  });

  it.each(["--help", "-h", "help"])("routes %s to help, not MCP", (arg) => {
    expect(parseCliArgs([arg])).toEqual({ kind: "help", topic: "main" });
  });

  it.each(["--version", "-v"])("routes %s to the package version", (arg) => {
    expect(parseCliArgs([arg])).toEqual({ kind: "version" });
  });

  it.each(["--help", "-h"])("setup %s never selects a setup action", (arg) => {
    expect(parseCliArgs(["setup", arg])).toEqual({ kind: "help", topic: "setup" });
    expect(parseCliArgs(["setup", "--public-helper", arg])).toEqual({
      kind: "help",
      topic: "setup",
    });
  });

  it.each(["--publc-helper", "something"])(
    "rejects setup %s instead of importing Shortcuts",
    (arg) => {
      expect(() => parseCliArgs(["setup", arg])).toThrow("Unknown setup option");
      expect(() => parseCliArgs(["setup", "--public-helper", arg])).toThrow("Unknown setup option");
    }
  );

  it("rejects mixed setup targets and misplaced options before effects", () => {
    expect(() => parseCliArgs(["setup", "--native-helper", "--public-helper"])).toThrow(
      "one setup target"
    );
    for (const arg of ["--json", "--open", "--once", "--window", "--probe-automation"])
      expect(() => parseCliArgs(["setup", arg])).toThrow("requires setup --permissions");
    expect(() => parseCliArgs(["setup", "--permissions-window", "--window"])).toThrow(
      "requires setup --permissions"
    );
  });

  it.each(["public-helper", "native-helper", "permissions-window", "permissions", "broker"])(
    "preserves the %s target and read-only check flag",
    (target) => {
      expect(parseCliArgs(["setup", `--${target}`, "--check"])).toMatchObject({
        kind: "setup",
        target,
        checkOnly: true,
      });
    }
  );

  it("preserves Shortcut setup and all permission options", () => {
    expect(parseCliArgs(["setup"])).toEqual({
      kind: "setup",
      target: "shortcuts",
      args: [],
      checkOnly: false,
    });
    const args = [
      "--permissions",
      "--json",
      "--once",
      "--open",
      "--window",
      "--probe-automation",
      "--check",
    ];
    expect(parseCliArgs(["setup", ...args])).toEqual({
      kind: "setup",
      target: "permissions",
      args,
      checkOnly: true,
    });
  });

  it("preserves broker options and requires their target and identity value", () => {
    const args = [
      "--broker",
      "--sign-identity",
      "Developer ID Application: Test (TEAM)",
      "--check",
    ];
    expect(parseCliArgs(["setup", ...args])).toEqual({
      kind: "setup",
      target: "broker",
      args,
      checkOnly: true,
    });
    expect(parseCliArgs(["setup", "--broker", "--uninstall"])).toMatchObject({ target: "broker" });
    for (const args of [
      ["--uninstall"],
      ["--sign-identity", "Test"],
      ["--public-helper", "--uninstall"],
    ])
      expect(() => parseCliArgs(["setup", ...args])).toThrow("require setup --broker");
    for (const value of [undefined, "", "--check"])
      expect(() =>
        parseCliArgs([
          "setup",
          "--broker",
          "--sign-identity",
          ...(value === undefined ? [] : [value]),
        ])
      ).toThrow("requires a signing identity");
    expect(() => parseCliArgs(["setup", "--broker", "--public-helper"])).toThrow(
      "one setup target"
    );
    expect(() => parseCliArgs(["setup", "--broker", "--open"])).toThrow(
      "requires setup --permissions"
    );
  });

  it.each([["--gemini-spark"], ["--gemini-spark", "--help"], ["--gemini-spark", "-h"]])(
    "routes the Gemini Spark guide %j before runtime setup",
    (...args) => {
      expect(parseCliArgs(["setup", ...args])).toEqual({
        kind: "setup",
        target: "gemini-spark",
        args,
        checkOnly: false,
      });
    }
  );

  it.each([
    "--check",
    "--json",
    "--open",
    "--once",
    "--window",
    "--probe-automation",
    "--uninstall",
  ])("refuses %s with the Gemini Spark guide", (arg) => {
    expect(() => parseCliArgs(["setup", "--gemini-spark", arg])).toThrow("cannot be combined");
  });

  it("rejects mixed and duplicate Gemini Spark options", () => {
    for (const target of [
      "--broker",
      "--public-helper",
      "--native-helper",
      "--permissions",
      "--permissions-window",
    ])
      expect(() => parseCliArgs(["setup", "--gemini-spark", target])).toThrow("one setup target");
    for (const args of [
      ["--gemini-spark", "--gemini-spark"],
      ["--gemini-spark", "--help", "-h"],
      ["--gemini-spark", "--sign-identity", "Test"],
    ])
      expect(() => parseCliArgs(["setup", ...args])).toThrow("cannot be combined");
  });

  it.each(["templates", "anchors"])("preserves the %s parser's complete arguments", (kind) => {
    expect(parseCliArgs([kind, "edit", "name", "--port", "8080"])).toEqual({
      kind,
      args: ["edit", "name", "--port", "8080"],
    });
  });

  it("rejects unknown top-level commands rather than silently starting MCP", () => {
    expect(() => parseCliArgs(["setpu"])).toThrow("Unknown command or option");
    expect(() => parseCliArgs(["--help", "--broker"])).toThrow("Unexpected argument");
  });

  it("documents the supported setup routes", () => {
    expect(CLI_USAGE).toContain("stdio");
    expect(SETUP_USAGE).toContain("--probe-automation");
    expect(SETUP_USAGE).toContain("--broker");
    expect(SETUP_USAGE).toContain("--gemini-spark");
    expect(SETUP_USAGE).toContain("--sign-identity <id>");
  });
});
