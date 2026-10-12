/**
 * The optional permission broker: build, install, inspect, and remove.
 *
 * macOS checks Full Disk Access and Automation against the *responsible
 * process* of whatever reads the Notes database or sends Notes an Apple event.
 * Without the broker that is the MCP host app, or (under hosts that disclaim
 * responsibility for their children, like Claude Desktop) the Node binary the
 * host launched, so a grant breaks whenever Node moves or updates (#220).
 *
 * `apple-notes-mcp setup --broker` builds a small signed app bundle,
 * "Apple Notes MCP Broker.app", and runs it as a per-user LaunchAgent. The
 * broker listens on a same-user Unix socket and starts this package's own
 * entry point as its child for each client, so the bundle is the responsible
 * process and the grants belong to it. The stdio process a host launches
 * becomes a thin proxy to that socket (see {@link module:services/brokerProxy}).
 *
 * Nothing changes for anyone who does not run `setup --broker`: without an
 * installed broker the server runs in-process exactly as before.
 *
 * Signing: a grant is tied to the bundle's designated requirement. With a
 * Developer ID Application identity, the designated requirement identifies
 * the bundle and team. Apple Development identities can change their
 * requirement when renewed. An ad-hoc signature is tied to the exact binary, so every rebuild
 * needs the grants again; setup says so when that is the only option.
 *
 * @module services/broker
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { pingBroker } from "@/services/brokerClient.js";
import { packageRoot, sha256Hex, sourceDigestSwift } from "@/services/publicHelper.js";

export const BROKER_PROTOCOL = 3;
export const BROKER_BUNDLE_ID = "apple-notes-mcp.broker";
export const BROKER_LABEL = BROKER_BUNDLE_ID;
export const BROKER_APP_NAME = "Apple Notes MCP Broker.app";
export const BROKER_EXECUTABLE = "apple-notes-mcp-broker";
export const BROKER_SOURCE = "native/broker/apple-notes-mcp-broker.swift";
export const BROKER_MANIFEST = "manifest.json";
export const BROKER_SOCKET = "broker.sock";
export const BROKER_SETUP_COMMAND = "apple-notes-mcp setup --broker";
export const BROKER_LOG_COMMAND = `log show --last 10m --predicate 'subsystem == "${BROKER_BUNDLE_ID}"'`;
/** Set by the broker on its children. */
export const BROKERED_ENV = "APPLE_NOTES_MCP_BROKERED";
export const BROKER_APP_ENV = "APPLE_NOTES_MCP_BROKER_APP";
/** `off` keeps the server in-process even when a broker is installed. */
export const BROKER_MODE_ENV = "APPLE_NOTES_MCP_BROKER";
/** Directory overrides (tests, or a custom location). */
export const BROKER_DIR_ENV = "APPLE_NOTES_MCP_BROKER_DIR";
export const BROKER_APP_DIR_ENV = "APPLE_NOTES_MCP_BROKER_APP_DIR";
export const BROKER_AGENT_DIR_ENV = "APPLE_NOTES_MCP_BROKER_AGENT_DIR";
export const BROKER_SIGN_IDENTITY_ENV = "APPLE_NOTES_MCP_BROKER_SIGN_IDENTITY";
/** Longest path a macOS sockaddr_un holds (104 bytes including the terminator). */
export const MAX_SOCKET_PATH_BYTES = 103;

