import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BROKER_APP_NAME,
  BROKER_BUNDLE_ID,
  BROKER_EXECUTABLE,
  BROKER_PROTOCOL,
  brokerCompileArguments,
  brokerInfoPlist,
  brokerLaunchAgentPlist,
  brokerPaths,
  brokerResources,
  brokerStatus,
  chooseNodePath,
  chooseSigningIdentity,
  defaultBrokerDeps,
  formatBrokerSetup,
  inspectBroker,
  parseBrokerArgs,
  parseTeamId,
  recordBrokerFallback,
  setupBroker,
  validateNodeLibraries,
  type BrokerDeps,
  type BrokerManifest,
} from "@/services/broker.js";
import { sha256Hex } from "@/services/publicHelper.js";

const SECURITY_OUTPUT = `  1) 1111111111111111111111111111111111111111 "Apple Development: Dev Person (AAAAAAAAAA)"
  2) 2222222222222222222222222222222222222222 "Developer ID Application: Dev Person (TEAM123456)"
     2 valid identities found
`;

const DEVELOPER_ID_OUTPUT = SECURITY_OUTPUT.split("\n")[1];

let root: string;
let env: NodeJS.ProcessEnv;
let sourcePath: string;
let entryPath: string;
let nodePath: string;
let logFixturePath: string;

const SERVICE_ABSENT = {
  status: 113,
  stderr: `Could not find service "${BROKER_BUNDLE_ID}" in domain for user gui: 501\n`,
};

type SpawnResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};
type SpawnOptions = { input?: string; timeout?: number; killSignal?: string };
type SpawnHandler = (cmd: string, args: string[], opts: SpawnOptions) => SpawnResult;

function makeSpawn(handler: SpawnHandler, calls: Array<[string, string[]]>): typeof spawnSync {
  return ((cmd: string, args: string[], opts: SpawnOptions) => {
    calls.push([cmd, args]);
    return {
      pid: 1,
      output: [],
      signal: null,
      stdout: "",
      stderr: "",
      ...handler(cmd, args, opts ?? {}),
    };
  }) as unknown as typeof spawnSync;
}

/** A spawn that behaves like a working toolchain, with per-step overrides. */
function toolchain(overrides: Partial<Record<string, SpawnResult>> = {}): SpawnHandler {
  const sourceSha = sha256Hex(readFileSync(sourcePath));
  return (cmd, args) => {
    if (cmd === "/usr/bin/otool")
      return (
        overrides.libraries ?? {
          status: 0,
          stdout: `${args[1]}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)\n`,
        }
      );
    if (cmd === "/usr/bin/xcrun" && args[1] === "--version")
      return overrides.version ?? { status: 0, stdout: "Apple Swift version 6.3\nTarget: arm64" };
    if (cmd === "/usr/bin/xcrun") {
      if (overrides.compile) return overrides.compile;
      writeFileSync(args[args.length - 1], "binary");
      return { status: 0 };
    }
    if (cmd === "/usr/bin/security")
      return overrides.security ?? { status: 0, stdout: DEVELOPER_ID_OUTPUT };
    if (cmd === "/usr/bin/codesign" && args[0] === "-dv")
      return (
        overrides.describe ?? {
          status: 0,
          stderr:
            "Identifier=apple-notes-mcp.broker\nAuthority=Developer ID Application: Dev Person (TEAM123456)\nTeamIdentifier=TEAM123456\n",
        }
      );
    if (cmd === "/usr/bin/codesign" && args[0] === "--verify")
      return overrides.verify ?? { status: 0 };
    if (cmd === "/usr/bin/codesign") return overrides.sign ?? { status: 0 };
    if (cmd === "/bin/launchctl" && args[0] === "bootstrap")
      return overrides.bootstrap ?? { status: 0 };
    if (cmd === "/bin/launchctl" && args[0] === "print") return overrides.print ?? SERVICE_ABSENT;
    if (cmd === "/bin/launchctl" && args[0] === "bootout")
      return overrides.bootout ?? { status: 0 };
    if (cmd === "/bin/launchctl") return { status: 0 };
    // the staged broker binary: the hello handshake
    return (
      overrides.hello ?? {
        status: 0,
        stdout: JSON.stringify({
          type: "hello",
          protocolVersion: BROKER_PROTOCOL,
          sourceSha256: sourceSha,
          packageVersion: "9.9.9",
          entrySha256: sha256Hex(readFileSync(entryPath)),
        }),
      }
    );
  };
}

function deps(overrides: Partial<BrokerDeps> = {}): BrokerDeps {
  return defaultBrokerDeps({
    env,
    platform: "darwin",
    sourcePath,
    entryPath,
    execPath: nodePath,
    packageVersion: "9.9.9",
    uid: 501,
    exists: (path) => existsSync(path === brokerPaths(env).logPath ? logFixturePath : path),
    removePath: (path, options) => {
      const fixturePath = path === brokerPaths(env).logPath ? logFixturePath : path;
      if (typeof fixturePath !== "string" || !fixturePath.startsWith(root + "/"))
        throw new Error(`Test attempted removal outside its fixture: ${String(path)}`);
      rmSync(fixturePath, options);
    },
    spawn: makeSpawn(toolchain(), []),
    ping: async () => true,
    sleep: async () => {},
    now: () => new Date("2026-10-05T12:00:00Z"),
    ...overrides,
  });
}

