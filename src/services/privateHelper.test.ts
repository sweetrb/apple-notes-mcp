/**
 * Private helper client tests. A small Node script stands in for the native
 * helper binary, so these tests exercise the real spawn, timeout, checksum,
 * and response-validation paths without NotesShared or the Notes store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HELPER_BINARY_NAME,
  MANIFEST_NAME,
  PRIVATE_HELPER_PROTOCOL,
  PrivateHelperError,
  READ_ONLY_ACTIONS,
  assertNoteIdentifier,
  callPrivateHelper,
  defaultDeps,
  helperInstallDir,
  inspectInstallation,
  packageRoot,
  privateHelperCapabilities,
  privateHelperEnabled,
  probePrivateHelper,
  readNoteState,
  sha256Hex,
  type PrivateHelperDeps,
} from "./privateHelper.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";

/**
 * Fake helper. Reads one JSON request and answers per FAKE_MODE, echoing the
 * request fields it received under `echo` so tests can assert the wire shape.
 */
const FAKE_HELPER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  if (mode === "garbage") { process.stdout.write("not json"); process.exit(0); }
  if (mode === "array") out([1, 2]);
  if (mode === "bad-error") out({ status: "error" }, 1);
  if (mode === "not-found") out({ status: "error", code: "not_found", message: "No note has that identifier", hint: "x" }, 1);
  if (mode === "malformed") out({ status: "ok" });
  const feature = (name) => {
    if (mode === "missing-api") return { available: false, reason: "private_api_unavailable", missing: ["-[ICNote mergeableString]"] };
    if (mode === "missing-api-empty") return { available: false, reason: "private_api_unavailable", missing: [] };
    if (mode === "no-store") return { available: false, reason: "store_unavailable", missing: [] };
    return { available: true, reason: null, missing: [] };
  };
  const cloudSync = { available: true, inICloudAccount: true, currentLocalVersion: 4, latestVersionSyncedToCloud: 1, uploadPending: true };
  switch (req.action) {
    case "hello":
      out({ status: "ok", protocolVersion: Number(process.env.FAKE_PROTOCOL || 1), sourceSha256: process.env.FAKE_SOURCE_SHA || "dev", readOnly: true, actions: ["hello", "probe", "read_note_state"] });
    case "probe":
      out({ status: "ok", protocolVersion: 1, readOnly: true, os: { version: "27.2.0", notesAppVersion: "4.13" }, framework: { loaded: true, error: null }, store: { kind: "live", opened: mode === "ok", reason: null, noteRows: 3 }, syncHostRunning: true, features: { readNoteState: feature("read") } });
    case "read_note_state":
      out({ status: "ok", identifier: req.identifier, objectURI: "x-coredata://S/ICNote/p1", title: "t", modificationDate: "2026-09-23T00:00:00.000Z", folderIdentifier: "F", passwordProtected: false, deletedOrInTrash: false, sharedViaICloud: false, editable: true, revision: "r1:" + "b".repeat(64), cloudSync, syncHostRunning: true, echo: req });
    case "spawned-marker":
      out({ status: "ok", spawned: true });
    default:
      out({ status: "error", code: "unknown_action", message: "no" }, 1);
  }
});
`;

interface Fixture {
  root: string;
  installDir: string;
  sourcePath: string;
  binaryPath: string;
  deps: (env?: Record<string, string>) => PrivateHelperDeps;
  install: (manifest?: Record<string, unknown>) => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "private-helper-test-"));
  const installDir = join(root, "install");
  const sourcePath = join(root, "helper.m");
  writeFileSync(sourcePath, "// fake helper source\n");
  const binaryPath = join(installDir, HELPER_BINARY_NAME);
  const deps = (env: Record<string, string> = {}) =>
    defaultDeps({
      env: { PATH: process.env.PATH, APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir, ...env },
      platform: "darwin",
      sourcePath,
    });
  const install = (manifest: Record<string, unknown> = {}) => {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(binaryPath, FAKE_HELPER);
    chmodSync(binaryPath, 0o755);
    writeFileSync(
      join(installDir, MANIFEST_NAME),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: PRIVATE_HELPER_PROTOCOL,
        sourceSha256: sha256Hex("// fake helper source\n"),
        binarySha256: sha256Hex(FAKE_HELPER),
        builtAt: "2026-09-23T00:00:00.000Z",
        osVersion: "27.2",
        compiler: "clang",
        ...manifest,
      })
    );
  };
  return { root, installDir, sourcePath, binaryPath, deps, install };
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

const ON = { APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" };

function caught(fn: () => unknown): PrivateHelperError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PrivateHelperError) return error;
    throw error;
  }
  throw new Error("expected a PrivateHelperError");
}

// These tests spawn a real fake helper several times each, which can pass the
// 5 s default under coverage instrumentation or on a slower CI runner.
const SPAWN_TIMEOUT = { timeout: 20_000 };

describe("configuration", () => {
  it("is opt-in: only the exact value 1 enables the helper", () => {
    expect(privateHelperEnabled({})).toBe(false);
    expect(privateHelperEnabled({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "true" })).toBe(false);
    expect(privateHelperEnabled({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" })).toBe(true);
  });

  it("defaults the install dir to Application Support and honours an override", () => {
    expect(helperInstallDir({})).toMatch(
      /Library\/Application Support\/apple-notes-mcp\/private-helper$/
    );
    expect(helperInstallDir({ APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: " /x/y " })).toBe("/x/y");
  });

  it("finds the package root that ships the helper source", () => {
    expect(packageRoot(__dirname)).toBe(join(__dirname, "..", ".."));
    // No apple-notes-mcp package.json above a temp dir: falls back to the parent.
    expect(packageRoot(fx.root)).toBe(join(fx.root, ".."));
    // An unrelated package.json on the way up is skipped, and so is a corrupt one.
    const nested = join(fx.root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(fx.root, "a", "package.json"), JSON.stringify({ name: "other" }));
    writeFileSync(join(nested, "package.json"), "{corrupt");
    expect(packageRoot(nested)).toBe(join(fx.root, "a"));
  });

  it("uses the real platform, filesystem and spawn by default", () => {
    const deps = defaultDeps();
    expect(deps.platform).toBe(process.platform);
    expect(deps.sourcePath).toMatch(/native\/private-helper\/apple-notes-private-helper\.m$/);
    expect(deps.readFile(deps.sourcePath).length).toBeGreaterThan(0);
  });
});

describe("inspectInstallation fails closed", SPAWN_TIMEOUT, () => {
  it("refuses other platforms", () => {
    const r = inspectInstallation({ ...fx.deps(), platform: "linux" });
    expect(r).toMatchObject({ ready: false, reason: "unsupported_platform" });
  });

  it("reports a missing packaged source", () => {
    rmSync(fx.sourcePath);
    expect(inspectInstallation(fx.deps())).toMatchObject({
      ready: false,
      reason: "helper_not_installed",
      detail: expect.stringMatching(/source is missing/),
    });
  });

  it("reports a helper that was never built, with the setup command", () => {
    const r = inspectInstallation(fx.deps());
    expect(r.reason).toBe("helper_not_installed");
    expect(r.detail).toMatch(/apple-notes-mcp setup --native-helper/);
    expect(r.expectedSourceSha256).toBe(sha256Hex("// fake helper source\n"));
  });

  it("reports an unreadable manifest", () => {
    fx.install();
    writeFileSync(join(fx.installDir, MANIFEST_NAME), "{not json");
    expect(inspectInstallation(fx.deps()).reason).toBe("helper_manifest_invalid");
    writeFileSync(join(fx.installDir, MANIFEST_NAME), JSON.stringify({ schemaVersion: 2 }));
    expect(inspectInstallation(fx.deps()).reason).toBe("helper_manifest_invalid");
  });

  it("treats a helper built from other source as stale", () => {
    fx.install({ sourceSha256: "0".repeat(64) });
    expect(inspectInstallation(fx.deps())).toMatchObject({ ready: false, reason: "helper_stale" });
  });

  it("treats a helper built for another protocol as stale", () => {
    fx.install({ protocolVersion: PRIVATE_HELPER_PROTOCOL + 1 });
    expect(inspectInstallation(fx.deps()).reason).toBe("helper_stale");
  });

  it("refuses a binary changed after it was built", () => {
    fx.install();
    writeFileSync(fx.binaryPath, FAKE_HELPER + "\n// tampered\n");
    expect(inspectInstallation(fx.deps())).toMatchObject({
      ready: false,
      reason: "helper_modified",
    });
  });

  it("accepts a matching installation", () => {
    fx.install();
    expect(inspectInstallation(fx.deps())).toMatchObject({
      ready: true,
      reason: null,
      binaryPath: fx.binaryPath,
    });
  });
});

describe("callPrivateHelper", SPAWN_TIMEOUT, () => {
  it("refuses while the opt-in flag is off, before anything runs", () => {
    fx.install();
    const e = caught(() => callPrivateHelper("probe", {}, fx.deps()));
    expect(e.code).toBe("disabled");
  });

  it("is read-only: refuses any action outside the whitelist before spawning", () => {
    fx.install();
    expect([...READ_ONLY_ACTIONS].sort()).toEqual(["hello", "probe", "read_note_state"]);
    for (const action of ["append_plain_text", "spawned-marker", "save", "write"]) {
      const e = caught(() => callPrivateHelper(action, { identifier: NOTE }, fx.deps(ON)));
      expect(e.code).toBe("unknown_action");
      expect(e.message).toMatch(/read-only/);
    }
  });

  it("refuses a missing or stale helper even when enabled", () => {
    expect(caught(() => callPrivateHelper("probe", {}, fx.deps(ON))).code).toBe(
      "helper_not_installed"
    );
    fx.install({ sourceSha256: "1".repeat(64) });
    expect(caught(() => callPrivateHelper("probe", {}, fx.deps(ON))).code).toBe("helper_stale");
  });

  it("sends the protocol version and request fields on stdin", () => {
    fx.install();
    const r = callPrivateHelper("read_note_state", { identifier: NOTE }, fx.deps(ON));
    expect(r.echo).toEqual({ protocol: 1, action: "read_note_state", identifier: NOTE });
  });

  it("can run a staged binary for the setup handshake without the opt-in", () => {
    fx.install();
    const r = callPrivateHelper("hello", {}, fx.deps(), {
      allowDisabled: true,
      binaryPath: fx.binaryPath,
    });
    expect(r).toMatchObject({ status: "ok", protocolVersion: 1 });
  });

  it("reports a timeout", () => {
    fx.install();
    const deps = fx.deps({
      ...ON,
      FAKE_MODE: "hang",
      APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300",
    });
    const read = caught(() => callPrivateHelper("probe", {}, deps));
    expect(read.code).toBe("timeout");
    expect(read.message).toMatch(/300 ms/);
  });

  it("rejects output that is not a JSON object", () => {
    fx.install();
    const garbage = fx.deps({ ...ON, FAKE_MODE: "garbage" });
    expect(caught(() => callPrivateHelper("probe", {}, garbage)).code).toBe("invalid_response");
    const array = fx.deps({ ...ON, FAKE_MODE: "array" });
    expect(caught(() => callPrivateHelper("probe", {}, array)).code).toBe("invalid_response");
  });

  it("passes the helper's error code and details through", () => {
    fx.install();
    const missing = caught(() =>
      callPrivateHelper(
        "read_note_state",
        { identifier: NOTE },
        fx.deps({ ...ON, FAKE_MODE: "not-found" })
      )
    );
    expect(missing).toMatchObject({ code: "not_found", details: { hint: "x" } });
  });

  it("rejects an error response of unknown shape", () => {
    fx.install();
    const deps = fx.deps({ ...ON, FAKE_MODE: "bad-error" });
    expect(caught(() => callPrivateHelper("probe", {}, deps)).code).toBe("invalid_response");
  });

  it("reports a helper that cannot be started", () => {
    const deps = fx.deps(ON);
    const e = caught(() =>
      callPrivateHelper("probe", {}, deps, { binaryPath: join(fx.root, "absent") })
    );
    expect(e.code).toBe("helper_unreachable");
  });

  it("falls back to the default timeout for a non-numeric override", () => {
    fx.install();
    const r = callPrivateHelper(
      "probe",
      {},
      fx.deps({ ...ON, APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "soon" })
    );
    expect(r.status).toBe("ok");
  });
});

describe("typed actions", SPAWN_TIMEOUT, () => {
  it("parses the probe", () => {
    fx.install();
    const probe = probePrivateHelper(fx.deps(ON));
    expect(probe.readOnly).toBe(true);
    expect(probe.features.readNoteState.available).toBe(true);
    expect(Object.keys(probe.features)).toEqual(["readNoteState"]);
    expect(probe.os.version).toBe("27.2.0");
  });

  it("validates the identifier before reading note state", () => {
    fx.install();
    expect(caught(() => readNoteState("not-a-uuid", fx.deps(ON))).code).toBe("invalid_request");
    const state = readNoteState(NOTE, fx.deps(ON));
    expect(state.revision).toMatch(/^r1:/);
    expect(state.cloudSync.uploadPending).toBe(true);
  });

  it("rejects a malformed success response", () => {
    fx.install();
    const e = caught(() => readNoteState(NOTE, fx.deps({ ...ON, FAKE_MODE: "malformed" })));
    expect(e.code).toBe("invalid_response");
  });
});

describe("identifier rules", () => {
  it("requires a UUID-shaped identifier", () => {
    expect(() => assertNoteIdentifier(NOTE.toLowerCase())).not.toThrow();
    expect(() => assertNoteIdentifier("x-coredata://A/ICNote/p1")).toThrow(/UUID/);
  });
});

describe("privateHelperCapabilities never throws", SPAWN_TIMEOUT, () => {
  it("reports unsupported platforms", () => {
    const c = privateHelperCapabilities({ ...fx.deps(ON), platform: "linux" });
    expect(c.features.readNoteState).toMatchObject({
      available: false,
      reason: "unsupported_platform",
    });
  });

  it("explains that the helper is off", () => {
    fx.install();
    const c = privateHelperCapabilities(fx.deps());
    expect(c.enabled).toBe(false);
    expect(c.probe).toBeNull();
    expect(c.readOnly).toBe(true);
    expect(c.features.readNoteState).toMatchObject({ available: false, reason: "disabled" });
  });

  it("explains a missing helper", () => {
    const c = privateHelperCapabilities(fx.deps(ON));
    expect(c.features.readNoteState).toMatchObject({
      available: false,
      reason: "helper_not_installed",
    });
  });

  it("turns a probe failure into helper_unreachable", () => {
    fx.install();
    const c = privateHelperCapabilities(fx.deps({ ...ON, FAKE_MODE: "garbage" }));
    expect(c.features.readNoteState.reason).toBe("helper_unreachable");
  });

  it("names missing private API from the live probe", () => {
    fx.install();
    const c = privateHelperCapabilities(fx.deps({ ...ON, FAKE_MODE: "missing-api" }));
    expect(c.features.readNoteState).toMatchObject({
      available: false,
      reason: "private_api_unavailable",
      detail: "missing: -[ICNote mergeableString]",
    });
    const empty = privateHelperCapabilities(fx.deps({ ...ON, FAKE_MODE: "missing-api-empty" }));
    expect(empty.features.readNoteState.detail).toBe("private_api_unavailable");
  });

  it("passes a store failure through", () => {
    fx.install();
    const c = privateHelperCapabilities(fx.deps({ ...ON, FAKE_MODE: "no-store" }));
    expect(c.features.readNoteState.reason).toBe("store_unavailable");
  });

  it("reports only the read feature, and is available when the probe says so", () => {
    fx.install();
    const c = privateHelperCapabilities(fx.deps(ON));
    expect(c.readOnly).toBe(true);
    expect(Object.keys(c.features)).toEqual(["readNoteState"]);
    expect(c.features.readNoteState.available).toBe(true);
  });
});
