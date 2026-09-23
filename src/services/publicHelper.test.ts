import type { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPublicHelper,
  callPublicHelper,
  defaultPublicHelperBuildDeps,
  defaultPublicHelperDeps,
  formatPublicHelperBuild,
  inspectPublicHelper,
  packageRoot,
  PUBLIC_HELPER_BINARY,
  PUBLIC_HELPER_DIR_ENV,
  PUBLIC_HELPER_MANIFEST,
  PUBLIC_HELPER_PROTOCOL,
  PUBLIC_HELPER_SOURCE,
  PUBLIC_HELPER_TIMEOUT_ENV,
  publicHelperCompileArguments,
  publicHelperInfoPlist,
  publicHelperInstallDir,
  PublicHelperError,
  sha256Hex,
  sourceDigestSwift,
  type PublicHelperBuildDeps,
} from "./publicHelper.js";
import { CodedError, errorResult } from "@/utils/errorCodes.js";

type SpawnResult = ReturnType<typeof spawnSync>;
const result = (over: Partial<SpawnResult>): SpawnResult =>
  ({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...over }) as SpawnResult;

let dir: string;
let sourcePath: string;
let installDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "public-helper-test-"));
  sourcePath = join(dir, "helper.swift");
  writeFileSync(sourcePath, "// helper source v1\n");
  installDir = join(dir, "install");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(
  spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => SpawnResult,
  over: Partial<PublicHelperBuildDeps> = {}
): PublicHelperBuildDeps {
  return {
    ...defaultPublicHelperDeps({ sourcePath }),
    env: { [PUBLIC_HELPER_DIR_ENV]: installDir },
    platform: "darwin",
    spawn: spawn as unknown as typeof spawnSync,
    osVersion: () => "27.2",
    now: () => new Date("2026-09-23T00:00:00Z"),
    ...over,
  };
}

/** A fake toolchain: swiftc writes a binary, codesign succeeds, the binary says hello. */
function toolchain(
  overrides: { hello?: Record<string, unknown>; compile?: number; sign?: number } = {}
) {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "/usr/bin/xcrun" && args[1] === "--version")
      return result({ stdout: "swift-driver version: 1\nApple Swift version 6.4 (test)\n" });
    if (cmd === "/usr/bin/xcrun") {
      if (overrides.compile) return result({ status: overrides.compile, stderr: "boom" });
      writeFileSync(args[args.length - 1], "binary-bytes");
      return result({});
    }
    if (cmd === "/usr/bin/codesign")
      return result({ status: overrides.sign ?? 0, stderr: overrides.sign ? "no sign" : "" });
    const request = JSON.parse(String(opts.input));
    expect(request).toEqual({ protocol: PUBLIC_HELPER_PROTOCOL, action: "hello" });
    return result({
      stdout: JSON.stringify(
        overrides.hello ?? {
          status: "ok",
          protocolVersion: PUBLIC_HELPER_PROTOCOL,
          sourceSha256: sha256Hex(readFileSync(sourcePath)),
          actions: ["hello", "decode_drawing"],
        }
      ),
    });
  };
  return { spawn, calls };
}

describe("install location and package root", () => {
  it("defaults under Application Support and honors the override", () => {
    expect(publicHelperInstallDir({})).toMatch(
      /Library\/Application Support\/apple-notes-mcp\/public-helper$/
    );
    expect(publicHelperInstallDir({ [PUBLIC_HELPER_DIR_ENV]: " /x/y " })).toBe("/x/y");
  });

  it("finds the package root that ships the helper source", () => {
    const root = packageRoot();
    expect(existsSync(join(root, PUBLIC_HELPER_SOURCE))).toBe(true);
    expect(defaultPublicHelperDeps().sourcePath).toBe(join(root, PUBLIC_HELPER_SOURCE));
  });

  it("walks past unrelated or unreadable package.json files", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "a", "package.json"), "{ not json");
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "other" }));
    // No apple-notes-mcp package above a temp dir: falls back to the parent of the start.
    expect(packageRoot(nested)).toBe(join(dir, "a"));
  });

  it("builds default build deps with an OS version probe", () => {
    const build = defaultPublicHelperBuildDeps();
    expect(build.osVersion()).toMatch(/\d/);
    expect(build.now()).toBeInstanceOf(Date);
  });
});