function writeManifest(overrides: Partial<BrokerManifest> = {}): BrokerManifest {
  const paths = brokerPaths(env);
  mkdirSync(join(paths.appPath, "Contents", "MacOS"), { recursive: true });
  writeFileSync(paths.executablePath, "binary");
  mkdirSync(join(paths.agentPath, ".."), { recursive: true });
  writeFileSync(paths.agentPath, "<plist/>");
  mkdirSync(paths.stateDir, { recursive: true });
  const manifest: BrokerManifest = {
    schemaVersion: 2,
    protocolVersion: BROKER_PROTOCOL,
    packageVersion: "9.9.9",
    sourceSha256: sha256Hex(readFileSync(sourcePath)),
    binarySha256: sha256Hex("binary"),
    nodeSha256: sha256Hex(readFileSync(nodePath)),
    entrySha256: sha256Hex(readFileSync(entryPath)),
    appPath: paths.appPath,
    agentPath: paths.agentPath,
    socketPath: paths.socketPath,
    logPath: paths.logPath,
    nodePath,
    entryPath: brokerResources(paths.appPath).entryPath,
    signing: {
      identity: "Developer ID Application: Dev Person (TEAM123456)",
      teamId: "TEAM123456",
      stable: true,
    },
    builtAt: "2026-10-05T12:00:00.000Z",
    compiler: "Apple Swift version 6.3",
    ...overrides,
  };
  const resources = brokerResources(paths.appPath);
  mkdirSync(join(resources.entryPath, ".."), { recursive: true });
  mkdirSync(join(resources.sourcePath, ".."), { recursive: true });
  mkdirSync(join(resources.disabledHelpers, "public"), { recursive: true });
  mkdirSync(join(resources.disabledHelpers, "private"), { recursive: true });
  writeFileSync(resources.entryPath, readFileSync(entryPath));
  writeFileSync(resources.sourcePath, readFileSync(sourcePath));
  writeFileSync(resources.serverConfigPath, "{}\n");
  writeFileSync(
    resources.packagePath,
    JSON.stringify({ name: "apple-notes-mcp", type: "module", version: manifest.packageVersion })
  );
  writeFileSync(
    resources.configPath,
    JSON.stringify({
      schemaVersion: 1,
      nodePath: manifest.nodePath,
      nodeSha256: manifest.nodeSha256,
      packageVersion: manifest.packageVersion,
      entrySha256: manifest.entrySha256,
    })
  );
  writeFileSync(paths.manifestPath, JSON.stringify(manifest));
  return manifest;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "anm-broker-")));
  env = {
    APPLE_NOTES_MCP_BROKER_DIR: join(root, "state"),
    APPLE_NOTES_MCP_BROKER_APP_DIR: join(root, "Applications"),
    APPLE_NOTES_MCP_BROKER_AGENT_DIR: join(root, "LaunchAgents"),
    PATH: "",
  };
  sourcePath = join(root, "broker.swift");
  writeFileSync(sourcePath, "// broker source");
  entryPath = join(root, "build", "index.js");
  mkdirSync(join(root, "build"));
  writeFileSync(entryPath, "// entry");
  nodePath = join(root, "bin", "node");
  mkdirSync(join(root, "bin"));
  writeFileSync(nodePath, "node");
  logFixturePath = join(root, "broker.log");
  recordBrokerFallback(null);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("brokerPaths", () => {
  it("honors the directory overrides", () => {
    const paths = brokerPaths(env);
    expect(paths.manifestPath).toBe(join(root, "state", "manifest.json"));
    expect(paths.socketPath).toBe(join(root, "state", "broker.sock"));
    expect(paths.appPath).toBe(join(root, "Applications", BROKER_APP_NAME));
    expect(paths.executablePath).toBe(
      join(root, "Applications", BROKER_APP_NAME, "Contents", "MacOS", BROKER_EXECUTABLE)
    );
    expect(paths.agentPath).toBe(join(root, "LaunchAgents", "apple-notes-mcp.broker.plist"));
  });

  it("defaults to per-user locations", () => {
    const paths = brokerPaths({});
    expect(paths.stateDir).toMatch(/Library\/Application Support\/apple-notes-mcp\/broker$/);
    expect(paths.appDir).toMatch(/\/Applications$/);
    expect(paths.agentPath).toMatch(/Library\/LaunchAgents\/apple-notes-mcp\.broker\.plist$/);
    expect(paths.logPath).toMatch(/Library\/Logs\/apple-notes-mcp-broker\.log$/);
  });
});

