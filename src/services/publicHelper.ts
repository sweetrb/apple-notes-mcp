/**
 * The public native helper: build, verify, and call.
 *
 * Some Notes content can only be read through Apple frameworks that have no
 * command-line or AppleScript surface (PencilKit for classic drawings, Speech
 * for on-device transcription). The helper is a small Swift program that links
 * PUBLIC frameworks only. No prebuilt binary ships with the package:
 *
 * - `apple-notes-mcp setup --public-helper` compiles the packaged source with
 *   `xcrun swiftc`, ad-hoc signs it, runs its `hello` handshake, and installs
 *   it next to a manifest recording the source and binary SHA-256.
 * - Before EVERY call the installation is re-checked against the packaged
 *   source and the recorded binary digest, so an upgrade makes an old binary
 *   stale at once and a replaced binary is refused (fail closed).
 * - Requests and responses are one JSON object each over stdin/stdout, and
 *   every response is schema-checked by the caller before use.
 *
 * The helper never opens the Notes database or writes to the Notes group
 * container: the server reads what it needs read-only and passes bytes in, or
 * names one audio file for the helper to open read-only.
 *
 * Shared-code note: the manifest, install inspection, spawn/timeout handling
 * and build steps mirror the opt-in private helper's; both could later move to
 * one parameterized module (name, source path, compile arguments, install
 * subdirectory) without changing either protocol.
 *
 * @module services/publicHelper
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { homedir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodedError, type ErrorCode } from "@/utils/errorCodes.js";

/** The only protocol version this client speaks. Bump with the Swift `protocolVersion`. */
export const PUBLIC_HELPER_PROTOCOL = 1;
/** Overrides the install directory (tests, or a custom location). */
export const PUBLIC_HELPER_DIR_ENV = "APPLE_NOTES_MCP_PUBLIC_HELPER_DIR";
/** Per-call timeout override in milliseconds. */
export const PUBLIC_HELPER_TIMEOUT_ENV = "APPLE_NOTES_MCP_PUBLIC_HELPER_TIMEOUT_MS";
export const PUBLIC_HELPER_BINARY = "apple-notes-public-helper";
export const PUBLIC_HELPER_SOURCE = "native/public-helper/apple-notes-public-helper.swift";
export const PUBLIC_HELPER_MANIFEST = "manifest.json";
export const PUBLIC_HELPER_SETUP_COMMAND = "apple-notes-mcp setup --public-helper";
/**
 * The only actions the server sends. `encode_drawing` (fixture generation)
 * stays reachable from scripts/test-public-helper.mjs, which runs the binary
 * directly, but is refused here before anything is spawned.
 */
export const PUBLIC_HELPER_ACTIONS: ReadonlySet<string> = new Set([
  "hello",
  "decode_drawing",
  "transcribe",
  "speech_status",
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export type PublicHelperUnavailable =
  | "unsupported_platform"
  | "helper_not_installed"
  | "helper_stale"
  | "helper_modified"
  | "helper_manifest_invalid";

export const publicManifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.number().int(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  builtAt: z.string(),
  osVersion: z.string(),
  compiler: z.string(),
});
export type PublicHelperManifest = z.infer<typeof publicManifestSchema>;

export interface PublicHelperInstallation {
  ready: boolean;
  reason: PublicHelperUnavailable | null;
  detail: string | null;
  installDir: string;
  binaryPath: string;
  sourcePath: string;
  manifest: PublicHelperManifest | null;
}

/** Everything that touches the machine, injectable for tests. */
export interface PublicHelperDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  sourcePath: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => Buffer;
  spawn: typeof spawnSync;
  /**
   * Async spawn for actions that can run for minutes (transcription), so the
   * server keeps serving other requests. Defaults to node's `spawn`.
   */
  spawnAsync?: typeof spawn;
}

/** Locate the package root: the nearest directory whose package.json names this package. */
export function packageRoot(fromDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        if (
          (JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name ===
          "apple-notes-mcp"
        )
          return dir;
      } catch {
        // an unreadable package.json is not ours; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(fromDir, "..");
    dir = parent;
  }
}