describe("compile inputs", () => {
  it("pins the exact swiftc argument vector, including the embedded Info.plist", () => {
    expect(publicHelperCompileArguments("/s.swift", "/d.swift", "/Info.plist", "/out")).toEqual([
      "swiftc",
      "-O",
      "-parse-as-library",
      "-framework",
      "AppKit",
      "-framework",
      "PencilKit",
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      "/Info.plist",
      "/s.swift",
      "/d.swift",
      "-o",
      "/out",
    ]);
  });

  it("generates the digest source and a plist with a bundle identifier", () => {
    expect(sourceDigestSwift("ab".repeat(32))).toBe(
      `let helperSourceSHA256 = "${"ab".repeat(32)}"\n`
    );
    expect(publicHelperInfoPlist()).toContain("<string>apple-notes-mcp.public-helper</string>");
  });

  it("ships a helper source that uses only public frameworks", () => {
    const source = readFileSync(join(packageRoot(), PUBLIC_HELPER_SOURCE), "utf8");
    expect(source).not.toMatch(/NotesShared|dlopen|NSClassFromString|PrivateFrameworks/);
    expect(source).toContain("let protocolVersion = 1");
  });
});

describe("buildPublicHelper", () => {
  it("compiles, signs, handshakes, and installs with a matching manifest", () => {
    const { spawn, calls } = toolchain();
    const report = buildPublicHelper(false, deps(spawn));
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
    const manifest = JSON.parse(readFileSync(join(installDir, PUBLIC_HELPER_MANIFEST), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      protocolVersion: PUBLIC_HELPER_PROTOCOL,
      sourceSha256: sha256Hex(readFileSync(sourcePath)),
      binarySha256: sha256Hex("binary-bytes"),
      osVersion: "27.2",
      compiler: "Apple Swift version 6.4 (test)",
    });
    const compile = calls.find((c) => c.args[0] === "swiftc" && c.args[1] === "-O")!;
    expect(compile.args).toContain("PencilKit");
    // Staging is cleaned up; only the binary and manifest remain.
    expect(readFileSync(join(installDir, PUBLIC_HELPER_BINARY), "utf8")).toBe("binary-bytes");
    expect(formatPublicHelperBuild(report)).toContain("Installed at");
    expect(buildPublicHelper(true, deps(spawn)).ok).toBe(true);
  });

  it.each([
    ["compile", { compile: 1 }],
    ["ad-hoc sign", { sign: 1 }],
    ["handshake", { hello: { status: "ok", protocolVersion: 99, sourceSha256: "x", actions: [] } }],
    ["handshake", { hello: { status: "error", code: "boom", message: "nope" } }],
  ])("stops at a failing %s step", (step, over) => {
    const report = buildPublicHelper(false, deps(toolchain(over).spawn));
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ step, ok: false });
    expect(existsSync(join(installDir, PUBLIC_HELPER_MANIFEST))).toBe(false);
    expect(formatPublicHelperBuild(report)).toContain("was not installed");
  });

  it("reports a missing compiler, missing source, and a non-macOS platform", () => {
    const noCompiler = buildPublicHelper(
      false,
      deps(() => result({ status: 1 }))
    );
    expect(noCompiler.steps.at(-1)).toMatchObject({ step: "find compiler", ok: false });
    const noSource = buildPublicHelper(
      false,
      deps(toolchain().spawn, { sourcePath: join(dir, "missing.swift") })
    );
    expect(noSource.steps.at(-1)).toMatchObject({ step: "locate source", ok: false });
    const linux = buildPublicHelper(false, deps(toolchain().spawn, { platform: "linux" }));
    expect(linux.steps).toEqual([{ step: "platform", ok: false, detail: "macOS only" }]);
  });

  it("check-only mode inspects without building", () => {
    const { spawn, calls } = toolchain();
    const report = buildPublicHelper(true, deps(spawn));
    expect(report.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(formatPublicHelperBuild(report)).toContain("setup --public-helper");
  });
});

describe("inspectPublicHelper", () => {
  function install() {
    const report = buildPublicHelper(false, deps(toolchain().spawn));
    expect(report.ok).toBe(true);
  }

  it("is ready right after a build", () => {
    install();
    const state = inspectPublicHelper(deps(toolchain().spawn));
    expect(state).toMatchObject({ ready: true, reason: null });
    expect(state.manifest?.protocolVersion).toBe(PUBLIC_HELPER_PROTOCOL);
  });

  it("marks a helper stale when the packaged source changes", () => {
    install();
    writeFileSync(sourcePath, "// helper source v2\n");
    expect(inspectPublicHelper(deps(toolchain().spawn)).reason).toBe("helper_stale");
  });

  it("refuses a binary replaced after setup", () => {
    install();
    writeFileSync(join(installDir, PUBLIC_HELPER_BINARY), "tampered");
    expect(inspectPublicHelper(deps(toolchain().spawn)).reason).toBe("helper_modified");
  });

  it("reports an unreadable manifest, a missing install, missing source, and platform", () => {
    install();
    writeFileSync(join(installDir, PUBLIC_HELPER_MANIFEST), "{}");
    expect(inspectPublicHelper(deps(toolchain().spawn)).reason).toBe("helper_manifest_invalid");
    rmSync(installDir, { recursive: true });
    expect(inspectPublicHelper(deps(toolchain().spawn)).reason).toBe("helper_not_installed");
    expect(
      inspectPublicHelper(deps(toolchain().spawn, { sourcePath: join(dir, "nope") })).reason
    ).toBe("helper_not_installed");
    expect(inspectPublicHelper(deps(toolchain().spawn, { platform: "win32" })).reason).toBe(
      "unsupported_platform"
    );
  });
});