describe("inspectBroker", () => {
  it("is macOS only", () => {
    expect(inspectBroker(deps({ platform: "linux" })).reason).toBe("unsupported_platform");
  });

  it("reports not installed without a manifest", () => {
    const result = inspectBroker(deps());
    expect(result).toMatchObject({
      installed: false,
      ready: false,
      reason: "broker_not_installed",
    });
  });

  it("is ready when everything matches", () => {
    writeManifest();
    expect(inspectBroker(deps())).toMatchObject({ installed: true, ready: true, reason: null });
  });

  it("fails closed on an unreadable manifest", () => {
    const paths = brokerPaths(env);
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.manifestPath, "{not json");
    expect(inspectBroker(deps()).reason).toBe("broker_manifest_invalid");
  });

  it("reports a missing app", () => {
    writeManifest();
    rmSync(brokerPaths(env).appPath, { recursive: true });
    expect(inspectBroker(deps())).toMatchObject({
      installed: true,
      reason: "broker_not_installed",
    });
  });

  it("reports a stale build when the source or protocol changed", () => {
    writeManifest({ sourceSha256: "0".repeat(64) });
    expect(inspectBroker(deps()).reason).toBe("broker_stale");
    writeManifest({ protocolVersion: BROKER_PROTOCOL + 1 });
    expect(inspectBroker(deps()).reason).toBe("broker_stale");
    writeManifest();
    expect(inspectBroker(deps({ sourcePath: join(root, "missing.swift") })).reason).toBe(
      "broker_stale"
    );
  });

  it("reports a modified binary", () => {
    writeManifest();
    writeFileSync(brokerPaths(env).executablePath, "tampered");
    expect(inspectBroker(deps()).reason).toBe("broker_modified");
  });

  it("rejects an outdated package even when the Swift source is unchanged", () => {
    writeManifest();
    expect(inspectBroker(deps({ packageVersion: "10.0.0" })).reason).toBe("broker_stale");
    writeFileSync(entryPath, "// newer server build at the same version");
    expect(inspectBroker(deps()).reason).toBe("broker_stale");
  });

  it.each(["entryPath", "sourcePath", "serverConfigPath", "packagePath", "configPath"] as const)(
    "rejects a modified sealed %s",
    (resource) => {
      writeManifest();
      writeFileSync(brokerResources(brokerPaths(env).appPath)[resource], "tampered");
      expect(inspectBroker(deps()).reason).toBe("broker_modified");
    }
  );

  it("rejects a replaced Node runtime", () => {
    writeManifest();
    writeFileSync(nodePath, "replacement executable");
    expect(inspectBroker(deps()).reason).toBe("broker_modified");
  });

  it("rejects manifest redirection to code outside the bundle", () => {
    writeManifest({ entryPath });
    expect(inspectBroker(deps()).reason).toBe("broker_modified");
    writeManifest({ appPath: join(root, "other.app") });
    expect(inspectBroker(deps()).reason).toBe("broker_modified");
  });

  it("rejects a mutable symlink as the configured Node path", () => {
    const alias = join(root, "node-alias");
    symlinkSync(nodePath, alias);
    writeManifest({ nodePath: alias });
    expect(inspectBroker(deps()).reason).toBe("broker_modified");
  });

  it("rejects manifest edits that disagree with the sealed configuration", () => {
    const manifest = writeManifest();
    const replacement = join(root, "replacement-node");
    writeFileSync(replacement, "replacement");
    writeFileSync(
      brokerPaths(env).manifestPath,
      JSON.stringify({ ...manifest, nodePath: replacement, nodeSha256: sha256Hex("replacement") })
    );
    expect(inspectBroker(deps()).reason).toBe("broker_modified");
  });

  it("requires strict deep signature verification even when all recorded hashes match", () => {
    writeManifest();
    const calls: Array<[string, string[]]> = [];
    const installation = inspectBroker(
      deps({ spawn: makeSpawn(toolchain({ verify: { status: 1 } }), calls) })
    );
    expect(installation.reason).toBe("broker_modified");
    expect(calls).toContainEqual([
      "/usr/bin/codesign",
      ["--verify", "--strict", "--deep", brokerPaths(env).appPath],
    ]);
  });

  it("reports a missing LaunchAgent, Node binary, or entry point", () => {
    writeManifest();
    rmSync(brokerPaths(env).agentPath);
    expect(inspectBroker(deps()).reason).toBe("broker_agent_missing");
    writeManifest({ nodePath: join(root, "gone", "node") });
    expect(inspectBroker(deps()).reason).toBe("broker_node_missing");
    expect(inspectBroker(deps()).detail).toMatch(/grants stay with the broker app/);
    writeManifest();
    rmSync(brokerResources(brokerPaths(env).appPath).entryPath);
    expect(inspectBroker(deps()).reason).toBe("broker_entry_missing");
  });
});

describe("generated files", () => {
  it("builds an Info.plist that keeps the broker out of the Dock and explains Automation", () => {
    const plist = brokerInfoPlist("1.2.3 <beta>");
    expect(plist).toContain(`<string>${BROKER_BUNDLE_ID}</string>`);
    expect(plist).toContain(`<string>${BROKER_EXECUTABLE}</string>`);
    expect(plist).toContain("<key>LSUIElement</key>\n  <true/>");
    expect(plist).toContain("NSAppleEventsUsageDescription");
    expect(plist).toContain("1.2.3 &lt;beta&gt;");
  });

  it("pins the compiler arguments", () => {
    expect(brokerCompileArguments("/s.swift", "/d.swift", "/out")).toEqual([
      "swiftc",
      "-O",
      "-parse-as-library",
      "/s.swift",
      "/d.swift",
      "-o",
      "/out",
    ]);
  });

  it("writes a LaunchAgent that serves the socket with escaped paths", () => {
    const plist = brokerLaunchAgentPlist({
      executablePath: "/A&B/broker",
      socketPath: "/s.sock",
    });
    expect(plist).toContain("<string>/A&amp;B/broker</string>\n    <string>serve</string>");
    expect(plist).toContain("<string>--socket</string>\n    <string>/s.sock</string>");
    expect(plist).not.toContain("--node");
    expect(plist).not.toContain("--entry");
    expect(plist).not.toContain("--log");
    expect(plist).toContain("<key>StandardErrorPath</key>\n  <string>/dev/null</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>AssociatedBundleIdentifiers</key>");
  });
});