export function defaultPublicHelperDeps(
  overrides: Partial<PublicHelperDeps> = {}
): PublicHelperDeps {
  return {
    env: process.env,
    platform: process.platform,
    sourcePath: join(packageRoot(), PUBLIC_HELPER_SOURCE),
    exists: existsSync,
    readFile: (path) => readFileSync(path),
    spawn: spawnSync,
    spawnAsync: spawn,
    ...overrides,
  };
}

/** `~/Library/Application Support/apple-notes-mcp/public-helper`, unless overridden. */
export function publicHelperInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PUBLIC_HELPER_DIR_ENV]?.trim();
  if (override) return override;
  return join(homedir(), "Library", "Application Support", "apple-notes-mcp", "public-helper");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Check the installed helper against the packaged source and recorded binary digest. */
export function inspectPublicHelper(
  deps: PublicHelperDeps = defaultPublicHelperDeps()
): PublicHelperInstallation {
  const installDir = publicHelperInstallDir(deps.env);
  const binaryPath = join(installDir, PUBLIC_HELPER_BINARY);
  const base = { installDir, binaryPath, sourcePath: deps.sourcePath, manifest: null };
  const fail = (reason: PublicHelperUnavailable, detail: string): PublicHelperInstallation => ({
    ...base,
    ready: false,
    reason,
    detail,
  });
  if (deps.platform !== "darwin") return fail("unsupported_platform", "macOS only");
  if (!deps.exists(deps.sourcePath))
    return fail("helper_not_installed", `Packaged helper source is missing: ${deps.sourcePath}`);
  const manifestPath = join(installDir, PUBLIC_HELPER_MANIFEST);
  if (!deps.exists(binaryPath) || !deps.exists(manifestPath))
    return fail(
      "helper_not_installed",
      `The public native helper is not built. Run \`${PUBLIC_HELPER_SETUP_COMMAND}\`.`
    );
  let manifest: PublicHelperManifest;
  try {
    manifest = publicManifestSchema.parse(JSON.parse(deps.readFile(manifestPath).toString("utf8")));
  } catch {
    return fail(
      "helper_manifest_invalid",
      `The helper manifest is unreadable. Run \`${PUBLIC_HELPER_SETUP_COMMAND}\`.`
    );
  }
  if (
    manifest.sourceSha256 !== sha256Hex(deps.readFile(deps.sourcePath)) ||
    manifest.protocolVersion !== PUBLIC_HELPER_PROTOCOL
  )
    return {
      ...fail(
        "helper_stale",
        "The installed helper was built from a different source than this apple-notes-mcp " +
          `version ships. Run \`${PUBLIC_HELPER_SETUP_COMMAND}\` again.`
      ),
      manifest,
    };
  if (sha256Hex(deps.readFile(binaryPath)) !== manifest.binarySha256)
    return {
      ...fail(
        "helper_modified",
        "The helper binary no longer matches the checksum recorded when it was built. " +
          `Run \`${PUBLIC_HELPER_SETUP_COMMAND}\` to rebuild it.`
      ),
      manifest,
    };
  return { ...base, manifest, ready: true, reason: null, detail: null };
}

/** Helper codes that mean the helper cannot be used here until setup runs. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set<PublicHelperUnavailable>([
  "unsupported_platform",
  "helper_not_installed",
  "helper_stale",
  "helper_modified",
  "helper_manifest_invalid",
]);

/** Helper codes with a more specific envelope code than `operation_failed`. */
const ENVELOPE_CODES: Readonly<Record<string, ErrorCode>> = {
  invalid_request: "validation_error",
  attachment_not_found: "not_found",
};

/**
 * A helper failure with a stable machine code. It carries the coded error
 * envelope: `unsupported` while the helper is unavailable (not built, stale,
 * modified, or not macOS), `validation_error` for a rejected request,
 * `not_found` for a missing attachment, `operation_failed` otherwise, with the
 * helper's own code as `helperCode`.
 */
export class PublicHelperError extends CodedError {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message, {
      code: UNAVAILABLE_CODES.has(code)
        ? "unsupported"
        : (ENVELOPE_CODES[code] ?? "operation_failed"),
      helperCode: code,
    });
    this.name = "PublicHelperError";
  }
}

