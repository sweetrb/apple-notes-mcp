/**
 * Client for the opt-in native private helper (#181).
 *
 * The helper is a small Objective-C program, compiled on the user's Mac from
 * the source shipped in `native/private-helper/`. It loads Apple's private
 * NotesShared framework and opens the Notes Core Data store the way Notes'
 * own processes do. This module owns everything on the TypeScript side:
 *
 * - the opt-in switch (`APPLE_NOTES_MCP_ENABLE_PRIVATE=1`),
 * - locating the installed binary and refusing a missing, stale, or modified
 *   one before EVERY dispatch (fail closed),
 * - spawning it with a timeout, and
 * - validating every response against a schema before it reaches a tool.
 *
 * The helper is READ-ONLY. Its protocol has no write action, it opens every
 * store with Core Data's read-only option, and this client refuses to send
 * anything outside {@link READ_ONLY_ACTIONS}. Write support was deliberately
 * deferred by the maintainer (#181, #204).
 *
 * The protocol is one JSON object on stdin and one on stdout. See
 * TECHNICAL_NOTES.md "Private helper" for the contract.
 *
 * @module services/privateHelper
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The only protocol version this client speaks. Bump with the helper's PROTOCOL_VERSION. */
export const PRIVATE_HELPER_PROTOCOL = 1;
/** Set to "1" to allow any use of the private helper. */
export const ENABLE_ENV = "APPLE_NOTES_MCP_ENABLE_PRIVATE";
/** Overrides the install directory (tests, or a custom cache location). */
export const HELPER_DIR_ENV = "APPLE_NOTES_MCP_PRIVATE_HELPER_DIR";
/** Points the helper at a COPY of NoteStore.sqlite. The helper refuses the live store here. */
export const COPY_STORE_ENV = "APPLE_NOTES_MCP_PRIVATE_STORE";
/** Per-call timeout override in milliseconds. */
export const TIMEOUT_ENV = "APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS";
/** The only actions this client will send. All are read-only. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "hello",
  "probe",
  "read_note_state",
]);

export const HELPER_BINARY_NAME = "apple-notes-private-helper";
export const HELPER_SOURCE_RELATIVE = "native/private-helper/apple-notes-private-helper.m";
export const MANIFEST_NAME = "manifest.json";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Machine-readable reasons a private feature is unavailable. */
export type PrivateUnavailableReason =
  | "unsupported_platform"
  | "disabled"
  | "helper_not_installed"
  | "helper_stale"
  | "helper_modified"
  | "helper_manifest_invalid"
  | "helper_unreachable"
  | "private_api_unavailable"
  | "store_unavailable";

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.number().int(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  builtAt: z.string(),
  osVersion: z.string(),
  compiler: z.string(),
});
export type PrivateHelperManifest = z.infer<typeof manifestSchema>;

export interface InstallationReport {
  ready: boolean;
  reason: PrivateUnavailableReason | null;
  detail: string | null;
  installDir: string;
  binaryPath: string;
  sourcePath: string;
  expectedSourceSha256: string | null;
  manifest: PrivateHelperManifest | null;
}

/** Everything that touches the machine, injectable for tests. */
export interface PrivateHelperDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  sourcePath: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => Buffer;
  spawn: typeof spawnSync;
}

/** Locate the package root (the directory whose package.json names this package). */
export function packageRoot(fromDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === "apple-notes-mcp") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(fromDir, "..");
    dir = parent;
  }
}

export function defaultDeps(overrides: Partial<PrivateHelperDeps> = {}): PrivateHelperDeps {
  return {
    env: process.env,
    platform: process.platform,
    sourcePath: join(packageRoot(), HELPER_SOURCE_RELATIVE),
    exists: existsSync,
    readFile: (path) => readFileSync(path),
    spawn: spawnSync,
    ...overrides,
  };
}

export function privateHelperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_ENV] === "1";
}