describe("signing", () => {
  it("requires an explicit choice across qualifying certificate types or teams", () => {
    expect(() => chooseSigningIdentity(SECURITY_OUTPUT, undefined)).toThrow("--sign-identity");
    expect(
      chooseSigningIdentity(SECURITY_OUTPUT, "2222222222222222222222222222222222222222").name
    ).toBe("Developer ID Application: Dev Person (TEAM123456)");
  });
  it("uses the only qualifying identity, or ad-hoc when none qualify", () => {
    expect(chooseSigningIdentity(DEVELOPER_ID_OUTPUT, undefined)).toEqual({
      identity: "2222222222222222222222222222222222222222",
      name: "Developer ID Application: Dev Person (TEAM123456)",
    });
    const devOnly = SECURITY_OUTPUT.split("\n")[0];
    expect(chooseSigningIdentity(devOnly, undefined).name).toMatch(/^Apple Development:/);
    expect(chooseSigningIdentity("0 valid identities found", undefined)).toEqual({
      identity: "-",
      name: "ad-hoc",
    });
  });

  it("honors an explicit identity", () => {
    expect(chooseSigningIdentity(SECURITY_OUTPUT, " My Cert ")).toEqual({
      identity: "My Cert",
      name: "My Cert",
    });
    expect(chooseSigningIdentity(SECURITY_OUTPUT, "-")).toEqual({ identity: "-", name: "ad-hoc" });
    expect(chooseSigningIdentity(DEVELOPER_ID_OUTPUT, "  ").name).toMatch(/^Developer ID/);
  });

  it("reads the team identifier", () => {
    expect(parseTeamId("Identifier=x\nTeamIdentifier=TEAM123456\n")).toBe("TEAM123456");
    expect(parseTeamId("Signature=adhoc\nTeamIdentifier=not set\n")).toBeNull();
    expect(parseTeamId("TeamIdentifier=not set\n")).toBeNull();
    expect(parseTeamId("")).toBeNull();
  });
});

describe("chooseNodePath", () => {
  it("pins the canonical running executable", () => {
    expect(
      chooseNodePath({ execPath: "/opt/homebrew/bin/node", realpath: () => "/cellar/26/node" })
    ).toBe("/cellar/26/node");
  });

  it("fails closed when the executable cannot be resolved", () => {
    expect(() =>
      chooseNodePath({
        execPath: "/gone/node",
        realpath: () => {
          throw new Error("gone");
        },
      })
    ).toThrow("gone");
    expect(() => chooseNodePath({ execPath: "node", realpath: () => "node" })).toThrow(
      "absolute path"
    );
  });
});

describe("validateNodeLibraries", () => {
  it("accepts only system libraries, including universal binary headings", () => {
    expect(
      validateNodeLibraries(
        "/node (architecture arm64):\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n/node (architecture x86_64):\n\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3200.0.0)\n"
      )
    ).toBe(true);
  });

  it.each([
    "@rpath/libnode.dylib",
    "@loader_path/libnode.dylib",
    "/opt/homebrew/lib/libicu.dylib",
    "/usr/lib/../../tmp/evil.dylib",
    "relative.dylib",
  ])("rejects %s", (library) => {
    expect(
      validateNodeLibraries(
        `/node:\n\t${library} (compatibility version 1.0.0, current version 1.0.0)\n`
      )
    ).toBe(false);
  });

  it("rejects empty or malformed output", () => {
    expect(validateNodeLibraries("")).toBe(false);
    expect(validateNodeLibraries("/node:\n")).toBe(false);
    expect(validateNodeLibraries("/node:\n\tunexpected output")).toBe(false);
  });
});

describe("parseBrokerArgs", () => {
  it("reads the flags", () => {
    expect(parseBrokerArgs(["--broker"])).toEqual({
      checkOnly: false,
      uninstall: false,
      signIdentity: undefined,
    });
    expect(parseBrokerArgs(["--broker", "--check", "--uninstall", "--sign-identity", "X"])).toEqual(
      { checkOnly: true, uninstall: true, signIdentity: "X" }
    );
  });
});

