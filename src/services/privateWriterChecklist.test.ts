/**
 * Checklist toggling client tests. A Node script stands in for the native
 * writer so the real spawn, checksum, gating, and response-validation paths
 * run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./privateHelper.js";
import {
  CHECKLIST_TOGGLE_LIVE_VALIDATED,
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import {
  assertTodoIdentifier,
  readNativeChecklist,
  setChecklistItem,
} from "./privateWriterChecklist.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const TODO = "056bf1349dc54f3490aaf36649efe82e";
const REV = `r1:${"a".repeat(64)}`;
const SOURCE = "// fake checklist writer source\n";

const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  const cloudSync = { available: true, inICloudAccount: true, currentLocalVersion: 4, latestVersionSyncedToCloud: 3, uploadPending: true };
  if (mode === "not-found") out({ status: "error", code: "not_found", message: "no item", committed: false }, 1);
  if (mode === "verify-failed") out({ status: "error", code: "verification_failed", message: "bad", committed: true, persistedDone: false }, 1);
  if (mode === "malformed") out({ status: "updated" });
  if (req.action === "read_checklist")
    out({ status: "ok", identifier: req.identifier, revision: "r1:" + "b".repeat(64), total: 1, checked: 0,
      items: [{ todoIdentifier: "${TODO}", uuid: "056BF134-9DC5-4F34-90AA-F36649EFE82E", index: 0, done: false, text: "item", lineStart: 8, lineLengthUTF16: 4, styledStart: 7, styledLengthUTF16: 5, contiguous: true, consistent: true }], echo: req });
  if (req.action === "set_checklist_item") {
    const unchanged = mode === "unchanged";
    out({ status: unchanged ? "unchanged" : "updated", committed: !unchanged, verified: true, identifier: req.identifier,
      todoIdentifier: req.todoIdentifier, index: 0, done: req.done, previousDone: unchanged ? req.done : !req.done,
      persistedDone: req.done, revisionBefore: req.ifRevision, revisionAfter: unchanged ? req.ifRevision : "r1:" + "c".repeat(64),
      modificationDate: null, cloudSync, pushScheduled: false, pushState: "awaiting_notes_app", syncHostRunning: true, storeKind: "live", echo: req });
  }
  out({ status: "error", code: "unknown_action", message: "no" }, 1);
});
`;

let root: string;
let deps: (env?: Record<string, string>) => PrivateHelperDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-writer-checklist-"));
  const installDir = join(root, "install");
  const sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, SOURCE);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, WRITER_BINARY_NAME), FAKE_WRITER);
  chmodSync(join(installDir, WRITER_BINARY_NAME), 0o755);
  writeFileSync(
    join(installDir, WRITER_MANIFEST_NAME),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: PRIVATE_WRITER_PROTOCOL,
      sourceSha256: sha256Hex(SOURCE),
      binarySha256: sha256Hex(FAKE_WRITER),
      builtAt: "2026-09-23T00:00:00.000Z",
      osVersion: "27.2",
      compiler: "clang",
    })
  );
  deps = (env = {}) =>
    defaultWriterDeps({
      env: {
        PATH: process.env.PATH,
        APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir,
        APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
        APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
        ...env,
      },
      platform: "darwin",
      sourcePath,
    });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ALLOW = { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

function caught(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PrivateWriteError) return error;
    throw error;
  }
  throw new Error("expected a PrivateWriteError");
}

const SPAWN_TIMEOUT = { timeout: 20_000 };

describe("todo identifiers", () => {
  it("accepts 32 hex digits or a dashed UUID in either case", () => {
    expect(() => assertTodoIdentifier(TODO)).not.toThrow();
    expect(() => assertTodoIdentifier(TODO.toUpperCase())).not.toThrow();
    expect(() => assertTodoIdentifier("056BF134-9DC5-4F34-90AA-F36649EFE82E")).not.toThrow();
  });

  it("refuses anything else as an invalid request with nothing committed", () => {
    for (const bad of ["", "xyz", TODO.slice(1), `${TODO}0`, "056bf134-9dc54f3490aaf36649efe82e"])
      expect(caught(() => assertTodoIdentifier(bad))).toMatchObject({
        code: "invalid_request",
        committed: false,
      });
  });
});

describe("readNativeChecklist", SPAWN_TIMEOUT, () => {
  it("returns items with todo identifiers and the revision", () => {
    const state = readNativeChecklist(NOTE, deps());
    expect(state.items[0]).toMatchObject({ todoIdentifier: TODO, done: false, index: 0 });
    expect(state.revision).toMatch(/^r1:/);
    expect(state.echo).toEqual({ protocol: 1, action: "read_checklist", identifier: NOTE });
  });

  it("validates the note identifier before spawning", () => {
    expect(caught(() => readNativeChecklist("nope", deps())).code).toBe("invalid_request");
  });

  it("needs the write switch too, because it runs through the writer", () => {
    expect(
      caught(() => readNativeChecklist(NOTE, deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "0" })))
    ).toMatchObject({ code: "writes_disabled", committed: undefined });
  });

  it("treats a read error as not committed-relevant", () => {
    const e = caught(() => readNativeChecklist(NOTE, deps({ FAKE_MODE: "not-found" })));
    expect(e.code).toBe("not_found");
    expect(e.committed).toBeUndefined();
  });
});

describe("setChecklistItem", SPAWN_TIMEOUT, () => {
  const request = { identifier: NOTE, todoIdentifier: TODO, done: true, ifRevision: REV };

  it("stays gated until live validation unless explicitly allowed", () => {
    expect(CHECKLIST_TOGGLE_LIVE_VALIDATED).toBe(false);
    expect(caught(() => setChecklistItem(request, deps()))).toMatchObject({
      code: "not_live_validated",
      committed: false,
    });
  });

  it("validates every field before spawning", () => {
    const d = deps(ALLOW);
    expect(caught(() => setChecklistItem({ ...request, identifier: "x" }, d)).code).toBe(
      "invalid_request"
    );
    expect(caught(() => setChecklistItem({ ...request, todoIdentifier: "x" }, d)).code).toBe(
      "invalid_request"
    );
    expect(
      caught(() => setChecklistItem({ ...request, done: "yes" as unknown as boolean }, d)).code
    ).toBe("invalid_request");
    expect(caught(() => setChecklistItem({ ...request, ifRevision: "r1:x" }, d)).code).toBe(
      "invalid_request"
    );
  });

  it("sends a lowercase todo identifier and a real boolean, and returns persistedDone", () => {
    const r = setChecklistItem({ ...request, todoIdentifier: TODO.toUpperCase() }, deps(ALLOW));
    expect(r).toMatchObject({ status: "updated", committed: true, persistedDone: true });
    expect(r.echo).toEqual({
      protocol: 1,
      action: "set_checklist_item",
      identifier: NOTE,
      todoIdentifier: TODO,
      done: true,
      ifRevision: REV,
    });
  });

  it("reports the idempotent no-op without a commit", () => {
    const r = setChecklistItem(
      { ...request, done: false },
      deps({ ...ALLOW, FAKE_MODE: "unchanged" })
    );
    expect(r).toMatchObject({ status: "unchanged", committed: false, persistedDone: false });
    expect(r.revisionAfter).toBe(REV);
  });

  it("passes committed flags through on errors", () => {
    expect(
      caught(() => setChecklistItem(request, deps({ ...ALLOW, FAKE_MODE: "not-found" })))
    ).toMatchObject({ code: "not_found", committed: false });
    expect(
      caught(() => setChecklistItem(request, deps({ ...ALLOW, FAKE_MODE: "verify-failed" })))
    ).toMatchObject({ code: "verification_failed", committed: true });
  });

  it("treats a malformed success response as indeterminate", () => {
    expect(
      caught(() => setChecklistItem(request, deps({ ...ALLOW, FAKE_MODE: "malformed" })))
    ).toMatchObject({ code: "invalid_response", committed: "unknown" });
  });
});
