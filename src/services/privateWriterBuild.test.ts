/**
 * `setup --native-writer` tests. Every external command is faked through the
 * injected spawn, so no compiler runs; the fake "compiler" writes a stand-in
 * binary at the requested output path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_BINARY_NAME, MANIFEST_NAME, sha256Hex } from "./privateHelper.js";
import { WRITER_ACTIONS, WRITER_MANIFEST_NAME, defaultWriterDeps } from "./privateWriter.js";
import {
  buildPrivateWriter,
  defaultWriterBuildDeps,
  formatWriterBuild,
} from "./privateWriterBuild.js";
import type { HelperBuildDeps } from "./privateHelperBuild.js";

const SOURCE = "// writer source\n";
const SOURCE_SHA = sha256Hex(SOURCE);

let root: string;
let installDir: string;
let sourcePath: string;
let calls: { command: string; args: string[] }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-writer-build-"));
  installDir = join(root, "install");
  sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, SOURCE);
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Outcome = { status: number; stdout?: string; stderr?: string };

const HELLO = {
  status: "ok",
  protocolVersion: 1,
  sourceSha256: SOURCE_SHA,
  role: "writer",
  readOnly: false,
  actions: Object.keys(WRITER_ACTIONS),
};

function deps(overrides: Record<string, Outcome | undefined> = {}): HelperBuildDeps {
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
              : "writer";
    const override = overrides[key];
    if (key === "compile" && (!override || override.status === 0))
      writeFileSync(args[args.indexOf("-o") + 1], "fake writer binary");
    if (override)
      return {
        status: override.status,
        stdout: override.stdout ?? "",
        stderr: override.stderr ?? "",
      };
    if (key === "version")
      return { status: 0, stdout: "Apple clang version 21.0.0\nTarget: arm64", stderr: "" };
    if (key === "writer") return { status: 0, stdout: JSON.stringify(HELLO), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  return {
    ...defaultWriterDeps({
      env: { APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir },
      platform: "darwin",
      sourcePath,
      spawn,
    }),
    osVersion: () => "27.2",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
  };
}

describe("defaultWriterBuildDeps", () => {
  it("points at the writer source, not the read-only helper's", () => {
    expect(defaultWriterBuildDeps().sourcePath).toMatch(
      /native\/private-helper\/apple-notes-private-writer\.m$/
    );
  });
});

describe("buildPrivateWriter", () => {
  it("builds, signs, handshakes, and installs next to its own manifest", () => {
    const report = buildPrivateWriter(false, deps());
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
    expect(report.steps[4].detail).toMatch(/write actions: .*append_plain_text/);
    const manifest = JSON.parse(readFileSync(join(installDir, WRITER_MANIFEST_NAME), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      protocolVersion: 1,
      sourceSha256: SOURCE_SHA,
      binarySha256: sha256Hex("fake writer binary"),
    });
    expect(calls.find((c) => c.command === "/usr/bin/codesign")?.args).toContain(
      "apple-notes-mcp.private-writer"
    );
    // The read-only helper's files are untouched.
    expect(existsSync(join(installDir, MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(installDir, HELPER_BINARY_NAME))).toBe(false);
    expect(readdirSync(installDir).filter((f) => f.startsWith(".staging"))).toEqual([]);
    expect(formatWriterBuild(report)).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
  });

  it("reports the installed state with checkOnly", () => {
    const missing = buildPrivateWriter(true, deps());
    expect(missing.ok).toBe(false);
    expect(formatWriterBuild(missing)).toMatch(/setup --native-writer/);
    buildPrivateWriter(false, deps());
    expect(buildPrivateWriter(true, deps()).ok).toBe(true);
  });

  it("fails closed at each step", () => {
    expect(buildPrivateWriter(false, { ...deps(), platform: "linux" }).steps[0].step).toBe(
      "platform"
    );
    expect(buildPrivateWriter(false, { ...deps(), sourcePath: join(root, "missing.m") }).ok).toBe(
      false
    );
    expect(buildPrivateWriter(false, deps({ find: { status: 1 } })).steps.at(-1)?.step).toBe(
      "find compiler"
    );
    expect(
      buildPrivateWriter(false, deps({ compile: { status: 1, stderr: "boom" } })).steps.at(-1)
    ).toMatchObject({ step: "compile", ok: false, detail: "boom" });
    expect(buildPrivateWriter(false, deps({ codesign: { status: 1 } })).steps.at(-1)?.step).toBe(
      "ad-hoc sign"
    );
    const failed = buildPrivateWriter(false, deps({ codesign: { status: 1 } }));
    expect(formatWriterBuild(failed)).toMatch(/was not installed/);
  });

  it("refuses a read-only helper, another source, or a different action table", () => {
    const readOnly = JSON.stringify({ ...HELLO, role: undefined, readOnly: true });
    expect(buildPrivateWriter(false, deps({ writer: { status: 0, stdout: readOnly } })).ok).toBe(
      false
    );
    const wrongSource = JSON.stringify({ ...HELLO, sourceSha256: "x" });
    expect(
      buildPrivateWriter(false, deps({ writer: { status: 0, stdout: wrongSource } })).steps.at(-1)
    ).toMatchObject({ step: "handshake", ok: false });
    const extra = JSON.stringify({ ...HELLO, actions: [...HELLO.actions, "drop_table"] });
    expect(
      buildPrivateWriter(false, deps({ writer: { status: 0, stdout: extra } })).steps.at(-1)?.detail
    ).toMatch(/unknown: drop_table/);
    const fewer = JSON.stringify({ ...HELLO, actions: ["hello"] });
    expect(
      buildPrivateWriter(false, deps({ writer: { status: 0, stdout: fewer } })).steps.at(-1)?.detail
    ).toMatch(/missing: probe/);
    expect(existsSync(join(installDir, WRITER_MANIFEST_NAME))).toBe(false);
  });
});