describe("setupBroker install", () => {
  it("copies fixed resources before signing and verifies before running any bundled code", async () => {
    let signed = false;
    let verified = false;
    const handler = toolchain();
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({
        spawn: makeSpawn((cmd, args, opts) => {
          if (cmd === "/usr/bin/codesign" && args[0] === "--force") {
            const resources = brokerResources(args.at(-1)!);
            expect(readFileSync(resources.entryPath)).toEqual(readFileSync(entryPath));
            expect(readFileSync(resources.sourcePath)).toEqual(readFileSync(sourcePath));
            expect(JSON.parse(readFileSync(resources.packagePath, "utf8"))).toEqual({
              name: "apple-notes-mcp",
              type: "module",
              version: "9.9.9",
            });
            expect(JSON.parse(readFileSync(resources.configPath, "utf8"))).toEqual({
              schemaVersion: 1,
              nodePath,
              nodeSha256: sha256Hex(readFileSync(nodePath)),
              packageVersion: "9.9.9",
              entrySha256: sha256Hex(readFileSync(entryPath)),
            });
            expect(readFileSync(resources.serverConfigPath, "utf8")).toBe("{}\n");
            expect(readdirSync(join(resources.disabledHelpers, "public"))).toEqual([]);
            expect(readdirSync(join(resources.disabledHelpers, "private"))).toEqual([]);
            expect(readdirSync(join(resources.resources, "server", "native"))).toEqual(["broker"]);
            expect(args).not.toContain("--entitlements");
            signed = true;
          }
          if (cmd === "/usr/bin/codesign" && args[0] === "--verify") {
            expect(signed).toBe(true);
            verified = true;
          }
          if (cmd.endsWith(BROKER_EXECUTABLE)) {
            expect(verified).toBe(true);
            expect(args).toEqual([]);
          }
          return handler(cmd, args, opts);
        }, []),
      })
    );
    expect(report.ok).toBe(true);
    expect(signed && verified).toBe(true);
    const agent = readFileSync(brokerPaths(env).agentPath, "utf8");
    expect(agent).not.toContain("--node");
    expect(agent).not.toContain("--entry");
  });

  it("stops before installing or executing code when signature verification fails", async () => {
    const calls: Array<[string, string[]]> = [];
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ spawn: makeSpawn(toolchain({ verify: { status: 1 } }), calls) })
    );
    expect(report.ok).toBe(false);
    expect(calls.some(([cmd]) => cmd.endsWith(BROKER_EXECUTABLE))).toBe(false);
    expect(calls.some(([cmd]) => cmd === "/bin/launchctl")).toBe(false);
    expect(existsSync(brokerPaths(env).appPath)).toBe(false);
  });

  it("refuses a Node runtime linked to mutable external libraries", async () => {
    const calls: Array<[string, string[]]> = [];
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({
        spawn: makeSpawn(
          toolchain({
            libraries: {
              status: 0,
              stdout: `${nodePath}:\n\t/opt/homebrew/lib/libicu.dylib (compatibility version 1.0.0, current version 1.0.0)\n`,
            },
          }),
          calls
        ),
      })
    );
    expect(report.steps.at(-1)).toMatchObject({ step: "verify Node runtime", ok: false });
    expect(calls.some(([cmd]) => cmd === "/usr/bin/codesign")).toBe(false);
  });

  it("requires an explicit identity when the keychain is ambiguous", async () => {
    const calls: Array<[string, string[]]> = [];
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({
        spawn: makeSpawn(toolchain({ security: { status: 0, stdout: SECURITY_OUTPUT } }), calls),
      })
    );
    expect(report.steps.at(-1)).toMatchObject({ step: "choose signing identity", ok: false });
    expect(calls.some(([cmd]) => cmd === "/usr/bin/codesign")).toBe(false);
  });

  it("does not promise permission continuity for Apple Development certificates", async () => {
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({
        spawn: makeSpawn(
          toolchain({
            security: { status: 0, stdout: SECURITY_OUTPUT.split("\n")[0] },
            describe: {
              status: 0,
              stderr:
                "Authority=Apple Development: Dev Person (AAAAAAAAAA)\nTeamIdentifier=AAAAAAAAAA\n",
            },
          }),
          []
        ),
      })
    );
    expect(report.ok).toBe(true);
    expect(report.installation.manifest?.signing.stable).toBe(false);
    expect(report.warnings.join(" ")).toContain("certificate renewal");
    expect(report.warnings.join(" ")).not.toContain("ad-hoc signed");
  });

  it.each(["packageVersion", "entrySha256"])(
    "rejects a hello with a different %s",
    async (field) => {
      const report = await setupBroker(
        { checkOnly: false, uninstall: false },
        deps({
          spawn: makeSpawn(
            toolchain({
              hello: {
                status: 0,
                stdout: JSON.stringify({
                  protocolVersion: BROKER_PROTOCOL,
                  sourceSha256: sha256Hex(readFileSync(sourcePath)),
                  packageVersion: "9.9.9",
                  entrySha256: sha256Hex(readFileSync(entryPath)),
                  [field]: "mismatch",
                }),
              },
            }),
            []
          ),
        })
      );
      expect(report.steps.at(-1)).toMatchObject({ step: "handshake", ok: false });
    }
  );

  it("builds, signs, installs, starts, and verifies the broker", async () => {
    const calls: Array<[string, string[]]> = [];
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ spawn: makeSpawn(toolchain(), calls) })
    );
    expect(report.ok).toBe(true);
    expect(report.running).toBe(true);
    expect(report.warnings).toEqual([]);
    const paths = brokerPaths(env);
    const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8")) as BrokerManifest;
    expect(manifest).toMatchObject({
      packageVersion: "9.9.9",
      nodePath,
      entryPath: brokerResources(paths.appPath).entryPath,
      nodeSha256: sha256Hex(readFileSync(nodePath)),
      entrySha256: sha256Hex(readFileSync(entryPath)),
      signing: { teamId: "TEAM123456", stable: true },
    });
    expect(readFileSync(join(paths.appPath, "Contents", "Info.plist"), "utf8")).toContain(
      BROKER_BUNDLE_ID
    );
    expect(readFileSync(paths.agentPath, "utf8")).toContain(paths.socketPath);
    const sign = calls.find(([cmd, args]) => cmd === "/usr/bin/codesign" && args[0] === "--force");
    expect(sign?.[1]).toEqual([
      "--force",
      "--sign",
      "2222222222222222222222222222222222222222",
      "--identifier",
      BROKER_BUNDLE_ID,
      "--timestamp=none",
      "--options",
      "runtime",
      expect.stringContaining(BROKER_APP_NAME),
    ]);
    expect(calls).toContainEqual(["/bin/launchctl", ["bootout", "gui/501/apple-notes-mcp.broker"]]);
    expect(calls).toContainEqual(["/bin/launchctl", ["bootstrap", "gui/501", paths.agentPath]]);
    const text = formatBrokerSetup(report);
    expect(text).toContain("installed and running");
    expect(text).toContain("Full Disk Access: click +");
  });

  it("warns that an ad-hoc signature loses grants on rebuild", async () => {
    const report = await setupBroker(
      { checkOnly: false, uninstall: false, signIdentity: "-" },
      deps({
        spawn: makeSpawn(
          toolchain({ describe: { status: 0, stderr: "Signature=adhoc\nTeamIdentifier=not set" } }),
          []
        ),
      })
    );
    expect(report.ok).toBe(true);
    expect(report.steps.find((s) => s.step === "sign")?.detail).toBe("ad-hoc");
    expect(report.warnings.join(" ")).toMatch(/ad-hoc signed/);
    expect(formatBrokerSetup(report)).toContain("! The broker is ad-hoc signed");
  });

  it("seals a copy when run from the npx cache", async () => {
    const npxEntry = join(root, "_npx", "abc", "build", "index.js");
    mkdirSync(join(npxEntry, ".."), { recursive: true });
    writeFileSync(npxEntry, readFileSync(entryPath));
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ entryPath: npxEntry, spawn: makeSpawn(toolchain(), []) })
    );
    expect(report.ok).toBe(true);
    expect(report.installation.manifest?.entryPath).toBe(
      brokerResources(brokerPaths(env).appPath).entryPath
    );
    rmSync(npxEntry);
    expect(readFileSync(brokerResources(brokerPaths(env).appPath).entryPath, "utf8")).toBe(
      "// entry"
    );
  });

  it.each([
    ["verify Node runtime", { libraries: { status: 1 } }],
    ["find compiler", { version: { status: 1 } }],
    ["compile", { compile: { status: 1, stderr: "error: nope" } }],
    ["compile", { compile: { status: null, error: new Error("timeout") } }],
    ["sign", { sign: { status: 1, stderr: "no identity" } }],
    ["verify signature", { verify: { status: 1, stderr: "resource envelope invalid" } }],
    ["handshake", { hello: { status: 1, stdout: "" } }],
    ["handshake", { hello: { status: 0, stdout: JSON.stringify({ protocolVersion: 99 }) } }],
    ["start LaunchAgent", { bootstrap: { status: 5, stderr: "Bootstrap failed" } }],
  ] as Array<[string, Partial<Record<string, SpawnResult>>]>)(
    "stops at a failed %s step",
    async (step, overrides) => {
      const report = await setupBroker(
        { checkOnly: false, uninstall: false },
        deps({ spawn: makeSpawn(toolchain(overrides), []) })
      );
      expect(report.ok).toBe(false);
      expect(report.steps.at(-1)).toMatchObject({ step, ok: false });
      expect(formatBrokerSetup(report)).toContain("The broker was not installed.");
    }
  );

  it("reports a broker that never answers", async () => {
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ spawn: makeSpawn(toolchain(), []), ping: async () => false })
    );
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ step: "broker answers", ok: false });
    expect(report.steps.at(-1)?.detail).toContain("log show --last 10m");
    expect(report.steps.at(-1)?.detail).not.toContain(brokerPaths(env).logPath);
  });

  it("refuses a socket path macOS cannot bind", async () => {
    env.APPLE_NOTES_MCP_BROKER_DIR = join(root, "x".repeat(120));
    const report = await setupBroker({ checkOnly: false, uninstall: false }, deps());
    expect(report.steps[0]).toMatchObject({ step: "socket path", ok: false });
  });

  it("needs the packaged source and a built entry point", async () => {
    let report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ sourcePath: join(root, "none.swift") })
    );
    expect(report.steps[0]).toMatchObject({ step: "locate source", ok: false });
    report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ entryPath: join(root, "none.js") })
    );
    expect(report.steps[0]).toMatchObject({ step: "locate server entry point", ok: false });
  });

  it("is macOS only", async () => {
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({ platform: "linux" })
    );
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ step: "platform", ok: false });
  });
});