/** `~/Library/Application Support/apple-notes-mcp/private-helper`, unless overridden. */
export function helperInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HELPER_DIR_ENV]?.trim();
  if (override) return override;
  return join(homedir(), "Library", "Application Support", "apple-notes-mcp", "private-helper");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Check the installed helper against the packaged source. Runs before every
 * dispatch, so an upgrade that changes the source makes the old binary stale
 * immediately, and a binary replaced after setup is refused.
 */
export function inspectInstallation(deps: PrivateHelperDeps = defaultDeps()): InstallationReport {
  const installDir = helperInstallDir(deps.env);
  const binaryPath = join(installDir, HELPER_BINARY_NAME);
  const base = {
    installDir,
    binaryPath,
    sourcePath: deps.sourcePath,
    expectedSourceSha256: null as string | null,
    manifest: null as PrivateHelperManifest | null,
  };
  const fail = (reason: PrivateUnavailableReason, detail: string): InstallationReport => ({
    ...base,
    ready: false,
    reason,
    detail,
  });
  if (deps.platform !== "darwin") return fail("unsupported_platform", "macOS only");
  if (!deps.exists(deps.sourcePath))
    return fail("helper_not_installed", `Packaged helper source is missing: ${deps.sourcePath}`);
  base.expectedSourceSha256 = sha256Hex(deps.readFile(deps.sourcePath));
  const manifestPath = join(installDir, MANIFEST_NAME);
  if (!deps.exists(binaryPath) || !deps.exists(manifestPath))
    return fail(
      "helper_not_installed",
      "The private helper is not built. Run `apple-notes-mcp setup --native-helper`."
    );
  let manifest: PrivateHelperManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(deps.readFile(manifestPath).toString("utf8")));
  } catch (error) {
    return fail(
      "helper_manifest_invalid",
      `Unreadable helper manifest (${error instanceof Error ? error.message : String(error)}). ` +
        "Run `apple-notes-mcp setup --native-helper`."
    );
  }
  base.manifest = manifest;
  if (
    manifest.sourceSha256 !== base.expectedSourceSha256 ||
    manifest.protocolVersion !== PRIVATE_HELPER_PROTOCOL
  )
    return fail(
      "helper_stale",
      "The installed helper was built from a different helper source or protocol than this " +
        "apple-notes-mcp version ships. Run `apple-notes-mcp setup --native-helper` again."
    );
  if (sha256Hex(deps.readFile(binaryPath)) !== manifest.binarySha256)
    return fail(
      "helper_modified",
      "The helper binary does not match the checksum recorded when it was built. " +
        "Run `apple-notes-mcp setup --native-helper` to rebuild it."
    );
  return { ...base, ready: true, reason: null, detail: null };
}

/**
 * The helper timeout from {@link TIMEOUT_ENV}, in milliseconds. Only a finite
 * positive value is honoured: spawnSync rejects a negative timeout with
 * ERR_OUT_OF_RANGE, and zero would mean no timeout at all.
 */
export function helperTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number.parseInt(env[TIMEOUT_ENV] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** A helper failure with a stable helper code. */
export class PrivateHelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "PrivateHelperError";
  }
}

const errorSchema = z
  .object({
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
  })
  .passthrough();

const featureSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  missing: z.array(z.string()),
});

export const helloSchema = z
  .object({
    status: z.literal("ok"),
    protocolVersion: z.number().int(),
    sourceSha256: z.string(),
    readOnly: z.literal(true),
    actions: z.array(z.string()),
  })
  .passthrough();

export const probeSchema = z
  .object({
    status: z.literal("ok"),
    protocolVersion: z.number().int(),
    readOnly: z.literal(true),
    os: z.object({ version: z.string(), notesAppVersion: z.string().nullable() }).passthrough(),
    framework: z.object({ loaded: z.boolean(), error: z.string().nullable() }).passthrough(),
    store: z
      .object({
        kind: z.enum(["live", "copy"]).nullable(),
        opened: z.boolean(),
        reason: z.string().nullable(),
        noteRows: z.number().int().nullable(),
      })
      .passthrough(),
    syncHostRunning: z.boolean(),
    features: z.object({ readNoteState: featureSchema }).passthrough(),
  })
  .passthrough();
