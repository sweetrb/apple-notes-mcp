/**
 * The optional permissions window: build, verify, and run.
 *
 * A small AppKit/SwiftUI program that shows the `setup --permissions`
 * checklist with "Open Settings" and "Re-check" buttons. It is built the same
 * way as the public native helper and is just as optional; the server never
 * uses it.
 *
 * - `apple-notes-mcp setup --permissions-window` compiles the packaged source
 *   with `xcrun swiftc`, ad-hoc signs it, runs its `hello` handshake (which
 *   shows no window), and installs it next to a manifest recording the source
 *   and binary SHA-256. No prebuilt binary ships with the package.
 * - `apple-notes-mcp setup --permissions --window` checks the installation
 *   against the packaged source and recorded digest (fail closed), then runs
 *   it as a child process. The child probes nothing: this module runs every
 *   check through {@link checkPermissions} and sends the report as a JSON line,
 *   so the window and the terminal report always agree. The window asks for an
 *   action by id (`open`, `recheck`); only this side maps an id to a
 *   System Settings URL and opens it.
 *
 * Because the window is a child of this process, macOS attributes anything it
 * does to the same launching app as the terminal check.
 *
 * @module services/permissionsWindow
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { packageRoot, sha256Hex, sourceDigestSwift } from "@/services/publicHelper.js";
import type { PermissionItem, PermissionsReport } from "@/services/permissions.js";

export const PERMISSIONS_WINDOW_PROTOCOL = 1;
/** Overrides the install directory (tests, or a custom location). */
export const PERMISSIONS_WINDOW_DIR_ENV = "APPLE_NOTES_MCP_PERMISSIONS_WINDOW_DIR";
export const PERMISSIONS_WINDOW_BINARY = "apple-notes-permissions-window";
export const PERMISSIONS_WINDOW_SOURCE =
  "native/permissions-window/apple-notes-permissions-window.swift";
export const PERMISSIONS_WINDOW_MANIFEST = "manifest.json";
export const PERMISSIONS_WINDOW_SETUP_COMMAND = "apple-notes-mcp setup --permissions-window";
export const PERMISSIONS_WINDOW_BUNDLE_ID = "apple-notes-mcp.permissions-window";

export const windowManifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.number().int(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  builtAt: z.string(),
  compiler: z.string(),
});
export type PermissionsWindowManifest = z.infer<typeof windowManifestSchema>;

export interface PermissionsWindowInstallation {
  ready: boolean;
  reason:
    | "unsupported_platform"
    | "window_not_installed"
    | "window_stale"
    | "window_modified"
    | "window_manifest_invalid"
    | null;
  detail: string | null;
  installDir: string;
  binaryPath: string;
}

/** Everything that touches the machine, injectable for tests. */
export interface PermissionsWindowDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  sourcePath: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => Buffer;
  spawn: typeof spawnSync;
  now: () => Date;
}

export function defaultPermissionsWindowDeps(
  overrides: Partial<PermissionsWindowDeps> = {}
): PermissionsWindowDeps {
  return {
    env: process.env,
    platform: process.platform,
    sourcePath: join(packageRoot(), PERMISSIONS_WINDOW_SOURCE),
    exists: existsSync,
    readFile: (path) => readFileSync(path),
    spawn: spawnSync,
    now: () => new Date(),
    ...overrides,
  };
}

/** `~/Library/Application Support/apple-notes-mcp/permissions-window`, unless overridden. */
export function permissionsWindowInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PERMISSIONS_WINDOW_DIR_ENV]?.trim();
  if (override) return override;
  return join(homedir(), "Library", "Application Support", "apple-notes-mcp", "permissions-window");
}

/** Check the installed window against the packaged source and recorded binary digest. */
export function inspectPermissionsWindow(
  deps: PermissionsWindowDeps = defaultPermissionsWindowDeps()
): PermissionsWindowInstallation {
  const installDir = permissionsWindowInstallDir(deps.env);
  const binaryPath = join(installDir, PERMISSIONS_WINDOW_BINARY);
  const fail = (
    reason: NonNullable<PermissionsWindowInstallation["reason"]>,
    detail: string
  ): PermissionsWindowInstallation => ({ ready: false, reason, detail, installDir, binaryPath });
  if (deps.platform !== "darwin") return fail("unsupported_platform", "macOS only");
  const rebuild = `Run \`${PERMISSIONS_WINDOW_SETUP_COMMAND}\`.`;
  if (!deps.exists(deps.sourcePath))
    return fail("window_not_installed", `Packaged window source is missing: ${deps.sourcePath}`);
  const manifestPath = join(installDir, PERMISSIONS_WINDOW_MANIFEST);
  if (!deps.exists(binaryPath) || !deps.exists(manifestPath))
    return fail("window_not_installed", `The permissions window is not built. ${rebuild}`);
  let manifest: PermissionsWindowManifest;
  try {
    manifest = windowManifestSchema.parse(JSON.parse(deps.readFile(manifestPath).toString("utf8")));
  } catch {
    return fail("window_manifest_invalid", `The window manifest is unreadable. ${rebuild}`);
  }
  if (
    manifest.sourceSha256 !== sha256Hex(deps.readFile(deps.sourcePath)) ||
    manifest.protocolVersion !== PERMISSIONS_WINDOW_PROTOCOL
  )
    return fail(
      "window_stale",
      `The installed window was built from a different source than this version ships. ${rebuild}`
    );
  if (sha256Hex(deps.readFile(binaryPath)) !== manifest.binarySha256)
    return fail(
      "window_modified",
      `The window binary no longer matches the checksum recorded when it was built. ${rebuild}`
    );
  return { ready: true, reason: null, detail: null, installDir, binaryPath };
}