describe("setupBroker --check and --uninstall", () => {
  it("waits for delayed service removal before replacing the installed app or bootstrapping", async () => {
    writeManifest();
    const paths = brokerPaths(env);
    const oldMarker = join(paths.appPath, "old-installation");
    writeFileSync(oldMarker, "preserve until stopped");
    const calls: Array<[string, string[]]> = [];
    const sleeps: number[] = [];
    let probes = 0;
    const handler = toolchain();
    const report = await setupBroker(
      { checkOnly: false, uninstall: false },
      deps({
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        spawn: makeSpawn((cmd, args, opts) => {
          if (cmd === "/bin/launchctl" && args[0] === "bootout")
            expect(opts).toMatchObject({ timeout: 10_000, killSignal: "SIGKILL" });
          if (cmd === "/bin/launchctl" && args[0] === "print") {
            expect(readFileSync(oldMarker, "utf8")).toBe("preserve until stopped");
            expect(opts).toMatchObject({ timeout: 1_000, killSignal: "SIGKILL" });
            return ++probes < 3 ? { status: 0, stdout: "state = running" } : SERVICE_ABSENT;
          }
          if (cmd === "/bin/launchctl" && args[0] === "bootstrap") {
            expect(probes).toBe(3);
            expect(existsSync(oldMarker)).toBe(false);
          }
          return handler(cmd, args, opts);
        }, calls),
      })
    );
    expect(report.ok).toBe(true);
    expect(sleeps).toEqual([250, 250]);
    expect(calls.filter(([cmd]) => cmd === "/bin/launchctl").map(([, args]) => args[0])).toEqual([
      "bootout",
      "print",
      "print",
      "print",
      "bootstrap",
    ]);
  });

  it.each([false, true])(
    "preserves installed artifacts when service removal never completes (uninstall=%s)",
    async (uninstall) => {
      writeManifest();
      const paths = brokerPaths(env);
      writeFileSync(paths.socketPath, "socket fixture");
      writeFileSync(logFixturePath, "legacy log");
      const originals = [
        paths.executablePath,
        paths.agentPath,
        paths.manifestPath,
        paths.socketPath,
        logFixturePath,
      ].map((path) => [path, readFileSync(path)] as const);
      const calls: Array<[string, string[]]> = [];
      const sleeps: number[] = [];
      const report = await setupBroker(
        { checkOnly: false, uninstall },
        deps({
          spawn: makeSpawn(toolchain({ print: { status: 0, stdout: "state = running" } }), calls),
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        })
      );
      expect(report.ok).toBe(false);
      expect(report.running).toBe(true);
      expect(report.steps.at(-1)).toMatchObject({ step: "stop LaunchAgent", ok: false });
      expect(report.steps.at(-1)?.detail).toContain("still loaded after 20 checks");
      expect(
        calls.filter(([cmd, args]) => cmd === "/bin/launchctl" && args[0] === "print")
      ).toHaveLength(20);
      expect(sleeps).toEqual(Array<number>(19).fill(250));
      expect(calls.some(([cmd, args]) => cmd === "/bin/launchctl" && args[0] === "bootstrap")).toBe(
        false
      );
      for (const [path, original] of originals) expect(readFileSync(path)).toEqual(original);
    }
  );

  it.each([
    { status: 1, stderr: "Permission denied" },
    { status: 113, stderr: "Could not find domain for user gui: 501" },
    { status: 113, stderr: 'Could not find service "another.service" in domain for user gui: 501' },
    { status: 1, stderr: SERVICE_ABSENT.stderr },
    { ...SERVICE_ABSENT, error: new Error("timeout") },
    { ...SERVICE_ABSENT, signal: "SIGKILL" },
  ] as SpawnResult[])(
    "preserves artifacts for ambiguous launchctl print result %#",
    async (print) => {
      writeManifest();
      const paths = brokerPaths(env);
      const calls: Array<[string, string[]]> = [];
      const report = await setupBroker(
        { checkOnly: false, uninstall: true },
        deps({
          spawn: makeSpawn(
            toolchain({ bootout: { status: 5, stderr: "Boot-out failed" }, print }),
            calls
          ),
          removePath: () => {
            throw new Error("cleanup must not run");
          },
        })
      );
      expect(report.ok).toBe(false);
      expect(report.steps).toHaveLength(1);
      expect(report.steps[0]).toMatchObject({ step: "stop LaunchAgent", ok: false });
      expect(report.steps[0].detail).toContain("Boot-out failed");
      expect(existsSync(paths.appPath)).toBe(true);
      expect(existsSync(paths.agentPath)).toBe(true);
      expect(existsSync(paths.manifestPath)).toBe(true);
      expect(calls.filter(([, args]) => args[0] === "print")).toHaveLength(1);
    }
  );

  it("can remove an already absent service despite a nonzero bootout", async () => {
    writeManifest();
    const report = await setupBroker(
      { checkOnly: false, uninstall: true },
      deps({
        spawn: makeSpawn(
          toolchain({ bootout: { status: 5, stderr: "Service is not loaded" } }),
          []
        ),
      })
    );
    expect(report.ok).toBe(true);
    expect(report.steps[0].detail).toContain("Service is not loaded");
    expect(report.steps[0].detail).toContain("Confirmed");
    expect((await setupBroker({ checkOnly: false, uninstall: true }, deps())).ok).toBe(true);
  });

  it("reports a thrown launchctl failure without removing anything", async () => {
    writeManifest();
    const report = await setupBroker(
      { checkOnly: false, uninstall: true },
      deps({
        spawn: makeSpawn((cmd) => {
          if (cmd === "/bin/launchctl") throw new Error("spawn failed");
          return { status: 0 };
        }, []),
      })
    );
    expect(report.ok).toBe(false);
    expect(report.steps[0].detail).toContain("spawn failed");
    expect(existsSync(brokerPaths(env).manifestPath)).toBe(true);
  });

  it("removes the exact owned files, legacy log, and empty state directory", async () => {
    writeManifest();
    const paths = brokerPaths(env);
    writeFileSync(paths.socketPath, "stale socket fixture");
    writeFileSync(logFixturePath, "old broker log");
    const removed: string[] = [];
    const defaults = deps();
    const report = await setupBroker(
      { checkOnly: false, uninstall: true },
      deps({
        removePath: (path, options) => {
          removed.push(String(path));
          defaults.removePath(path, options);
        },
      })
    );
    expect(report.ok).toBe(true);
    expect(removed).toEqual([
      paths.agentPath,
      paths.appPath,
      paths.socketPath,
      paths.logPath,
      paths.manifestPath,
    ]);
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(existsSync(logFixturePath)).toBe(false);
    expect(existsSync(paths.appDir)).toBe(true);
    expect(existsSync(join(paths.agentPath, ".."))).toBe(true);
  });

  it("keeps unrelated files in a custom state directory", async () => {
    writeManifest();
    const unrelated = join(brokerPaths(env).stateDir, "keep.txt");
    writeFileSync(unrelated, "user data");
    const report = await setupBroker({ checkOnly: false, uninstall: true }, deps());
    expect(report.ok).toBe(true);
    expect(readFileSync(unrelated, "utf8")).toBe("user data");
    expect(report.warnings.join(" ")).toContain("contains other files");
  });

  it.each(["", "/", "/."])(
    "unlinks a state directory symlink with suffix '%s' without following its target",
    async (suffix) => {
      writeManifest();
      const paths = brokerPaths(env);
      const target = join(root, "unrelated-directory");
      mkdirSync(target);
      writeFileSync(join(target, "manifest.json"), "unrelated manifest");
      writeFileSync(join(target, "broker.sock"), "unrelated socket");
      rmSync(paths.stateDir, { recursive: true });
      symlinkSync(target, paths.stateDir);
      env.APPLE_NOTES_MCP_BROKER_DIR = paths.stateDir + suffix;
      const report = await setupBroker({ checkOnly: false, uninstall: true }, deps());
      expect(report.ok).toBe(true);
      expect(existsSync(paths.stateDir)).toBe(false);
      expect(readFileSync(join(target, "manifest.json"), "utf8")).toBe("unrelated manifest");
      expect(readFileSync(join(target, "broker.sock"), "utf8")).toBe("unrelated socket");
      expect(report.warnings.join(" ")).toContain("target were left untouched");
    }
  );

  it("reports every artifact removal failure and retains metadata for retry", async () => {
    writeManifest();
    const paths = brokerPaths(env);
    writeFileSync(logFixturePath, "old log");
    const defaults = deps();
    const report = await setupBroker(
      { checkOnly: false, uninstall: true },
      deps({
        removePath: (path, options) => {
          if (path === paths.appPath || path === paths.logPath)
            throw new Error("permission denied");
          defaults.removePath(path, options);
        },
      })
    );
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ step: "remove broker", ok: false });
    expect(report.steps.at(-1)?.detail).toContain(paths.appPath);
    expect(report.steps.at(-1)?.detail).toContain(paths.logPath);
    expect(existsSync(paths.manifestPath)).toBe(true);
    expect(existsSync(paths.appPath)).toBe(true);
    expect(existsSync(logFixturePath)).toBe(true);
    expect(formatBrokerSetup(report)).toContain("not fully removed");
  });

  it("reports a state-directory removal failure even after removing the app", async () => {
    writeManifest();
    const report = await setupBroker(
      { checkOnly: false, uninstall: true },
      deps({
        removeEmptyDirectory: () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      })
    );
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toContain("permission denied");
    expect(existsSync(brokerPaths(env).stateDir)).toBe(true);
  });

  it("checks an installed, running broker", async () => {
    writeManifest();
    const report = await setupBroker({ checkOnly: true, uninstall: false }, deps());
    expect(report).toMatchObject({ ok: true, mode: "check", running: true });
    expect(formatBrokerSetup(report)).toContain("installed and running");
  });

  it("flags an installed broker that does not answer, and an ad-hoc one", async () => {
    writeManifest({ signing: { identity: "ad-hoc", teamId: null, stable: false } });
    const report = await setupBroker(
      { checkOnly: true, uninstall: false },
      deps({ ping: async () => false })
    );
    expect(report.ok).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/ad-hoc/);
    expect(formatBrokerSetup(report)).toContain("installed but not answering");
  });

  it("points at setup when nothing is installed", async () => {
    const report = await setupBroker({ checkOnly: true, uninstall: false }, deps());
    expect(report.ok).toBe(false);
    expect(formatBrokerSetup(report)).toContain("to install it");
  });

  it("stops and removes the broker", async () => {
    writeManifest();
    const calls: Array<[string, string[]]> = [];
    const report = await setupBroker(
      { checkOnly: false, uninstall: true },
      deps({ spawn: makeSpawn(toolchain(), calls) })
    );
    expect(report).toMatchObject({ ok: true, mode: "uninstall", running: false });
    expect(calls).toContainEqual(["/bin/launchctl", ["bootout", "gui/501/apple-notes-mcp.broker"]]);
    expect(inspectBroker(deps()).installed).toBe(false);
    expect(formatBrokerSetup(report)).toContain("The broker is removed.");
    expect(report.warnings.join(" ")).toContain(`tccutil reset All ${BROKER_BUNDLE_ID}`);
  });

  it("formats a failed uninstall", () => {
    const text = formatBrokerSetup({
      ok: false,
      mode: "uninstall",
      steps: [{ step: "remove broker", ok: false, detail: "busy" }],
      installation: inspectBroker(deps()),
      running: false,
      warnings: [],
    });
    expect(text).toContain("✗ remove broker: busy");
    expect(text).toContain("was not fully removed");
  });
});