export type PrivateProbe = z.infer<typeof probeSchema>;

const cloudSyncSchema = z
  .object({
    available: z.boolean(),
    inICloudAccount: z.boolean(),
    currentLocalVersion: z.number().int().optional(),
    latestVersionSyncedToCloud: z.number().int().optional(),
    uploadPending: z.boolean().optional(),
  })
  .passthrough();

export const noteStateSchema = z
  .object({
    status: z.literal("ok"),
    identifier: z.string(),
    objectURI: z.string(),
    title: z.string().nullable(),
    modificationDate: z.string().nullable(),
    folderIdentifier: z.string().nullable(),
    passwordProtected: z.boolean(),
    deletedOrInTrash: z.boolean(),
    sharedViaICloud: z.boolean(),
    editable: z.boolean(),
    revision: z.string().regex(/^r1:[a-f0-9]{64}$/),
    cloudSync: cloudSyncSchema,
    syncHostRunning: z.boolean(),
  })
  .passthrough();
export type PrivateNoteState = z.infer<typeof noteStateSchema>;

export interface CallOptions {
  /** Skip the opt-in check. Only `hello` during setup uses this. */
  allowDisabled?: boolean;
  /** Run a specific binary without the installation check (setup verification only). */
  binaryPath?: string;
}

/**
 * Send one read-only request to the helper and return its parsed JSON object.
 * Throws PrivateHelperError for every failure, including any action outside
 * {@link READ_ONLY_ACTIONS}, which is refused before anything is spawned.
 */