/** Info.plist linked into the binary: AppKit needs a bundle identifier and name. */
export function permissionsWindowInfoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>${PERMISSIONS_WINDOW_BUNDLE_ID}</string>`,
    "  <key>CFBundleName</key>",
    "  <string>Apple Notes MCP Permissions</string>",
    "  <key>CFBundleInfoDictionaryVersion</key>",
    "  <string>6.0</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The exact compiler argument vector (after `/usr/bin/xcrun`). Exported so tests pin it. */
export function permissionsWindowCompileArguments(
  sourcePath: string,
  digestPath: string,
  plistPath: string,
  outputPath: string
): string[] {
  return [
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
    plistPath,
    sourcePath,
    digestPath,
    "-o",
    outputPath,
  ];
}

const helloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  sourceSha256: z.string(),
});

export interface PermissionsWindowBuildReport {
  ok: boolean;
  checkOnly: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  installation: PermissionsWindowInstallation;
}

/**
 * Build and install the window, or with `checkOnly` only report the installed
 * state. The handshake runs the binary with `{"type":"hello"}`, which answers
 * and exits without showing a window.
 */
export function buildPermissionsWindow(
  checkOnly: boolean,
  deps: PermissionsWindowDeps = defaultPermissionsWindowDeps()
): PermissionsWindowBuildReport {
  const steps: PermissionsWindowBuildReport["steps"] = [];
  const finish = (): PermissionsWindowBuildReport => {
    const installation = inspectPermissionsWindow(deps);
    return {
      ok: installation.ready && steps.every((s) => s.ok),
      checkOnly,
      steps,
      installation,
    };
  };
  if (checkOnly) {
    const installation = inspectPermissionsWindow(deps);
    steps.push({
      step: "inspect installed window",
      ok: installation.ready,
      detail: installation.ready ? installation.binaryPath : (installation.detail ?? undefined),
    });
    return finish();
  }
  if (deps.platform !== "darwin") {
    steps.push({ step: "platform", ok: false, detail: "macOS only" });
    return finish();
  }
  if (!deps.exists(deps.sourcePath)) {
    steps.push({ step: "locate source", ok: false, detail: deps.sourcePath });
    return finish();
  }
  const sourceSha = sha256Hex(deps.readFile(deps.sourcePath));
  steps.push({ step: "locate source", ok: true, detail: `sha256 ${sourceSha}` });

  const version = deps.spawn("/usr/bin/xcrun", ["swiftc", "--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    steps.push({
      step: "find compiler",
      ok: false,
      detail:
        "No Swift compiler found. Install the Command Line Tools with `xcode-select --install`.",
    });
    return finish();
  }
  const compiler =
    String(version.stdout || version.stderr || "")
      .split("\n")
      .find((line) => line.includes("Swift version"))
      ?.trim() || "swiftc";
  steps.push({ step: "find compiler", ok: true, detail: compiler });

  const installDir = permissionsWindowInstallDir(deps.env);
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  // Stage inside the install directory so the final rename stays on one volume.
  const staging = mkdtempSync(join(installDir, ".staging-"));
  try {
    const stagedBinary = join(staging, PERMISSIONS_WINDOW_BINARY);
    const digestPath = join(staging, "source-digest.swift");
    const plistPath = join(staging, "Info.plist");
    writeFileSync(digestPath, sourceDigestSwift(sourceSha), { mode: 0o600 });
    writeFileSync(plistPath, permissionsWindowInfoPlist(), { mode: 0o600 });
    const compile = deps.spawn(
      "/usr/bin/xcrun",
      permissionsWindowCompileArguments(deps.sourcePath, digestPath, plistPath, stagedBinary),
      { encoding: "utf8", timeout: 300_000 }
    );
    if (compile.status !== 0) {
      steps.push({
        step: "compile",
        ok: false,
        detail: String(compile.stderr || compile.error?.message || "swiftc failed").slice(0, 4000),
      });
      return finish();
    }
    steps.push({ step: "compile", ok: true });

    const sign = deps.spawn(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", PERMISSIONS_WINDOW_BUNDLE_ID, stagedBinary],
      { encoding: "utf8" }
    );
    if (sign.status !== 0) {
      steps.push({ step: "ad-hoc sign", ok: false, detail: String(sign.stderr || "failed") });
      return finish();
    }
    steps.push({ step: "ad-hoc sign", ok: true });

    const hello = deps.spawn(stagedBinary, [], {
      input: JSON.stringify({ type: "hello" }) + "\n",
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    let parsed: z.infer<typeof helloSchema> | null = null;
    try {
      parsed = helloSchema.parse(JSON.parse(String(hello.stdout ?? "").trim()));
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      parsed.protocolVersion !== PERMISSIONS_WINDOW_PROTOCOL ||
      parsed.sourceSha256 !== sourceSha
    ) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: parsed
          ? `window reported protocol ${parsed.protocolVersion}, source ${parsed.sourceSha256}`
          : `no valid hello (exit ${hello.status})`,
      });
      return finish();
    }
    steps.push({ step: "handshake", ok: true });

    const manifest: PermissionsWindowManifest = {
      schemaVersion: 1,
      protocolVersion: parsed.protocolVersion,
      sourceSha256: sourceSha,
      binarySha256: sha256Hex(deps.readFile(stagedBinary)),
      builtAt: deps.now().toISOString(),
      compiler,
    };
    chmodSync(stagedBinary, 0o700);
    // Binary first, manifest last: a crash in between leaves a manifest that
    // no longer matches, which inspection reports as stale or modified.
    renameSync(stagedBinary, join(installDir, PERMISSIONS_WINDOW_BINARY));
    writeFileSync(
      join(installDir, PERMISSIONS_WINDOW_MANIFEST),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 }
    );
    steps.push({ step: "install", ok: true, detail: installDir });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const installation = inspectPermissionsWindow(deps);
  steps.push({
    step: "verify installation",
    ok: installation.ready,
    detail: installation.ready ? undefined : (installation.detail ?? undefined),
  });
  return finish();
}

/** Terminal summary for `setup --permissions-window`. */
export function formatPermissionsWindowBuild(report: PermissionsWindowBuildReport): string {
  const lines = ["Apple Notes MCP permissions window", ""];
  for (const step of report.steps)
    lines.push(`${step.ok ? "✓" : "✗"} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
  lines.push("");
  if (report.ok)
    lines.push(
      `Installed at ${report.installation.binaryPath}. Open it with \`apple-notes-mcp setup --permissions --window\`.`
    );
  else if (report.checkOnly) lines.push(`Run \`${PERMISSIONS_WINDOW_SETUP_COMMAND}\` to build it.`);
  else lines.push("The window was not installed. Fix the failed step above and run setup again.");
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Running the window
// -----------------------------------------------------------------------------

