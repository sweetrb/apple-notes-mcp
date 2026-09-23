/**
 * `apple-notes-mcp setup --native-helper`: build the private helper from the
 * packaged source on the user's Mac.
 *
 * No prebuilt binary ships with the package. Setup compiles the Objective-C
 * source with the Command Line Tools (`xcrun clang`), ad-hoc signs it, runs
 * its `hello` handshake, and only then moves it into the install directory
 * next to a manifest that records the source and binary SHA-256. The client
 * checks both digests before every dispatch (see privateHelper.ts).
 *
 * @module services/privateHelperBuild
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import {
  HELPER_BINARY_NAME,
  MANIFEST_NAME,
  PRIVATE_HELPER_PROTOCOL,
  callPrivateHelper,
  defaultDeps,
  helloSchema,
  READ_ONLY_ACTIONS,
  helperInstallDir,
  inspectInstallation,
  sha256Hex,
  type InstallationReport,
  type PrivateHelperDeps,
  type PrivateHelperManifest,
} from "./privateHelper.js";

export interface HelperBuildStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface HelperBuildReport {
  ok: boolean;
  checkOnly: boolean;
  steps: HelperBuildStep[];
  installation: InstallationReport;
}

export interface HelperBuildDeps extends PrivateHelperDeps {
  osVersion: () => string;
  now: () => Date;
}

export function defaultBuildDeps(): HelperBuildDeps {
  return {
    ...defaultDeps(),
    osVersion: () => {
      const r = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : `Darwin ${release()}`;
    },
    now: () => new Date(),
  };
}

/** The exact compiler argument vector. Exported so tests can pin it. */
export function compileArguments(sourcePath: string, outputPath: string, sourceSha: string) {
  return [
    "clang",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    "-framework",
    "Foundation",
    "-framework",
    "CoreData",
    "-framework",
    "AppKit",
    // Embedded so `hello` can prove which source the binary came from.
    `-DHELPER_SOURCE_SHA256="${sourceSha}"`,
    "-o",
    outputPath,
    sourcePath,
  ];
}

/**
 * Build and install the helper, or with `checkOnly` just report the installed
 * state. Never touches the Notes store: the only helper action run here is the
 * context-free `hello` handshake.
 */
