/**
 * `apple-notes-mcp setup --native-writer`: build the opt-in private WRITER
 * from the packaged writer source on the user's Mac.
 *
 * Separate from `setup --native-helper` on purpose: that command builds only
 * the read-only helper and refuses any binary that offers a write action.
 * This one compiles `apple-notes-private-writer.m` with the same compiler
 * flags, ad-hoc signs it under its own identifier, runs its context-free
 * `hello` handshake, checks that it offers exactly the actions the client
 * knows ({@link WRITER_ACTIONS}), and only then installs it next to its own
 * manifest (`writer-manifest.json`). The read-only helper's binary and
 * manifest are never touched.
 *
 * @module services/privateWriterBuild
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { helperInstallDir, sha256Hex, type PrivateHelperManifest } from "./privateHelper.js";
import {
  compileArguments,
  defaultBuildDeps,
  type HelperBuildDeps,
  type HelperBuildStep,
} from "./privateHelperBuild.js";
import {
  PRIVATE_WRITER_PROTOCOL,
  WRITER_ACTIONS,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  WRITER_SETUP_COMMAND,
  WRITES_ENV,
  callPrivateWriter,
  defaultWriterDeps,
  inspectWriterInstallation,
  writerHelloSchema,
  type WriterInstallationReport,
} from "./privateWriter.js";

export interface WriterBuildReport {
  ok: boolean;
  checkOnly: boolean;
  steps: HelperBuildStep[];
  installation: WriterInstallationReport;
}

/**
 * The read-only helper's compiler flags plus PencilKit, which the writer's
 * Paper authoring (`add_paper`) links against. The helper's own flags stay
 * unchanged.
 */
export function writerCompileArguments(
  sourcePath: string,
  outputPath: string,
  sourceSha: string
): string[] {
  const args = compileArguments(sourcePath, outputPath, sourceSha);
  const appKit = args.indexOf("AppKit");
  return [...args.slice(0, appKit + 1), "-framework", "PencilKit", ...args.slice(appKit + 1)];
}

export function defaultWriterBuildDeps(): HelperBuildDeps {
  return { ...defaultBuildDeps(), sourcePath: defaultWriterDeps().sourcePath };
}

/**
 * Build and install the writer, or with `checkOnly` just report the installed
 * state. Never touches the Notes store: the only action run is `hello`.
 */
export function buildPrivateWriter(
  checkOnly: boolean,
  deps: HelperBuildDeps = defaultWriterBuildDeps()
): WriterBuildReport {
  const steps: HelperBuildStep[] = [];
  const done = (ok: boolean): WriterBuildReport => ({
    ok,
    checkOnly,
    steps,
    installation: inspectWriterInstallation(deps),
  });
  if (checkOnly) {
    const installation = inspectWriterInstallation(deps);
    steps.push({
      step: "inspect installed writer",
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
  const sourceSha = sha256Hex(deps.readFile(deps.sourcePath));
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
  const staging = mkdtempSync(join(installDir, ".staging-writer-"));
  try {
    const stagedBinary = join(staging, WRITER_BINARY_NAME);
    const compile = deps.spawn(
      "/usr/bin/xcrun",
      writerCompileArguments(deps.sourcePath, stagedBinary, sourceSha),
      { encoding: "utf8", timeout: 180_000 }
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
      ["--force", "--sign", "-", "--identifier", "apple-notes-mcp.private-writer", stagedBinary],
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
      hello = writerHelloSchema.parse(
        callPrivateWriter("hello", {}, deps, { allowDisabled: true, binaryPath: stagedBinary })
      );
    } catch (error) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return done(false);
    }
    if (hello.protocolVersion !== PRIVATE_WRITER_PROTOCOL || hello.sourceSha256 !== sourceSha) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: `writer reported protocol ${hello.protocolVersion}, source ${hello.sourceSha256}`,
      });
      return done(false);
    }
    const known = Object.keys(WRITER_ACTIONS);
    const unknown = hello.actions.filter((action) => !(action in WRITER_ACTIONS));
    const missing = known.filter((action) => !hello.actions.includes(action));
    if (unknown.length || missing.length) {
      steps.push({
        step: "handshake",
        ok: false,
        detail:
          `writer actions differ from the client's table` +
          (unknown.length ? `; unknown: ${unknown.join(", ")}` : "") +
          (missing.length ? `; missing: ${missing.join(", ")}` : "") +
          "; refusing to install",
      });
      return done(false);
    }
    const writes = known.filter((action) => WRITER_ACTIONS[action] === "write");
    steps.push({
      step: "handshake",
      ok: true,
      detail: `protocol ${hello.protocolVersion}, write actions: ${writes.join(", ")}`,
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
    renameSync(stagedBinary, join(installDir, WRITER_BINARY_NAME));
    writeFileSync(
      join(installDir, WRITER_MANIFEST_NAME),
      JSON.stringify(manifest, null, 2) + "\n",
      {
        mode: 0o600,
      }
    );
    steps.push({ step: "install", ok: true, detail: installDir });
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  const installation = inspectWriterInstallation(deps);
  steps.push({
    step: "verify installation",
    ok: installation.ready,
    detail: installation.ready ? undefined : installation.detail || undefined,
  });
  return { ok: installation.ready, checkOnly, steps, installation };
}

/** Terminal summary for `setup --native-writer`. */
export function formatWriterBuild(report: WriterBuildReport): string {
  const lines = ["Apple Notes MCP private writer", ""];
  for (const step of report.steps)
    lines.push(`${step.ok ? "✓" : "✗"} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
  lines.push("");
  if (report.ok) {
    lines.push(`Installed at ${report.installation.binaryPath}.`);
    lines.push(
      `The writer stays off until you set both APPLE_NOTES_MCP_ENABLE_PRIVATE=1 and ${WRITES_ENV}=1 ` +
        "for the MCP server. Writes that have not passed live validation also need " +
        "APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1. It uses unsupported private API; try it on disposable notes first."
    );
  } else if (report.checkOnly) {
    lines.push(`Run \`${WRITER_SETUP_COMMAND}\` to build it.`);
  } else {
    lines.push("The writer was not installed. Fix the failed step above and run setup again.");
  }
  return lines.join("\n");
}
