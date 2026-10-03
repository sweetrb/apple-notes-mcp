import type { ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPermissionsWindow,
  defaultPermissionsWindowDeps,
  formatPermissionsWindowBuild,
  inspectPermissionsWindow,
  PERMISSIONS_WINDOW_BINARY,
  PERMISSIONS_WINDOW_DIR_ENV,
  PERMISSIONS_WINDOW_MANIFEST,
  PERMISSIONS_WINDOW_PROTOCOL,
  PERMISSIONS_WINDOW_SOURCE,
  permissionsWindowCompileArguments,
  permissionsWindowInfoPlist,
  permissionsWindowInstallDir,
  runPermissionsWindow,
  type PermissionsWindowDeps,
} from "./permissionsWindow.js";
import { packageRoot, sha256Hex } from "./publicHelper.js";
import { checkPermissions, type PermissionsReport } from "./permissions.js";

type SpawnResult = ReturnType<typeof spawnSync>;
const result = (over: Partial<SpawnResult>): SpawnResult =>
  ({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...over }) as SpawnResult;

let dir: string;
let sourcePath: string;
let installDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "permissions-window-test-"));
  sourcePath = join(dir, "window.swift");
  writeFileSync(sourcePath, "// window source v1\n");
  installDir = join(dir, "install");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(
  spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => SpawnResult,
  over: Partial<PermissionsWindowDeps> = {}
): PermissionsWindowDeps {
  return {
    ...defaultPermissionsWindowDeps({ sourcePath }),
    env: { [PERMISSIONS_WINDOW_DIR_ENV]: installDir },
    platform: "darwin",
    spawn: spawn as unknown as typeof spawnSync,
    now: () => new Date("2026-09-24T00:00:00Z"),
    ...over,
  };
}

/** A fake toolchain: swiftc writes a binary, codesign succeeds, the binary answers hello. */
function toolchain(hello: (sourceSha: string) => unknown = (sha) => helloFor(sha)) {
  const calls: Array<{ cmd: string; args: readonly string[]; input?: unknown }> = [];
  const spawn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, input: opts.input });
    if (cmd === "/usr/bin/xcrun" && args[1] === "--version")
      return result({ stdout: "Apple Swift version 6.4 (swiftlang-6.4)\n" });
    if (cmd === "/usr/bin/xcrun") {
      writeFileSync(args[args.length - 1], "binary bytes");
      return result({});
    }
    if (cmd === "/usr/bin/codesign") return result({});
    const sha = sha256Hex(readFileSync(sourcePath));
    return result({ stdout: JSON.stringify(hello(sha)) + "\n" });
  };
  return { spawn, calls };
}

const helloFor = (sha: string) => ({
  type: "hello",
  protocolVersion: PERMISSIONS_WINDOW_PROTOCOL,
  sourceSha256: sha,
});

describe("packaging", () => {
  it("ships the Swift source at the documented path", () => {
    expect(existsSync(join(packageRoot(), PERMISSIONS_WINDOW_SOURCE))).toBe(true);
  });

  it("installs under Application Support unless overridden", () => {
    expect(permissionsWindowInstallDir({})).toMatch(
      /Library\/Application Support\/apple-notes-mcp\/permissions-window$/
    );
    expect(permissionsWindowInstallDir({ [PERMISSIONS_WINDOW_DIR_ENV]: "/tmp/x" })).toBe("/tmp/x");
  });

  it("pins the compiler arguments", () => {
    expect(permissionsWindowCompileArguments("s.swift", "d.swift", "p.plist", "out")).toEqual([
      "swiftc",
      "-O",
      "-parse-as-library",
      "-framework",
      "AppKit",
      "-framework",
      "SwiftUI",
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      "p.plist",
      "s.swift",
      "d.swift",
      "-o",
      "out",
    ]);
    expect(permissionsWindowInfoPlist()).toContain("apple-notes-mcp.permissions-window");
  });
});