export function callPrivateHelper(
  action: string,
  fields: Record<string, unknown> = {},
  deps: PrivateHelperDeps = defaultDeps(),
  options: CallOptions = {}
): Record<string, unknown> {
  if (!READ_ONLY_ACTIONS.has(action))
    throw new PrivateHelperError(
      "unknown_action",
      `The private helper is read-only; "${action}" is not a supported action.`
    );
  if (!options.allowDisabled && !privateHelperEnabled(deps.env))
    throw new PrivateHelperError(
      "disabled",
      `The private helper is off. Set ${ENABLE_ENV}=1 to opt in.`
    );
  let binaryPath = options.binaryPath;
  if (!binaryPath) {
    const install = inspectInstallation(deps);
    if (!install.ready)
      throw new PrivateHelperError(install.reason || "helper_not_installed", install.detail || "");
    binaryPath = install.binaryPath;
  }
  const timeout = helperTimeoutMs(deps.env);
  const result = deps.spawn(binaryPath, [], {
    input: JSON.stringify({ protocol: PRIVATE_HELPER_PROTOCOL, action, ...fields }),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    env: deps.env,
  });
  const errno = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // Only our own timeout is a timeout. spawnSync also kills the helper when
  // its output passes maxBuffer (ENOBUFS), and a crash ends it with a signal
  // of its own; neither is slowness, and retrying will not help.
  if (errno === "ETIMEDOUT")
    throw new PrivateHelperError("timeout", `The helper did not answer within ${timeout} ms.`);
  if (errno === "ENOBUFS")
    throw new PrivateHelperError(
      "invalid_response",
      `The helper's output exceeded ${MAX_OUTPUT_BYTES} bytes and was cut off.`
    );
  if (result.error)
    throw new PrivateHelperError(
      "helper_unreachable",
      `Could not run the helper: ${result.error.message}`
    );
  if (result.signal)
    throw new PrivateHelperError(
      "helper_crashed",
      `The helper was terminated by ${result.signal} before it answered.`
    );
  const stdout = String(result.stdout ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PrivateHelperError(
      "invalid_response",
      `The helper exited with status ${result.status} and no JSON response.`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new PrivateHelperError("invalid_response", "The helper response is not a JSON object");
  const object = parsed as Record<string, unknown>;
  if (result.status !== 0 || object.status === "error") {
    const error = errorSchema.safeParse(object);
    if (!error.success)
      throw new PrivateHelperError(
        "invalid_response",
        `The helper failed with an unrecognized error shape (exit ${result.status})`
      );
    const { status: _status, code, message, ...details } = error.data;
    void _status;
    throw new PrivateHelperError(code, message, details);
  }
  return object;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new PrivateHelperError(
      "invalid_response",
      `Unexpected helper response: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`
    );
  return parsed.data;
}

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export function assertNoteIdentifier(identifier: string): void {
  if (!UUID.test(identifier))
    throw new PrivateHelperError("invalid_request", "identifier must be a Notes UUID");
}

export function probePrivateHelper(deps: PrivateHelperDeps = defaultDeps()): PrivateProbe {
  return parseOrThrow(probeSchema, callPrivateHelper("probe", {}, deps));
}

export function readNoteState(
  identifier: string,
  deps: PrivateHelperDeps = defaultDeps()
): PrivateNoteState {
  assertNoteIdentifier(identifier);
  return parseOrThrow(noteStateSchema, callPrivateHelper("read_note_state", { identifier }, deps));
}

export interface PrivateFeatureStatus {
  available: boolean;
  reason: PrivateUnavailableReason | null;
  detail: string | null;
}

export interface PrivateCapabilities {
  enabled: boolean;
  installation: InstallationReport;
  probe: PrivateProbe | null;
  /** Always true: the helper has no write action (deferred by the maintainer). */
  readOnly: true;
  features: {
    readNoteState: PrivateFeatureStatus;
  };
}

function featureFromProbe(
  feature: { available: boolean; reason: string | null; missing: string[] } | undefined
): PrivateFeatureStatus {
  if (!feature) return { available: false, reason: "private_api_unavailable", detail: null };
  if (feature.available) return { available: true, reason: null, detail: null };
  const reason =
    feature.reason === "store_unavailable" || feature.reason === "disabled"
      ? (feature.reason as PrivateUnavailableReason)
      : "private_api_unavailable";
  return {
    available: false,
    reason,
    detail: feature.missing.length ? `missing: ${feature.missing.join(", ")}` : feature.reason,
  };
}

/**
 * The single entry point a capability matrix can call. Never throws: every
 * failure becomes `available: false` with a machine reason and human detail.
 * Runs the live probe only when the helper is enabled and installed.
 */
export function privateHelperCapabilities(
  deps: PrivateHelperDeps = defaultDeps()
): PrivateCapabilities {
  const enabled = privateHelperEnabled(deps.env);
  const installation = inspectInstallation(deps);
  const off = (reason: PrivateUnavailableReason, detail: string | null): PrivateFeatureStatus => ({
    available: false,
    reason,
    detail,
  });
  const both = (status: PrivateFeatureStatus) => ({ readNoteState: status });
  if (installation.reason === "unsupported_platform")
    return {
      enabled,
      readOnly: true,
      installation,
      probe: null,
      features: both(off("unsupported_platform", null)),
    };
  if (!enabled)
    return {
      enabled,
      readOnly: true,
      installation,
      probe: null,
      features: both(off("disabled", `Set ${ENABLE_ENV}=1 to opt in to the private helper.`)),
    };
  if (!installation.ready)
    return {
      enabled,
      readOnly: true,
      installation,
      probe: null,
      features: both(off(installation.reason || "helper_not_installed", installation.detail)),
    };
  let probe: PrivateProbe;
  try {
    probe = probePrivateHelper(deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      enabled,
      readOnly: true,
      installation,
      probe: null,
      features: both(off("helper_unreachable", detail)),
    };
  }
  return {
    enabled,
    readOnly: true,
    installation,
    probe,
    features: { readNoteState: featureFromProbe(probe.features.readNoteState) },
  };
}