export const brokerManifestSchema = z.object({
  schemaVersion: z.literal(2),
  protocolVersion: z.number().int(),
  packageVersion: z.string(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  appPath: z.string(),
  agentPath: z.string(),
  socketPath: z.string(),
  logPath: z.string(),
  nodePath: z.string(),
  entryPath: z.string(),
  signing: z.object({
    identity: z.string(),
    teamId: z.string().nullable(),
    stable: z.boolean(),
  }),
  builtAt: z.string(),
  compiler: z.string(),
});
export type BrokerManifest = z.infer<typeof brokerManifestSchema>;

/** Sealed by the app signature; native code reads this fixed path itself. */
export const brokerConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodePath: z.string(),
    nodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    packageVersion: z.string(),
    entrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Fixed bundle resources, never supplied in LaunchAgent arguments. */
export function brokerResources(appPath: string) {
  const resources = join(appPath, "Contents", "Resources");
  return {
    resources,
    configPath: join(resources, "broker-config.json"),
    entryPath: join(resources, "server", "build", "index.js"),
    packagePath: join(resources, "server", "package.json"),
    sourcePath: join(resources, "server", BROKER_SOURCE),
    serverConfigPath: join(resources, "config.json"),
    disabledHelpers: join(resources, "disabled-helpers"),
  };
}

export interface BrokerPaths {
  stateDir: string;
  manifestPath: string;
  socketPath: string;
  appDir: string;
  appPath: string;
  executablePath: string;
  agentPath: string;
  logPath: string;
}

/** Where everything lives, honoring the directory overrides. */
export function brokerPaths(env: NodeJS.ProcessEnv = process.env): BrokerPaths {
  const home = homedir();
  const stateDir = resolve(
    env[BROKER_DIR_ENV]?.trim() ||
      join(home, "Library", "Application Support", "apple-notes-mcp", "broker")
  );
  const appDir = env[BROKER_APP_DIR_ENV]?.trim() || join(home, "Applications");
  const agentDir = env[BROKER_AGENT_DIR_ENV]?.trim() || join(home, "Library", "LaunchAgents");
  const appPath = join(appDir, BROKER_APP_NAME);
  return {
    stateDir,
    manifestPath: join(stateDir, BROKER_MANIFEST),
    socketPath: join(stateDir, BROKER_SOCKET),
    appDir,
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", BROKER_EXECUTABLE),
    agentPath: join(agentDir, `${BROKER_LABEL}.plist`),
    logPath: join(home, "Library", "Logs", "apple-notes-mcp-broker.log"),
  };
}

export type BrokerUnavailable =
  | "unsupported_platform"
  | "broker_not_installed"
  | "broker_manifest_invalid"
  | "broker_stale"
  | "broker_modified"
  | "broker_agent_missing"
  | "broker_node_missing"
  | "broker_entry_missing";

export interface BrokerInstallation {
  installed: boolean;
  ready: boolean;
  reason: BrokerUnavailable | null;
  detail: string | null;
  paths: BrokerPaths;
  manifest: BrokerManifest | null;
}

/** Everything that touches the machine, injectable for tests. */
export interface BrokerDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  sourcePath: string;
  entryPath: string;
  execPath: string;
  packageVersion: string;
  uid: number;
  exists: (path: string) => boolean;
  readFile: (path: string) => Buffer;
  realpath: (path: string) => string;
  removePath: typeof rmSync;
  removeEmptyDirectory: (path: string) => void;
  spawn: typeof spawnSync;
  /** Ask the running broker for a pong; resolves false when it does not answer. */
  ping: (socketPath: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export function defaultBrokerDeps(overrides: Partial<BrokerDeps> = {}): BrokerDeps {
  const root = packageRoot();
  let packageVersion = "0.0.0";
  try {
    packageVersion =
      (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string })
        .version ?? packageVersion;
  } catch {
    // keep the placeholder; it is informational only
  }
  return {
    env: process.env,
    platform: process.platform,
    sourcePath: join(root, BROKER_SOURCE),
    entryPath: join(root, "build", "index.js"),
    execPath: process.execPath,
    packageVersion,
    uid: process.getuid?.() ?? -1,
    exists: existsSync,
    readFile: (path) => readFileSync(path),
    realpath: (path) => realpathSync(path),
    removePath: rmSync,
    removeEmptyDirectory: (path) => rmdirSync(path),
    spawn: spawnSync,
    ping: (socketPath) => pingBroker(socketPath),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    ...overrides,
  };
}

/** Inspect the installed broker against the packaged source (fail closed). */
export function inspectBroker(deps: BrokerDeps = defaultBrokerDeps()): BrokerInstallation {
  const paths = brokerPaths(deps.env);
  const result = (
    reason: BrokerUnavailable | null,
    detail: string | null,
    manifest: BrokerManifest | null
  ): BrokerInstallation => ({
    installed: manifest !== null,
    ready: reason === null,
    reason,
    detail,
    paths,
    manifest,
  });
  if (deps.platform !== "darwin") return result("unsupported_platform", "macOS only", null);
  const rebuild = `Run \`${BROKER_SETUP_COMMAND}\` again.`;
  if (!deps.exists(paths.manifestPath))
    return result("broker_not_installed", "The permission broker is not installed.", null);
  let manifest: BrokerManifest;
  try {
    manifest = brokerManifestSchema.parse(
      JSON.parse(deps.readFile(paths.manifestPath).toString("utf8"))
    );
  } catch {
    return result("broker_manifest_invalid", `The broker manifest is unreadable. ${rebuild}`, null);
  }
  const resources = brokerResources(paths.appPath);
  if (
    manifest.appPath !== paths.appPath ||
    manifest.agentPath !== paths.agentPath ||
    manifest.socketPath !== paths.socketPath ||
    manifest.logPath !== paths.logPath ||
    manifest.entryPath !== resources.entryPath
  )
    return result(
      "broker_modified",
      `The broker manifest contains unexpected paths. ${rebuild}`,
      manifest
    );
  if (!deps.exists(paths.appPath) || !deps.exists(paths.executablePath))
    return result(
      "broker_not_installed",
      `The broker app is missing from ${paths.appPath}. ${rebuild}`,
      manifest
    );
  try {
    if (
      !deps.exists(deps.sourcePath) ||
      !deps.exists(deps.entryPath) ||
      manifest.sourceSha256 !== sha256Hex(deps.readFile(deps.sourcePath)) ||
      manifest.entrySha256 !== sha256Hex(deps.readFile(deps.entryPath)) ||
      manifest.packageVersion !== deps.packageVersion ||
      manifest.protocolVersion !== BROKER_PROTOCOL
    )
      return result(
        "broker_stale",
        `The installed broker serves a different package or build. ${rebuild}`,
        manifest
      );
    if (!deps.exists(manifest.agentPath))
      return result(
        "broker_agent_missing",
        `The broker's LaunchAgent is missing (${manifest.agentPath}). ${rebuild}`,
        manifest
      );
    if (!deps.exists(manifest.nodePath))
      return result(
        "broker_node_missing",
        `The Node binary the broker launches is gone (${manifest.nodePath}). ${rebuild} Your grants stay with the broker app.`,
        manifest
      );
    if (!deps.exists(resources.entryPath))
      return result(
        "broker_entry_missing",
        `The bundled server entry point is gone (${resources.entryPath}). ${rebuild}`,
        manifest
      );
    const config = brokerConfigSchema.parse(
      JSON.parse(deps.readFile(resources.configPath).toString("utf8"))
    );
    if (
      sha256Hex(deps.readFile(paths.executablePath)) !== manifest.binarySha256 ||
      sha256Hex(deps.readFile(resources.entryPath)) !== manifest.entrySha256 ||
      sha256Hex(deps.readFile(resources.sourcePath)) !== manifest.sourceSha256 ||
      deps.readFile(resources.serverConfigPath).toString("utf8") !== "{}\n" ||
      !isAbsolute(manifest.nodePath) ||
      deps.realpath(manifest.nodePath) !== manifest.nodePath ||
      sha256Hex(deps.readFile(manifest.nodePath)) !== manifest.nodeSha256 ||
      config.nodePath !== manifest.nodePath ||
      config.nodeSha256 !== manifest.nodeSha256 ||
      config.packageVersion !== manifest.packageVersion ||
      config.entrySha256 !== manifest.entrySha256
    )
      return result(
        "broker_modified",
        `The broker bundle, sealed configuration, or Node runtime no longer matches its installation. ${rebuild}`,
        manifest
      );
    const bundledPackage = JSON.parse(
      deps.readFile(resources.packagePath).toString("utf8")
    ) as Record<string, unknown>;
    if (
      bundledPackage.name !== "apple-notes-mcp" ||
      bundledPackage.type !== "module" ||
      bundledPackage.version !== manifest.packageVersion
    )
      return result(
        "broker_modified",
        `The bundled package metadata changed. ${rebuild}`,
        manifest
      );
    const verified = deps.spawn(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--deep", paths.appPath],
      {
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    if (verified.status !== 0)
      return result("broker_modified", `The broker app signature is invalid. ${rebuild}`, manifest);
  } catch {
    return result(
      "broker_modified",
      `The broker installation could not be verified. ${rebuild}`,
      manifest
    );
  }
  return result(null, null, manifest);
}

/** Info.plist for the app bundle. LSUIElement keeps it out of the Dock. */
export function brokerInfoPlist(packageVersion: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>${BROKER_BUNDLE_ID}</string>`,
    "  <key>CFBundleName</key>",
    "  <string>Apple Notes MCP Broker</string>",
    "  <key>CFBundleDisplayName</key>",
    "  <string>Apple Notes MCP Broker</string>",
    "  <key>CFBundleExecutable</key>",
    `  <string>${BROKER_EXECUTABLE}</string>`,
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>CFBundleInfoDictionaryVersion</key>",
    "  <string>6.0</string>",
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${escape(packageVersion)}</string>`,
    "  <key>CFBundleVersion</key>",
    `  <string>${escape(packageVersion)}</string>`,
    "  <key>LSUIElement</key>",
    "  <true/>",
    "  <key>NSAppleEventsUsageDescription</key>",
    "  <string>apple-notes-mcp reads and organizes your notes through Notes when an MCP client asks it to.</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The exact compiler argument vector (after `/usr/bin/xcrun`). Exported so tests pin it. */
export function brokerCompileArguments(
  sourcePath: string,
  digestPath: string,
  outputPath: string
): string[] {
  return ["swiftc", "-O", "-parse-as-library", sourcePath, digestPath, "-o", outputPath];
}

/** The LaunchAgent that keeps the broker running for this user. */
export function brokerLaunchAgentPlist(args: {
  executablePath: string;
  socketPath: string;
}): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const programArguments = [args.executablePath, "serve", "--socket", args.socketPath];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${BROKER_LABEL}</string>`,
    "  <key>AssociatedBundleIdentifiers</key>",
    "  <array>",
    `    <string>${BROKER_BUNDLE_ID}</string>`,
    "  </array>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((arg) => `    <string>${escape(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardErrorPath</key>",
    "  <string>/dev/null</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export interface SigningIdentity {
  /** What codesign is given: a SHA-1 hash, a name, or `-` for ad-hoc. */
  identity: string;
  /** The human-readable name, or "ad-hoc". */
  name: string;
}

/** Require an explicit choice when several qualifying signing identities exist. */
export function chooseSigningIdentity(
  securityOutput: string,
  explicit: string | undefined
): SigningIdentity {
  const identities = [...securityOutput.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map(
    (m) => ({ identity: m[1], name: m[2] })
  );
  if (explicit && explicit.trim()) {
    const value = explicit.trim();
    const found = identities.find(
      (identity) => identity.identity === value || identity.name === value
    );
    return found ?? { identity: value, name: value === "-" ? "ad-hoc" : value };
  }
  const qualifying = identities.filter((identity) =>
    /^(Developer ID Application:|Apple Development:)/.test(identity.name)
  );
  if (qualifying.length > 1)
    throw new Error(
      "Multiple signing identities qualify. Choose one explicitly with --sign-identity <certificate SHA-1 or name>."
    );
  return qualifying[0] ?? { identity: "-", name: "ad-hoc" };
}

/** Read the team identifier from `codesign -dv` output; null when ad-hoc or absent. */
export function parseTeamId(codesignOutput: string): string | null {
  if (/Signature=adhoc/.test(codesignOutput)) return null;
  const match = codesignOutput.match(/^TeamIdentifier=(.+)$/m);
  const team = match?.[1]?.trim();
  return team && team !== "not set" ? team : null;
}

/** Pin the canonical running Node executable, so PATH or symlink changes cannot redirect it. */
export function chooseNodePath(deps: Pick<BrokerDeps, "execPath" | "realpath">): string {
  const nodePath = deps.realpath(deps.execPath);
  if (!isAbsolute(nodePath))
    throw new Error("The Node executable must resolve to an absolute path.");
  return nodePath;
}

/** Reject mutable external libraries that would bypass pinning the Node executable. */
export function validateNodeLibraries(output: string): boolean {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let libraries = 0;
  for (const line of lines) {
    if (line.endsWith(":")) continue; // otool's executable/architecture headings
    const match = line.match(/^(.+?) \(compatibility version [^)]+\)$/);
    if (!match || !/^\/(?:usr\/lib|System\/Library)\//.test(match[1])) return false;
    // Do not let a superficially system-prefixed path escape the system roots.
    if (match[1].split("/").includes("..")) return false;
    libraries++;
  }
  return libraries > 0;
}

export interface BrokerSetupOptions {
  checkOnly: boolean;
  uninstall: boolean;
  signIdentity?: string;
}

export function parseBrokerArgs(args: readonly string[]): BrokerSetupOptions {
  const index = args.indexOf("--sign-identity");
  return {
    checkOnly: args.includes("--check"),
    uninstall: args.includes("--uninstall"),
    signIdentity: index >= 0 ? args[index + 1] : undefined,
  };
}

export interface BrokerSetupReport {
  ok: boolean;
  mode: "check" | "install" | "uninstall";
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  installation: BrokerInstallation;
  running: boolean;
  warnings: string[];
}

function launchctl(deps: BrokerDeps, args: string[]) {
  return deps.spawn("/bin/launchctl", args, { encoding: "utf8", timeout: 30_000 });
}

/** Confirm launchd has actually removed the service before changing its files. */
async function stopBroker(
  deps: BrokerDeps,
  domain: string
): Promise<BrokerSetupReport["steps"][number]> {
  const target = `${domain}/${BROKER_LABEL}`;
  const step = "stop LaunchAgent";
  try {
    const stopped = deps.spawn("/bin/launchctl", ["bootout", target], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const stopDetail =
      stopped.status === 0
        ? ""
        : `bootout: ${String(stopped.stderr || stopped.stdout || stopped.error?.message || `exit ${stopped.status}`).trim()}. `;
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = deps.spawn("/bin/launchctl", ["print", target], {
        encoding: "utf8",
        timeout: 1_000,
        killSignal: "SIGKILL",
      });
      const output = String(probe.stderr || probe.stdout || "");
      // A generic nonzero status can mean permissions, a missing GUI domain, or
      // a failed command. Only this service-specific diagnostic proves absence.
      const absent =
        !probe.error &&
        !probe.signal &&
        probe.status === 113 &&
        output
          .split("\n")
          .some((line) =>
            line.trim().startsWith(`Could not find service "${BROKER_LABEL}" in domain`)
          );
      if (absent)
        return { step, ok: true, detail: `${stopDetail}Confirmed ${target} is not loaded.` };
      if (probe.status !== 0 || probe.error || probe.signal)
        return {
          step,
          ok: false,
          detail: `${stopDetail}Cannot confirm service removal: ${String(output || probe.error?.message || `exit ${probe.status}`).trim()}. Broker files were preserved.`,
        };
      if (attempt < 19) await deps.sleep(250);
    }
    return {
      step,
      ok: false,
      detail: `${stopDetail}${target} is still loaded after 20 checks. Broker files were preserved.`,
    };
  } catch (error) {
    return {
      step,
      ok: false,
      detail: `Cannot confirm service removal: ${error instanceof Error ? error.message : String(error)}. Broker files were preserved.`,
    };
  }
}

/** Remove only known broker artifacts; custom state directories may contain other files. */
function removeBroker(
  deps: BrokerDeps,
  paths: BrokerPaths,
  warnings: string[]
): BrokerSetupReport["steps"][number] {
  const failures: string[] = [];
  let stateIsSymlink = false;
  try {
    stateIsSymlink = lstatSync(paths.stateDir).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return {
        step: "remove broker",
        ok: false,
        detail: `${paths.stateDir}: ${error instanceof Error ? error.message : String(error)}`,
      };
  }
  const remove = (path: string) => {
    try {
      deps.removePath(path, { force: true, recursive: path === paths.appPath });
      if (deps.exists(path)) throw new Error("the path still exists after removal");
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const path of [
    paths.agentPath,
    paths.appPath,
    ...(stateIsSymlink ? [] : [paths.socketPath]),
    paths.logPath,
  ]) {
    remove(path);
  }
  // Retain installation metadata when any artifact failed to be removed, so
  // diagnostics and a later uninstall can still recognize the installation.
  if (!failures.length) remove(stateIsSymlink ? paths.stateDir : paths.manifestPath);
  if (!failures.length && stateIsSymlink)
    warnings.push(
      `Removed the state-directory symlink ${paths.stateDir}; files in its target were left untouched.`
    );
  if (!failures.length && !stateIsSymlink) {
    try {
      deps.removeEmptyDirectory(paths.stateDir);
      if (deps.exists(paths.stateDir)) throw new Error("the directory still exists after removal");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST")
        warnings.push(
          `Kept ${paths.stateDir} because it contains other files. Only known broker artifacts were removed.`
        );
      else if (code !== "ENOENT")
        failures.push(
          `${paths.stateDir}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
  }
  return {
    step: "remove broker",
    ok: failures.length === 0,
    detail: failures.length ? failures.join("\n") : paths.appPath,
  };
}

async function waitForBroker(deps: BrokerDeps, socketPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await deps.ping(socketPath)) return true;
    await deps.sleep(250);
  }
  return false;
}

/**
 * `setup --broker`: build, sign, and install the broker, then start it.
 * With `checkOnly`, only report; with `uninstall`, stop and remove it.
 */
export async function setupBroker(
  options: BrokerSetupOptions,
  deps: BrokerDeps = defaultBrokerDeps()
): Promise<BrokerSetupReport> {
  const steps: BrokerSetupReport["steps"] = [];
  const warnings: string[] = [];
  const paths = brokerPaths(deps.env);
  const mode = options.uninstall ? "uninstall" : options.checkOnly ? "check" : "install";
  const finish = async (): Promise<BrokerSetupReport> => {
    const installation = inspectBroker(deps);
    const stopFailed = steps.some((step) => step.step === "stop LaunchAgent" && !step.ok);
    const running =
      installation.installed || stopFailed ? await deps.ping(paths.socketPath) : false;
    const ok =
      steps.every((s) => s.ok) &&
      (mode === "uninstall" ? !installation.installed : installation.ready && running);
    return { ok, mode, steps, installation, running, warnings };
  };
  const domain = `gui/${deps.uid}`;

  if (deps.platform !== "darwin") {
    steps.push({ step: "platform", ok: false, detail: "macOS only" });
    return finish();
  }

  if (mode === "check") {
    const installation = inspectBroker(deps);
    steps.push({
      step: "inspect installed broker",
      ok: installation.ready,
      detail: installation.ready ? installation.paths.appPath : (installation.detail ?? undefined),
    });
    if (installation.manifest && !installation.manifest.signing.stable)
      warnings.push(signingWarning(installation.manifest.signing.teamId));
    return finish();
  }

  if (mode === "uninstall") {
    const stopped = await stopBroker(deps, domain);
    steps.push(stopped);
    if (!stopped.ok) return finish();
    steps.push(removeBroker(deps, paths, warnings));
    warnings.push(
      `The Full Disk Access and Automation entries for "Apple Notes MCP Broker" stay in System Settings until you remove them, or run \`tccutil reset All ${BROKER_BUNDLE_ID}\`.`
    );
    return finish();
  }

  // --- install ---
  if (Buffer.byteLength(paths.socketPath) > MAX_SOCKET_PATH_BYTES) {
    steps.push({
      step: "socket path",
      ok: false,
      detail: `${paths.socketPath} is longer than ${MAX_SOCKET_PATH_BYTES} bytes. Set ${BROKER_DIR_ENV} to a shorter directory.`,
    });
    return finish();
  }
  if (!deps.exists(deps.sourcePath)) {
    steps.push({ step: "locate source", ok: false, detail: deps.sourcePath });
    return finish();
  }
  if (!deps.exists(deps.entryPath)) {
    steps.push({
      step: "locate server entry point",
      ok: false,
      detail: `${deps.entryPath} is missing. Build the package first.`,
    });
    return finish();
  }
  const sourceSha = sha256Hex(deps.readFile(deps.sourcePath));
  steps.push({ step: "locate source", ok: true, detail: `sha256 ${sourceSha}` });
  let nodePath: string;
  let nodeSha256: string;
  const entry = deps.readFile(deps.entryPath);
  const entrySha256 = sha256Hex(entry);
  try {
    nodePath = chooseNodePath(deps);
    nodeSha256 = sha256Hex(deps.readFile(nodePath));
    const libraries = deps.spawn("/usr/bin/otool", ["-L", nodePath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (libraries.status !== 0 || !validateNodeLibraries(String(libraries.stdout ?? "")))
      throw new Error(
        "Node must link only to absolute /usr/lib or /System/Library libraries. Install a self-contained Node runtime (for example the official Node distribution), then run setup with it."
      );
    steps.push({ step: "verify Node runtime", ok: true, detail: nodePath });
  } catch (error) {
    steps.push({
      step: "verify Node runtime",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return finish();
  }

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

  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.stateDir, 0o700);
  mkdirSync(paths.appDir, { recursive: true });
  // Stage beside the final app so the rename stays on one volume.
  const staging = mkdtempSync(join(paths.appDir, ".apple-notes-mcp-broker-staging-"));
  try {
    const stagedApp = join(staging, BROKER_APP_NAME);
    const macosDir = join(stagedApp, "Contents", "MacOS");
    mkdirSync(macosDir, { recursive: true });
    const stagedBinary = join(macosDir, BROKER_EXECUTABLE);
    const digestPath = join(staging, "source-digest.swift");
    writeFileSync(digestPath, sourceDigestSwift(sourceSha), { mode: 0o600 });
    writeFileSync(join(stagedApp, "Contents", "Info.plist"), brokerInfoPlist(deps.packageVersion));
    const resources = brokerResources(stagedApp);
    mkdirSync(join(resources.entryPath, ".."), { recursive: true });
    mkdirSync(join(resources.sourcePath, ".."), { recursive: true });
    mkdirSync(join(resources.disabledHelpers, "public"), { recursive: true });
    mkdirSync(join(resources.disabledHelpers, "private"), { recursive: true });
    writeFileSync(resources.entryPath, entry);
    writeFileSync(resources.sourcePath, deps.readFile(deps.sourcePath));
    writeFileSync(
      resources.packagePath,
      JSON.stringify({ name: "apple-notes-mcp", type: "module", version: deps.packageVersion }) +
        "\n"
    );
    writeFileSync(resources.serverConfigPath, "{}\n");
    writeFileSync(
      resources.configPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          nodePath,
          nodeSha256,
          packageVersion: deps.packageVersion,
          entrySha256,
        },
        null,
        2
      ) + "\n"
    );

    const compile = deps.spawn(
      "/usr/bin/xcrun",
      brokerCompileArguments(deps.sourcePath, digestPath, stagedBinary),
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
    rmSync(digestPath, { force: true });
    steps.push({ step: "compile", ok: true });

    const identities = deps.spawn(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" }
    );
    let signing: SigningIdentity;
    try {
      signing = chooseSigningIdentity(
        String(identities.stdout ?? ""),
        options.signIdentity ?? deps.env[BROKER_SIGN_IDENTITY_ENV]
      );
    } catch (error) {
      steps.push({
        step: "choose signing identity",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return finish();
    }
    const sign = deps.spawn(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        signing.identity,
        "--identifier",
        BROKER_BUNDLE_ID,
        "--timestamp=none",
        "--options",
        "runtime",
        stagedApp,
      ],
      { encoding: "utf8", timeout: 60_000 }
    );
    if (sign.status !== 0) {
      steps.push({
        step: "sign",
        ok: false,
        detail: `${signing.name}: ${String(sign.stderr || "codesign failed").trim()}`,
      });
      return finish();
    }
    const described = deps.spawn("/usr/bin/codesign", ["-dv", "--verbose=2", stagedApp], {
      encoding: "utf8",
    });
    const description = String(described.stderr ?? "") + String(described.stdout ?? "");
    const teamId = parseTeamId(description);
    const stable = teamId !== null && /^Authority=Developer ID Application:/m.test(description);
    steps.push({
      step: "sign",
      ok: true,
      detail: teamId ? `${signing.name} (team ${teamId})` : "ad-hoc",
    });
    if (!stable) warnings.push(signingWarning(teamId));
    const verified = deps.spawn(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--deep", stagedApp],
      {
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    if (verified.status !== 0) {
      steps.push({
        step: "verify signature",
        ok: false,
        detail: String(verified.stderr || "The signed bundle failed verification.").trim(),
      });
      return finish();
    }
    steps.push({ step: "verify signature", ok: true });

    const hello = deps.spawn(stagedBinary, [], {
      input: JSON.stringify({ type: "hello" }) + "\n",
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    type Handshake = {
      protocolVersion?: unknown;
      sourceSha256?: unknown;
      packageVersion?: unknown;
      entrySha256?: unknown;
    };
    let handshake: Handshake | null = null;
    try {
      handshake = JSON.parse(String(hello.stdout ?? "").trim()) as Handshake | null;
    } catch {
      handshake = null;
    }
    if (
      hello.status !== 0 ||
      handshake?.protocolVersion !== BROKER_PROTOCOL ||
      handshake?.sourceSha256 !== sourceSha ||
      handshake?.packageVersion !== deps.packageVersion ||
      handshake?.entrySha256 !== entrySha256
    ) {
      steps.push({
        step: "handshake",
        ok: false,
        detail: handshake
          ? `broker reported protocol ${String(handshake.protocolVersion)}, source ${String(handshake.sourceSha256)}`
          : `no valid hello (exit ${hello.status})`,
      });
      return finish();
    }
    steps.push({ step: "handshake", ok: true });

    // bootout can return before launchd removes the old service.
    const stopped = await stopBroker(deps, domain);
    steps.push(stopped);
    if (!stopped.ok) return finish();
    rmSync(paths.appPath, { recursive: true, force: true });
    renameSync(stagedApp, paths.appPath);
    const manifest: BrokerManifest = {
      schemaVersion: 2,
      protocolVersion: BROKER_PROTOCOL,
      packageVersion: deps.packageVersion,
      sourceSha256: sourceSha,
      binarySha256: sha256Hex(deps.readFile(paths.executablePath)),
      nodeSha256,
      entrySha256,
      appPath: paths.appPath,
      agentPath: paths.agentPath,
      socketPath: paths.socketPath,
      logPath: paths.logPath,
      nodePath,
      entryPath: brokerResources(paths.appPath).entryPath,
      signing: { identity: signing.name, teamId, stable },
      builtAt: deps.now().toISOString(),
      compiler,
    };
    writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    steps.push({ step: "install app", ok: true, detail: paths.appPath });

    mkdirSync(join(paths.agentPath, ".."), { recursive: true });
    writeFileSync(
      paths.agentPath,
      brokerLaunchAgentPlist({
        executablePath: paths.executablePath,
        socketPath: paths.socketPath,
      }),
      { mode: 0o644 }
    );
    const bootstrap = launchctl(deps, ["bootstrap", domain, paths.agentPath]);
    if (bootstrap.status !== 0) {
      steps.push({
        step: "start LaunchAgent",
        ok: false,
        detail: String(bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed").trim(),
      });
      return finish();
    }
    steps.push({ step: "start LaunchAgent", ok: true, detail: paths.agentPath });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const answered = await waitForBroker(deps, paths.socketPath);
  steps.push({
    step: "broker answers",
    ok: answered,
    detail: answered
      ? paths.socketPath
      : `no answer on ${paths.socketPath}; inspect diagnostics with \`${BROKER_LOG_COMMAND}\``,
  });
  return finish();
}

function signingWarning(teamId: string | null): string {
  return teamId
    ? "This signing identity does not establish Developer ID continuity. Apple Development certificate renewal can change the designated requirement and require granting permissions again."
    : "The broker is ad-hoc signed, so macOS ties its grants to this exact build: after every rebuild, grant Full Disk Access and Automation again. A Developer ID Application identity can retain the bundle and team designated requirement across rebuilds.";
}

/** Terminal summary for `setup --broker`. */
export function formatBrokerSetup(report: BrokerSetupReport): string {
  const lines = ["Apple Notes MCP permission broker", ""];
  for (const step of report.steps)
    lines.push(`${step.ok ? "✓" : "✗"} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
  for (const warning of report.warnings) lines.push(`! ${warning}`);
  lines.push("");
  const app = report.installation.paths.appPath;
  if (report.mode === "uninstall") {
    lines.push(
      report.ok
        ? "The broker is removed. MCP clients now run the server in-process again."
        : "The broker was not fully removed. Fix the failed step above and run it again."
    );
  } else if (report.ok) {
    lines.push(
      `The broker is ${report.mode === "check" ? "installed and" : "installed and"} running. MCP clients that launch apple-notes-mcp now reach it through the broker.`,
      "",
      "Grant it access once:",
      `  1. System Settings > Privacy & Security > Full Disk Access: click +, add ${app}, and turn it on.`,
      "  2. The first Notes request through the broker asks to let Apple Notes MCP Broker control Notes. Click Allow.",
      "",
      "Restart your MCP client so it starts a fresh apple-notes-mcp process."
    );
  } else if (report.mode === "check") {
    lines.push(
      report.installation.installed && !report.running && report.installation.ready
        ? `The broker is installed but not answering. Inspect diagnostics with \`${BROKER_LOG_COMMAND}\`, or run \`${BROKER_SETUP_COMMAND}\` again.`
        : `Run \`${BROKER_SETUP_COMMAND}\` to install it.`
    );
  } else {
    lines.push("The broker was not installed. Fix the failed step above and run setup again.");
  }
  return lines.join("\n");
}

/** What doctor and get-capabilities report about the broker. */
export interface BrokerStatus {
  /** True when this server process was started by the broker. */
  inUse: boolean;
  installed: boolean;
  ready: boolean;
  appPath: string | null;
  stableSigning: boolean | null;
  /** Why this process runs in-process although a broker is installed. */
  fallbackReason: string | null;
  detail: string;
}

let proxyFallbackReason: string | null = null;

/** Recorded by the proxy when it could not reach an installed broker. */
export function recordBrokerFallback(reason: string | null): void {
  proxyFallbackReason = reason;
}

/** Synchronous broker status for this process. Never touches the socket. */
export function brokerStatus(deps: BrokerDeps = defaultBrokerDeps()): BrokerStatus {
  const inUse = deps.env[BROKERED_ENV] === "1";
  let installation: BrokerInstallation | null = null;
  try {
    installation = inspectBroker(deps);
  } catch {
    installation = null;
  }
  const manifest = installation?.manifest ?? null;
  const base = {
    inUse,
    installed: installation?.installed ?? false,
    ready: installation?.ready ?? false,
    appPath: inUse
      ? (deps.env[BROKER_APP_ENV] ?? manifest?.appPath ?? null)
      : (manifest?.appPath ?? null),
    stableSigning: manifest ? manifest.signing.stable : null,
    fallbackReason: inUse ? null : proxyFallbackReason,
  };
  let detail: string;
  if (inUse)
    detail = `In use: this server runs under ${base.appPath ?? "the broker app"}, which holds the Full Disk Access and Automation grants.`;
  else if (!base.installed)
    detail = `Not installed. Grants apply to the app or Node binary that launches this server. \`${BROKER_SETUP_COMMAND}\` moves them to one signed app.`;
  else if (deps.env[BROKER_MODE_ENV] === "off")
    detail = `Installed but turned off with ${BROKER_MODE_ENV}=off; running in-process.`;
  else
    detail = `Installed but not in use; running in-process.${base.fallbackReason ? ` ${base.fallbackReason}` : ""}${installation?.detail ? ` ${installation.detail}` : ""}`;
  return { ...base, detail };
}
