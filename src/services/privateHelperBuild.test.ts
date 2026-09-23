/**
 * `setup --native-helper` tests. Every external command is faked through the
 * injected spawn, so no compiler runs; the fake "compiler" writes a stand-in
 * binary at the requested output path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDeps, sha256Hex } from "./privateHelper.js";
import {
  buildPrivateHelper,
  compileArguments,
  defaultBuildDeps,
  formatHelperBuild,
  type HelperBuildDeps,
} from "./privateHelperBuild.js";

const SOURCE = "// helper source\n";
const SOURCE_SHA = sha256Hex(SOURCE);

interface Call {
  command: string;
  args: string[];
}

let root: string;
let installDir: string;
let sourcePath: string;
let calls: Call[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-helper-build-"));
  installDir = join(root, "install");
  sourcePath = join(root, "helper.m");
  writeFileSync(sourcePath, SOURCE);
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Outcome = { status: number; stdout?: string; stderr?: string };

function deps(overrides: Record<string, Outcome | undefined> = {}, env = {}): HelperBuildDeps {
  const spawn = ((command: string, args: string[] = []) => {
    calls.push({ command, args });
    const key =
      command === "/usr/bin/codesign"
        ? "codesign"
        : args[0] === "--find"
          ? "find"
          : args[1] === "--version"
            ? "version"
            : args[0] === "clang"
              ? "compile"
              : "helper";
    const override = overrides[key];
    if (key === "compile" && (!override || override.status === 0))
      writeFileSync(args[args.indexOf("-o") + 1], "fake binary");
    if (override)
      return {
        status: override.status,
        stdout: override.stdout ?? "",
        stderr: override.stderr ?? "",
      };
    if (key === "version")
      return { status: 0, stdout: "Apple clang version 21.0.0\nTarget: arm64", stderr: "" };
    if (key === "helper")
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "ok",
          protocolVersion: 1,
          sourceSha256: SOURCE_SHA,
          readOnly: true,
          actions: ["hello"],
        }),
        stderr: "",
      };
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  return {
    ...defaultDeps({
      env: { APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir, ...env },
      platform: "darwin",
      sourcePath,
      spawn,
    }),
    osVersion: () => "27.2",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
  };
}

describe("defaultBuildDeps", () => {
  it("reads the macOS version and the clock from the real system", () => {
    const real = defaultBuildDeps();
    expect(real.osVersion()).toMatch(/^\d+\.\d+|^Darwin /);
    expect(real.now()).toBeInstanceOf(Date);
    expect(real.sourcePath).toMatch(/native\/private-helper\/apple-notes-private-helper\.m$/);
  });
});

describe("compileArguments", () => {
  it("links only public frameworks and embeds the source digest", () => {
    const args = compileArguments("/s.m", "/out", SOURCE_SHA);
    expect(args[0]).toBe("clang");
    expect(args).toContain("-fobjc-arc");
    expect(args).not.toContain("NotesShared");
    expect(args).toContain(`-DHELPER_SOURCE_SHA256="${SOURCE_SHA}"`);
    expect(args.slice(-3)).toEqual(["-o", "/out", "/s.m"]);
  });
});

describe("buildPrivateHelper", () => {
  it("builds, signs, handshakes, and installs with a manifest", () => {
    const report = buildPrivateHelper(false, deps());
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.step)).toEqual([
      "locate source",
      "find compiler",
      "compile",
      "ad-hoc sign",
      "handshake",
      "install",
      "verify installation",
    ]);
    const manifest = JSON.parse(readFileSync(join(installDir, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      schemaVersion: 1,
      protocolVersion: 1,
      sourceSha256: SOURCE_SHA,
      binarySha256: sha256Hex("fake binary"),
      builtAt: "2026-09-23T12:00:00.000Z",
      osVersion: "27.2",
      compiler: "Apple clang version 21.0.0",
    });
    expect(report.installation.ready).toBe(true);
    expect(calls.find((c) => c.command === "/usr/bin/codesign")?.args).toEqual([
      "--force",
      "--sign",
      "-",
      "--identifier",
      "apple-notes-mcp.private-helper",
      expect.stringMatching(/\.staging-.*\/apple-notes-private-helper$/),
    ]);
    // The staging directory is removed.
    expect(readdirSync(installDir).sort()).toEqual(["apple-notes-private-helper", "manifest.json"]);
  });

  it("only inspects in check mode", () => {
    const missing = buildPrivateHelper(true, deps());
    expect(missing.ok).toBe(false);
    expect(calls).toEqual([]);
    buildPrivateHelper(false, deps());
    const present = buildPrivateHelper(true, deps());
    expect(present.ok).toBe(true);
    expect(present.steps[0].detail).toMatch(/apple-notes-private-helper$/);
  });

  it("refuses other platforms", () => {
    const report = buildPrivateHelper(false, { ...deps(), platform: "linux" });
    expect(report).toMatchObject({ ok: false, steps: [{ step: "platform", ok: false }] });
  });

  it("reports a missing packaged source", () => {
    rmSync(sourcePath);
    expect(buildPrivateHelper(false, deps()).steps).toEqual([
      { step: "locate source", ok: false, detail: sourcePath },
    ]);
  });

  it("points at the Command Line Tools when clang is missing", () => {
    const report = buildPrivateHelper(false, deps({ find: { status: 1 } }));
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toMatch(/xcode-select --install/);
  });

  it("falls back to a generic compiler name", () => {
    const report = buildPrivateHelper(false, deps({ version: { status: 0, stdout: "" } }));
    expect(report.steps[1].detail).toBe("clang");
  });

  it("reports compiler errors and leaves nothing installed", () => {
    const report = buildPrivateHelper(
      false,
      deps({ compile: { status: 1, stderr: "error: boom" } })
    );
    expect(report.steps.at(-1)).toEqual({ step: "compile", ok: false, detail: "error: boom" });
    expect(existsSync(join(installDir, "apple-notes-private-helper"))).toBe(false);
    expect(readdirSync(installDir)).toEqual([]);
  });

  it("falls back to generic messages when tools print nothing", () => {
    const compile = buildPrivateHelper(false, deps({ compile: { status: 1 } }));
    expect(compile.steps.at(-1)).toEqual({ step: "compile", ok: false, detail: "clang failed" });
    const sign = buildPrivateHelper(false, deps({ codesign: { status: 1 } }));
    expect(sign.steps.at(-1)).toEqual({
      step: "ad-hoc sign",
      ok: false,
      detail: "codesign failed",
    });
  });

  it("reports a signing failure", () => {
    const report = buildPrivateHelper(false, deps({ codesign: { status: 1, stderr: "nope" } }));
    expect(report.steps.at(-1)).toEqual({ step: "ad-hoc sign", ok: false, detail: "nope" });
  });

  it("reports a helper that fails its handshake", () => {
    const report = buildPrivateHelper(false, deps({ helper: { status: 1, stdout: "" } }));
    expect(report.steps.at(-1)).toMatchObject({ step: "handshake", ok: false });
  });

  it("refuses a helper that does not report read-only or offers a write action", () => {
    const notReadOnly = JSON.stringify({
      status: "ok",
      protocolVersion: 1,
      sourceSha256: SOURCE_SHA,
      actions: ["hello"],
    });
    const a = buildPrivateHelper(false, deps({ helper: { status: 0, stdout: notReadOnly } }));
    expect(a.ok).toBe(false);
    expect(a.steps.at(-1)).toMatchObject({ step: "handshake", ok: false });
    const writer = JSON.stringify({
      status: "ok",
      protocolVersion: 1,
      sourceSha256: SOURCE_SHA,
      readOnly: true,
      actions: ["hello", "append_plain_text"],
    });
    const b = buildPrivateHelper(false, deps({ helper: { status: 0, stdout: writer } }));
    expect(b.ok).toBe(false);
    expect(b.steps.at(-1)).toMatchObject({
      step: "handshake",
      ok: false,
      detail: expect.stringMatching(/append_plain_text/),
    });
  });

  it("refuses a helper reporting another source or protocol", () => {
    const wrong = JSON.stringify({
      status: "ok",
      protocolVersion: 1,
      sourceSha256: "x",
      readOnly: true,
      actions: [],
    });
    const report = buildPrivateHelper(false, deps({ helper: { status: 0, stdout: wrong } }));
    expect(report.steps.at(-1)).toMatchObject({
      step: "handshake",
      ok: false,
      detail: "helper reported protocol 1, source x",
    });
    expect(existsSync(join(installDir, "manifest.json"))).toBe(false);
  });
});

describe("formatHelperBuild", () => {
  it("summarises success with the opt-in reminder", () => {
    const text = formatHelperBuild(buildPrivateHelper(false, deps()));
    expect(text).toMatch(/✓ compile/);
    expect(text).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE=1/);
  });

  it("tells a check-only run how to build", () => {
    expect(formatHelperBuild(buildPrivateHelper(true, deps()))).toMatch(
      /Run `apple-notes-mcp setup --native-helper`/
    );
  });

  it("explains a failed build", () => {
    const text = formatHelperBuild(buildPrivateHelper(false, deps({ find: { status: 1 } })));
    expect(text).toMatch(/✗ find compiler/);
    expect(text).toMatch(/was not installed/);
  });
});