const errorSchema = z.object({ status: z.literal("error"), code: z.string(), message: z.string() });

export const publicHelloSchema = z
  .object({
    status: z.literal("ok"),
    protocolVersion: z.number().int(),
    sourceSha256: z.string(),
    actions: z.array(z.string()),
  })
  .passthrough();

export interface PublicCallOptions {
  /** Run this binary without the installation check (setup's handshake only). */
  binaryPath?: string;
  /**
   * Per-call timeout for actions whose run time depends on the input (for
   * example transcription length). Takes precedence over the env default.
   */
  timeoutMs?: number;
}

/**
 * Send one request and return the parsed success object. Every failure is a
 * PublicHelperError; a timeout is code `timeout` (the caller decides whether
 * that is indeterminate for its purpose). An action outside
 * {@link PUBLIC_HELPER_ACTIONS} is refused (`unknown_action`) before spawning.
 */
export function callPublicHelper(
  action: string,
  fields: Record<string, unknown> = {},
  deps: PublicHelperDeps = defaultPublicHelperDeps(),
  options: PublicCallOptions = {}
): Record<string, unknown> {
  const { binaryPath, timeout, input } = prepareCall(action, fields, deps, options);
  const result = deps.spawn(binaryPath, [], {
    input,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const errno = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "ETIMEDOUT" || (result.signal && result.status === null))
    throw new PublicHelperError("timeout", `The helper did not answer within ${timeout} ms.`);
  if (result.error)
    throw new PublicHelperError(
      "helper_unreachable",
      `Could not run the helper: ${result.error.message}`
    );
  return parseHelperOutput(result.status, String(result.stdout ?? ""));
}

export interface PublicAsyncCallOptions extends PublicCallOptions {
  /** Aborting kills the helper at once and rejects with code `aborted`. */
  signal?: AbortSignal;
}

/**
 * The asynchronous form of {@link callPublicHelper}, for actions that can run
 * for minutes. The helper runs as a child process without blocking the event
 * loop, so the server keeps answering other requests. On timeout or abort the
 * helper is killed with SIGKILL; a timeout rejects with code `timeout`, an
 * abort with code `aborted`.
 */
export async function callPublicHelperAsync(
  action: string,
  fields: Record<string, unknown> = {},
  deps: PublicHelperDeps = defaultPublicHelperDeps(),
  options: PublicAsyncCallOptions = {}
): Promise<Record<string, unknown>> {
  const { binaryPath, timeout, input } = prepareCall(action, fields, deps, options);
  const { signal } = options;
  const aborted = () =>
    new PublicHelperError("aborted", "The request was cancelled; the helper was stopped.");
  if (signal?.aborted) throw aborted();
  return new Promise((resolvePromise, reject) => {
    const child = (deps.spawnAsync ?? spawn)(binaryPath, [], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: PublicHelperError | null = null;
    const stop = (error: PublicHelperError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () =>
        stop(new PublicHelperError("timeout", `The helper did not answer within ${timeout} ms.`)),
      timeout
    );
    const onAbort = () => stop(aborted());
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES)
        stop(new PublicHelperError("invalid_response", "The helper response is too large."));
      else chunks.push(chunk);
    });
    child.on("error", (error) => {
      settle();
      reject(
        failure ??
          new PublicHelperError("helper_unreachable", `Could not run the helper: ${error.message}`)
      );
    });
    child.on("close", (status, exitSignal) => {
      settle();
      if (failure) return reject(failure);
      if (status === null && exitSignal)
        return reject(
          new PublicHelperError("helper_crashed", `The helper stopped on signal ${exitSignal}.`)
        );
      try {
        resolvePromise(parseHelperOutput(status, Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    // A helper that exits before reading stdin closes the pipe; its exit status tells the story.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Allowlist, installation check, timeout and request body shared by both call forms. */
function prepareCall(
  action: string,
  fields: Record<string, unknown>,
  deps: PublicHelperDeps,
  options: PublicCallOptions
): { binaryPath: string; timeout: number; input: string } {
  if (!PUBLIC_HELPER_ACTIONS.has(action))
    throw new PublicHelperError(
      "unknown_action",
      `"${action}" is not an action the server sends to the public helper.`
    );
  let binaryPath = options.binaryPath;
  if (!binaryPath) {
    const install = inspectPublicHelper(deps);
    if (!install.ready)
      throw new PublicHelperError(install.reason ?? "helper_not_installed", install.detail ?? "");
    binaryPath = install.binaryPath;
  }
  const timeout =
    options.timeoutMs ||
    Number.parseInt(deps.env[PUBLIC_HELPER_TIMEOUT_ENV] || "", 10) ||
    DEFAULT_TIMEOUT_MS;
  const input = JSON.stringify({ protocol: PUBLIC_HELPER_PROTOCOL, action, ...fields });
  return { binaryPath, timeout, input };
}

/** Parse and schema-check one helper answer; every failure is a PublicHelperError. */
function parseHelperOutput(status: number | null, stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new PublicHelperError(
      "invalid_response",
      `The helper exited with status ${status} and no JSON response.`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new PublicHelperError("invalid_response", "The helper response is not a JSON object.");
  const object = parsed as Record<string, unknown>;
  if (status !== 0 || object.status !== "ok") {
    const error = errorSchema.safeParse(object);
    if (!error.success)
      throw new PublicHelperError(
        "invalid_response",
        `The helper failed with an unrecognized response (exit ${status}).`
      );
    throw new PublicHelperError(error.data.code, error.data.message);
  }
  return object;
}

// -----------------------------------------------------------------------------
// Setup: build, sign, handshake, install
// -----------------------------------------------------------------------------

export interface PublicHelperBuildStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface PublicHelperBuildReport {
  ok: boolean;
  checkOnly: boolean;
  steps: PublicHelperBuildStep[];
  installation: PublicHelperInstallation;
}

export interface PublicHelperBuildDeps extends PublicHelperDeps {
  osVersion: () => string;
  now: () => Date;
}

export function defaultPublicHelperBuildDeps(): PublicHelperBuildDeps {
  return {
    ...defaultPublicHelperDeps(),
    osVersion: () => {
      const r = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : `Darwin ${release()}`;
    },
    now: () => new Date(),
  };
}

/** The Swift file setup generates beside the source so `hello` can prove its origin. */
export function sourceDigestSwift(sourceSha: string): string {
  return `let helperSourceSHA256 = "${sourceSha}"\n`;
}

/** Bundle identifier embedded in the helper and used as its code-signing identifier. */
export const PUBLIC_HELPER_BUNDLE_ID = "apple-notes-mcp.public-helper";

/**
 * Info.plist linked into the binary's `__TEXT,__info_plist` section. Some
 * frameworks (PencilKit's replica bookkeeping, privacy prompts) need a bundle
 * identifier and trap in a bare command-line tool without one.
 *
 * It deliberately carries no NSSpeechRecognitionUsageDescription: the helper
 * never asks for Speech Recognition access, and without a usage string macOS
 * stops a process that requests it instead of showing a prompt, so a request
 * can never leave the helper waiting on a dialog nobody sees.
 */
export function publicHelperInfoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>${PUBLIC_HELPER_BUNDLE_ID}</string>`,
    "  <key>CFBundleName</key>",
    "  <string>apple-notes-mcp public helper</string>",
    "  <key>CFBundleInfoDictionaryVersion</key>",
    "  <string>6.0</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The exact compiler argument vector (after `/usr/bin/xcrun`). Exported so tests pin it. */
export function publicHelperCompileArguments(
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
    "PencilKit",
    "-framework",
    "AVFoundation",
    "-framework",
    "Speech",
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

/**
 * Build and install the helper, or with `checkOnly` only report the installed
 * state. Never touches Notes: the only helper action run here is `hello`.
 */
export function buildPublicHelper(
  checkOnly: boolean,
  deps: PublicHelperBuildDeps = defaultPublicHelperBuildDeps()
): PublicHelperBuildReport {
  const steps: PublicHelperBuildStep[] = [];
  const done = (ok: boolean): PublicHelperBuildReport => ({
    ok,
    checkOnly,
    steps,
    installation: inspectPublicHelper(deps),
  });
  if (checkOnly) {
    const installation = inspectPublicHelper(deps);
    steps.push({
      step: "inspect installed helper",
      ok: installation.ready,
      detail: installation.ready ? installation.binaryPath : (installation.detail ?? undefined),
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
  steps.push({ step: "locate source", ok: true, detail: `sha256 ${sourceSha}` });

  const version = deps.spawn("/usr/bin/xcrun", ["swiftc", "--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    steps.push({
      step: "find compiler",
      ok: false,
      detail:
        "No Swift compiler found. Install the Command Line Tools with `xcode-select --install`.",
    });
    return done(false);
  }
  const compiler =
    String(version.stdout || version.stderr || "")
      .split("\n")
      .find((line) => line.includes("Swift version"))
      ?.trim() || "swiftc";
  steps.push({ step: "find compiler", ok: true, detail: compiler });

  const installDir = publicHelperInstallDir(deps.env);
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  // Stage inside the install directory so the final rename stays on one volume.
  const staging = mkdtempSync(join(installDir, ".staging-"));
  try {
    const stagedBinary = join(staging, PUBLIC_HELPER_BINARY);
    const digestPath = join(staging, "source-digest.swift");
    const plistPath = join(staging, "Info.plist");
    writeFileSync(digestPath, sourceDigestSwift(sourceSha), { mode: 0o600 });
    writeFileSync(plistPath, publicHelperInfoPlist(), { mode: 0o600 });
    const compile = deps.spawn(
      "/usr/bin/xcrun",
      publicHelperCompileArguments(deps.sourcePath, digestPath, plistPath, stagedBinary),
      { encoding: "utf8", timeout: 300_000 }
    );
    if (compile.status !== 0) {
      steps.push({
        step: "compile",
        ok: false,
        detail: String(compile.stderr || compile.error?.message || "swiftc failed").slice(0, 4000),
      });
      return done(false);
    }
    steps.push({ step: "compile", ok: true });

    const sign = deps.spawn(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", PUBLIC_HELPER_BUNDLE_ID, stagedBinary],
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

    let hello: z.infer<typeof publicHelloSchema>;
    try {
      hello = publicHelloSchema.parse(
        callPublicHelper("hello", {}, deps, { binaryPath: stagedBinary })
      );
    } catch (error) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return done(false);
    }
    if (hello.protocolVersion !== PUBLIC_HELPER_PROTOCOL || hello.sourceSha256 !== sourceSha) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: `helper reported protocol ${hello.protocolVersion}, source ${hello.sourceSha256}`,
      });
      return done(false);
    }
    steps.push({ step: "handshake", ok: true, detail: `actions: ${hello.actions.join(", ")}` });

    const manifest: PublicHelperManifest = {
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
    // no longer matches, which inspection reports as stale or modified.
    renameSync(stagedBinary, join(installDir, PUBLIC_HELPER_BINARY));
    writeFileSync(
      join(installDir, PUBLIC_HELPER_MANIFEST),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 }
    );
    steps.push({ step: "install", ok: true, detail: installDir });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const installation = inspectPublicHelper(deps);
  steps.push({
    step: "verify installation",
    ok: installation.ready,
    detail: installation.ready ? undefined : (installation.detail ?? undefined),
  });
  return { ok: installation.ready, checkOnly, steps, installation };
}

/** Terminal summary for `setup --public-helper`. */
export function formatPublicHelperBuild(report: PublicHelperBuildReport): string {
  const lines = ["Apple Notes MCP public native helper", ""];
  for (const step of report.steps)
    lines.push(`${step.ok ? "✓" : "✗"} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
  lines.push("");
  if (report.ok) lines.push(`Installed at ${report.installation.binaryPath}.`);
  else if (report.checkOnly) lines.push(`Run \`${PUBLIC_HELPER_SETUP_COMMAND}\` to build it.`);
  else lines.push("The helper was not installed. Fix the failed step above and run setup again.");
  return lines.join("\n");
}