export interface PermissionsWindowSession {
  check: () => PermissionsReport;
  open: (item: PermissionItem) => { ok: boolean; error?: string };
  /** Starts the window process; defaults to node's `spawn` of the installed binary. */
  launch?: (binaryPath: string) => ChildProcess;
  log?: (text: string) => void;
}

/** Messages the window may send. Anything else is ignored. */
const windowMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), id: z.string().max(64) }),
  z.object({ type: z.literal("recheck") }),
]);

/**
 * Run the window until the user closes it. Every report comes from
 * `session.check()`; an `open` request is honored only for an item of the
 * latest report that has a pane. Resolves with the exit code the CLI uses:
 * 0 when the last report had every required grant.
 */
export function runPermissionsWindow(
  binaryPath: string,
  session: PermissionsWindowSession
): Promise<number> {
  const launch =
    session.launch ??
    ((path: string) => spawn(path, [], { stdio: ["pipe", "pipe", "inherit"] }) as ChildProcess);
  const log = session.log ?? (() => {});
  let report = session.check();
  const child = launch(binaryPath);
  const sendReport = () => {
    if (child.stdin && !child.stdin.destroyed)
      child.stdin.write(JSON.stringify({ type: "report", report }) + "\n");
  };
  child.stdin?.on("error", () => {});
  sendReport();
  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: z.infer<typeof windowMessageSchema>;
      try {
        message = windowMessageSchema.parse(JSON.parse(line));
      } catch {
        return;
      }
      if (message.type === "recheck") {
        report = session.check();
        sendReport();
        return;
      }
      const item = report.items.find((candidate) => candidate.id === message.id);
      if (!item) return;
      const result = session.open(item);
      log(
        result.ok
          ? `Opened ${item.settingsPane}.\n`
          : `Could not open ${item.settingsPane ?? item.title}: ${result.error}\n`
      );
    });
  }
  return new Promise((resolveExit) => {
    child.on("error", (error) => {
      log(`Could not run the permissions window: ${error.message}\n`);
      resolveExit(report.ready ? 0 : 1);
    });
    child.on("close", () => resolveExit(report.ready ? 0 : 1));
  });
}