describe("brokerStatus", () => {
  it("reports a brokered process", () => {
    const status = brokerStatus(
      deps({ env: { ...env, APPLE_NOTES_MCP_BROKERED: "1", APPLE_NOTES_MCP_BROKER_APP: "/A.app" } })
    );
    expect(status).toMatchObject({ inUse: true, appPath: "/A.app", fallbackReason: null });
    expect(status.detail).toMatch(/^In use: this server runs under \/A\.app/);
  });

  it("reports a brokered process without an app path", () => {
    const status = brokerStatus(deps({ env: { ...env, APPLE_NOTES_MCP_BROKERED: "1" } }));
    expect(status.detail).toContain("the broker app");
  });

  it("reports no broker", () => {
    const status = brokerStatus(deps());
    expect(status).toMatchObject({ inUse: false, installed: false, stableSigning: null });
    expect(status.detail).toMatch(/^Not installed/);
  });

  it("reports an installed broker that is turned off or unreachable", () => {
    writeManifest();
    expect(brokerStatus(deps({ env: { ...env, APPLE_NOTES_MCP_BROKER: "off" } })).detail).toMatch(
      /turned off/
    );
    recordBrokerFallback("The broker did not answer within 5000 ms.");
    const status = brokerStatus(deps());
    expect(status).toMatchObject({
      inUse: false,
      installed: true,
      ready: true,
      stableSigning: true,
    });
    expect(status.detail).toContain("did not answer");
  });

  it("survives an inspection failure", () => {
    const status = brokerStatus(
      deps({
        exists: () => {
          throw new Error("boom");
        },
      })
    );
    expect(status.installed).toBe(false);
  });
});

describe("defaultBrokerDeps", () => {
  it("points at the packaged source and entry point", () => {
    const d = defaultBrokerDeps();
    expect(d.sourcePath).toMatch(/native\/broker\/apple-notes-mcp-broker\.swift$/);
    expect(d.entryPath).toMatch(/build\/index\.js$/);
    expect(d.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("wires real filesystem, clock, and socket helpers", async () => {
    const d = defaultBrokerDeps();
    expect(d.readFile(sourcePath).toString()).toBe("// broker source");
    expect(d.realpath(root)).toContain("anm-broker-");
    expect(d.now()).toBeInstanceOf(Date);
    await d.sleep(0);
    expect(await d.ping(join(root, "absent.sock"))).toBe(false);
  });
});