describe("buildPermissionsWindow", () => {
  it("compiles, ad-hoc signs, handshakes without a window, and installs with a manifest", () => {
    const { spawn, calls } = toolchain();
    const report = buildPermissionsWindow(false, deps(spawn));
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
    const sign = calls.find((c) => c.cmd === "/usr/bin/codesign")!;
    expect(sign.args).toContain("-");
    const hello = calls.find((c) => c.cmd.endsWith(PERMISSIONS_WINDOW_BINARY))!;
    expect(hello.input).toBe('{"type":"hello"}\n');
    const manifest = JSON.parse(
      readFileSync(join(installDir, PERMISSIONS_WINDOW_MANIFEST), "utf8")
    ) as Record<string, unknown>;
    expect(manifest.sourceSha256).toBe(sha256Hex(readFileSync(sourcePath)));
    expect(manifest.binarySha256).toBe(sha256Hex("binary bytes"));
    expect(formatPermissionsWindowBuild(report)).toContain("setup --permissions --window");
  });

  it("refuses a handshake from a different source", () => {
    const { spawn } = toolchain(() => helloFor("0".repeat(64)));
    const report = buildPermissionsWindow(false, deps(spawn));
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ step: "handshake", ok: false });
    expect(existsSync(join(installDir, PERMISSIONS_WINDOW_BINARY))).toBe(false);
  });

  it("reports a missing compiler", () => {
    const report = buildPermissionsWindow(
      false,
      deps(() => result({ status: 1 }))
    );
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toContain("xcode-select --install");
  });

  it("does nothing off macOS", () => {
    const spawn = vi.fn();
    const report = buildPermissionsWindow(false, deps(spawn, { platform: "linux" }));
    expect(report.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("check-only mode inspects without building", () => {
    const spawn = vi.fn();
    const report = buildPermissionsWindow(true, deps(spawn));
    expect(report.ok).toBe(false);
    expect(report.installation.reason).toBe("window_not_installed");
    expect(spawn).not.toHaveBeenCalled();
    expect(formatPermissionsWindowBuild(report)).toContain("setup --permissions-window");
  });
});

describe("inspectPermissionsWindow", () => {
  function install(binary = "binary bytes", source = readFileSync(sourcePath)) {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, PERMISSIONS_WINDOW_BINARY), binary);
    writeFileSync(
      join(installDir, PERMISSIONS_WINDOW_MANIFEST),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: PERMISSIONS_WINDOW_PROTOCOL,
        sourceSha256: sha256Hex(source),
        binarySha256: sha256Hex("binary bytes"),
        builtAt: "2026-09-24T00:00:00Z",
        compiler: "swiftc",
      })
    );
  }
  const inspect = () => inspectPermissionsWindow(deps(() => result({})));

  it("is ready when source and binary match the manifest", () => {
    install();
    expect(inspect()).toMatchObject({ ready: true, reason: null });
  });

  it("is stale after the packaged source changes", () => {
    install();
    writeFileSync(sourcePath, "// window source v2\n");
    expect(inspect().reason).toBe("window_stale");
  });

  it("fails closed when the binary was replaced", () => {
    install("other bytes");
    expect(inspect().reason).toBe("window_modified");
  });

  it("rejects an unreadable manifest", () => {
    install();
    writeFileSync(join(installDir, PERMISSIONS_WINDOW_MANIFEST), "{");
    expect(inspect().reason).toBe("window_manifest_invalid");
  });
});

describe("runPermissionsWindow", () => {
  /** A stand-in for the window process: no binary runs and nothing is shown. */
  function fakeWindow() {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, { stdin, stdout });
    const received: Array<Record<string, unknown>> = [];
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean))
        received.push(JSON.parse(line) as Record<string, unknown>);
    });
    const say = (message: unknown) => stdout.write(JSON.stringify(message) + "\n");
    const close = () => {
      stdout.end();
      child.emit("close", 0, null);
    };
    return { child, received, say, close };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  const missing: PermissionsReport = checkPermissions({
    fullDiskAccess: () => false,
    notesAutomation: () => ({ success: true }),
    shortcuts: () => ({ ready: true, checkOnly: true, items: [] }),
    speech: () => ({ ok: true, speechAuthorization: "authorized", requiresGrant: true }),
    macOSVersion: () => "27.2",
    launchingApp: () => null,
    execPath: "/usr/local/bin/node",
  });
  const ready: PermissionsReport = { ...missing, ready: true, items: [] };

  it("sends the report, re-checks on request, and opens only known panes", async () => {
    const window = fakeWindow();
    const check = vi.fn().mockReturnValueOnce(missing).mockReturnValueOnce(ready);
    const open = vi.fn(() => ({ ok: true }));
    const launch = vi.fn(() => window.child);
    const done = runPermissionsWindow("/fake/window", { check, open, launch });
    await tick();
    expect(launch).toHaveBeenCalledWith("/fake/window");
    expect(window.received[0]).toMatchObject({ type: "report", report: { ready: false } });

    window.say({ type: "open", id: "fullDiskAccess" });
    window.say({ type: "open", id: "notAnItem" });
    window.say({ type: "open", url: "https://example.com" });
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({ id: "fullDiskAccess" });

    window.say({ type: "recheck" });
    await tick();
    expect(check).toHaveBeenCalledTimes(2);
    expect(window.received[1]).toMatchObject({ type: "report", report: { ready: true } });

    window.close();
    expect(await done).toBe(0);
  });

  it("ignores lines that are not JSON and exits 1 when grants are still missing", async () => {
    const window = fakeWindow();
    const done = runPermissionsWindow("/fake/window", {
      check: () => missing,
      open: vi.fn(),
      launch: () => window.child,
    });
    await tick();
    (window.child.stdout as PassThrough).write("not json\n");
    await tick();
    window.close();
    expect(await done).toBe(1);
  });

  it("reports a launch failure", async () => {
    const window = fakeWindow();
    const log = vi.fn();
    const done = runPermissionsWindow("/fake/window", {
      check: () => ready,
      open: vi.fn(),
      launch: () => window.child,
      log,
    });
    window.child.emit("error", new Error("ENOENT"));
    expect(await done).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });
});