describe("callPublicHelper", () => {
  const direct = { binaryPath: "/bin/helper" };
  const call = (res: Partial<SpawnResult>, env: NodeJS.ProcessEnv = {}) =>
    callPublicHelper(
      "decode_drawing",
      { a: 1 },
      deps(() => result(res), { env }),
      direct
    );
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as PublicHelperError).code;
    }
    return "none";
  };

  it("sends one protocol-stamped request and returns the ok object", () => {
    let seen: Record<string, unknown> = {};
    const out = callPublicHelper(
      "decode_drawing",
      { dataBase64: "AA==" },
      deps((_cmd, _args, opts) => {
        seen = opts;
        return result({ stdout: '{"status":"ok","strokeCount":0}' });
      }),
      { binaryPath: "/bin/helper", timeoutMs: 1234 }
    );
    expect(out).toEqual({ status: "ok", strokeCount: 0 });
    expect(JSON.parse(String(seen.input))).toEqual({
      protocol: PUBLIC_HELPER_PROTOCOL,
      action: "decode_drawing",
      dataBase64: "AA==",
    });
    expect(seen.timeout).toBe(1234);
  });

  it("lets the environment override the timeout", () => {
    let timeout: unknown;
    callPublicHelper(
      "hello",
      {},
      deps(
        (_c, _a, opts) => {
          timeout = opts.timeout;
          return result({ stdout: '{"status":"ok"}' });
        },
        { env: { [PUBLIC_HELPER_TIMEOUT_ENV]: "50" } }
      ),
      direct
    );
    expect(timeout).toBe(50);
  });

  it("maps every failure shape to a stable code", () => {
    const timedOut = Object.assign(new Error("t"), { code: "ETIMEDOUT" });
    expect(code(() => call({ error: timedOut, status: null }))).toBe("timeout");
    expect(code(() => call({ signal: "SIGKILL", status: null }))).toBe("timeout");
    expect(code(() => call({ error: new Error("ENOENT"), status: null }))).toBe(
      "helper_unreachable"
    );
    expect(code(() => call({ stdout: "not json", status: 1 }))).toBe("invalid_response");
    expect(code(() => call({ stdout: "[1]" }))).toBe("invalid_response");
    expect(code(() => call({ stdout: '{"status":"weird"}', status: 1 }))).toBe("invalid_response");
    expect(
      code(() =>
        call({ stdout: '{"status":"error","code":"undecodable","message":"m"}', status: 1 })
      )
    ).toBe("undecodable");
  });

  it("refuses actions outside the allowlist before spawning", () => {
    let spawned = false;
    expect(
      code(() =>
        callPublicHelper(
          "encode_drawing",
          { strokes: [] },
          deps(() => {
            spawned = true;
            return result({ stdout: '{"status":"ok"}' });
          }),
          direct
        )
      )
    ).toBe("unknown_action");
    expect(spawned).toBe(false);
  });

  it("refuses to run an uninstalled helper", () => {
    expect(
      code(() =>
        callPublicHelper(
          "hello",
          {},
          deps(() => result({}))
        )
      )
    ).toBe("helper_not_installed");
  });
});

describe("PublicHelperError envelope", () => {
  it("reports an unavailable helper as unsupported and other failures as operation_failed", () => {
    const unavailable = errorResult("Error", new PublicHelperError("helper_stale", "rebuild"));
    expect(unavailable.structuredContent).toEqual({
      code: "unsupported",
      helperCode: "helper_stale",
    });
    const failed = new PublicHelperError("decode_failed", "bad bytes");
    expect(failed).toBeInstanceOf(CodedError);
    expect(failed.code).toBe("decode_failed");
    expect(errorResult("Error", failed).structuredContent).toEqual({
      code: "operation_failed",
      helperCode: "decode_failed",
    });
  });
});