export function buildPrivateHelper(
  checkOnly: boolean,
  deps: HelperBuildDeps = defaultBuildDeps()
): HelperBuildReport {
  const steps: HelperBuildStep[] = [];
  const done = (ok: boolean): HelperBuildReport => ({
    ok,
    checkOnly,
    steps,
    installation: inspectInstallation(deps),
  });
  if (checkOnly) {
    const installation = inspectInstallation(deps);
    steps.push({
      step: "inspect installed helper",
      ok: installation.ready,
      detail: installation.ready ? installation.binaryPath : installation.detail || undefined,
    });
    return { ok: installation.ready, checkOnly, steps, installation };
  }
  if (deps.platform !== "darwin") {
    steps.push({ step: "platform", ok: false, detail: "macOS only" });
    return done(false);
  }
  if (!deps.exists(deps.sourcePath)) {
    steps.push({ step: "locate source", ok: false, detail: deps.sourcePath });
    return done(false);
  }
  const source = deps.readFile(deps.sourcePath);
  const sourceSha = sha256Hex(source);
  steps.push({
    step: "locate source",
    ok: true,
    detail: `${deps.sourcePath} (sha256 ${sourceSha})`,
  });

  const clang = deps.spawn("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" });
  if (clang.status !== 0) {
    steps.push({
      step: "find compiler",
      ok: false,
      detail: "No clang found. Install the Command Line Tools with `xcode-select --install`.",
    });
    return done(false);
  }
  const clangVersion = deps.spawn("/usr/bin/xcrun", ["clang", "--version"], { encoding: "utf8" });
  const compiler = String(clangVersion.stdout || "").split("\n")[0] || "clang";
  steps.push({ step: "find compiler", ok: true, detail: compiler });

  const installDir = helperInstallDir(deps.env);
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  // Stage inside the install directory so the final rename stays on one volume.
  const staging = mkdtempSync(join(installDir, ".staging-"));
  try {
    const stagedBinary = join(staging, HELPER_BINARY_NAME);
    const compile = deps.spawn(
      "/usr/bin/xcrun",
      compileArguments(deps.sourcePath, stagedBinary, sourceSha),
      {
        encoding: "utf8",
        timeout: 180_000,
      }
    );
    if (compile.status !== 0) {
      steps.push({
        step: "compile",
        ok: false,
        detail: String(compile.stderr || compile.error?.message || "clang failed").slice(0, 4000),
      });
      return done(false);
    }
    steps.push({ step: "compile", ok: true });

    const sign = deps.spawn(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", "apple-notes-mcp.private-helper", stagedBinary],
      { encoding: "utf8" }
    );
    if (sign.status !== 0) {
      steps.push({
        step: "ad-hoc sign",
        ok: false,
        detail: String(sign.stderr || "codesign failed"),
      });
      return done(false);
    }
    steps.push({ step: "ad-hoc sign", ok: true });

    let hello;
    try {
      hello = helloSchema.parse(
        callPrivateHelper("hello", {}, deps, { allowDisabled: true, binaryPath: stagedBinary })
      );
    } catch (error) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return done(false);
    }
    if (hello.protocolVersion !== PRIVATE_HELPER_PROTOCOL || hello.sourceSha256 !== sourceSha) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: `helper reported protocol ${hello.protocolVersion}, source ${hello.sourceSha256}`,
      });
      return done(false);
    }
    const writeActions = hello.actions.filter((action) => !READ_ONLY_ACTIONS.has(action));
    if (writeActions.length) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: `helper offers non-read-only actions (${writeActions.join(", ")}); refusing to install`,
      });
      return done(false);
    }
    steps.push({
      step: "handshake",
      ok: true,
      detail: `protocol ${hello.protocolVersion}, read-only`,
    });

    const manifest: PrivateHelperManifest = {
      schemaVersion: 1,
      protocolVersion: hello.protocolVersion,
      sourceSha256: sourceSha,
      binarySha256: sha256Hex(deps.readFile(stagedBinary)),
      builtAt: deps.now().toISOString(),
      osVersion: deps.osVersion(),
      compiler,
    };
    chmodSync(stagedBinary, 0o700);
    // Binary first, manifest last: a crash in between leaves a manifest that
    // no longer matches, which the client reports as stale or modified.
    renameSync(stagedBinary, join(installDir, HELPER_BINARY_NAME));
    writeFileSync(join(installDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    });
    steps.push({ step: "install", ok: true, detail: installDir });
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  const installation = inspectInstallation(deps);
  steps.push({
    step: "verify installation",
    ok: installation.ready,
    detail: installation.ready ? undefined : installation.detail || undefined,
  });
  return { ok: installation.ready, checkOnly, steps, installation };
}

/** Terminal summary for `setup --native-helper`. */
export function formatHelperBuild(report: HelperBuildReport): string {
  const lines = ["Apple Notes MCP private helper", ""];
  for (const step of report.steps)
    lines.push(`${step.ok ? "✓" : "✗"} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
  lines.push("");
  if (report.ok) {
    lines.push(`Installed at ${report.installation.binaryPath}.`);
    lines.push(
      "The helper stays off until you set APPLE_NOTES_MCP_ENABLE_PRIVATE=1 for the MCP server, " +
        "and it needs the same Full Disk Access grant as the server's database reads."
    );
  } else if (report.checkOnly) {
    lines.push("Run `apple-notes-mcp setup --native-helper` to build it.");
  } else {
    lines.push("The helper was not installed. Fix the failed step above and run setup again.");
  }
  return lines.join("\n");
}
