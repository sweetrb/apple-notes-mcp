/**
 * Private writer client tests. A small Node script stands in for the native
 * writer binary, so these tests exercise the real spawn, timeout, checksum,
 * gating, and committed/indeterminate paths without NotesShared or the store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HELPER_BINARY_NAME,
  MANIFEST_NAME,
  READ_ONLY_ACTIONS,
  sha256Hex,
} from "./privateHelper.js";
import {
  APPEND_LIVE_VALIDATED,
  EDIT_LIVE_VALIDATED,
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_ACTIONS,
  WRITER_BINARY_NAME,
  WRITER_FEATURES,
  WRITER_MANIFEST_NAME,
  WRITER_SOURCE_RELATIVE,
  appendPlainText,
  assertAppendText,
  assertRevision,
  callPrivateWriter,
  WRITER_FEATURES,
  defaultWriterDeps,
  editNote,
  editOperationSchema,
  editOperationsSchema,
  inspectWriterInstallation,
  parseWriterResult,
  privateWriterCapabilities,
  privateWritesEnabled,
  probePrivateWriter,
  requireLiveValidated,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { z } from "zod";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const REV = `r1:${"a".repeat(64)}`;
const SOURCE = "// fake writer source\n";

const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  if (mode === "garbage") { process.stdout.write("not json"); process.exit(0); }
  if (mode === "array") out([1]);
  if (mode === "bad-error") out({ status: "error" }, 1);
  if (mode === "conflict") out({ status: "error", code: "revision_conflict", message: "changed", committed: false, currentRevision: "r1:" + "c".repeat(64) }, 1);
  if (mode === "verify-failed") out({ status: "error", code: "verification_failed", message: "mismatch", committed: true }, 1);
  if (mode === "no-committed") out({ status: "error", code: "save_failed", message: "?" }, 1);
  if (mode === "malformed") out({ status: "updated" });
  if (mode === "edit-side-effect") out({ status: "error", code: "unexpected_side_effect", message: "no", committed: false, objects: ["updated ICAttachment (noteUsingTitleForNoteTitle)"] }, 1);
  const feature = () => {
    if (mode === "missing-api") return { available: false, reason: "private_api_unavailable", missing: ["-[ICNote saveNoteData]"] };
    if (mode === "missing-api-empty") return { available: false, reason: "private_api_unavailable", missing: [] };
    if (mode === "no-store") return { available: false, reason: "store_unavailable", missing: [] };
    return { available: true, reason: null, missing: [] };
  };
  const cloudSync = { available: true, inICloudAccount: true, currentLocalVersion: 5, latestVersionSyncedToCloud: 4, uploadPending: true };
  switch (req.action) {
    case "hello":
      out({ status: "ok", protocolVersion: 1, sourceSha256: "dev", role: "writer", readOnly: false, actions: ["hello"] });
    case "probe":
      out({ status: "ok", protocolVersion: 1, role: "writer", readOnly: false, writesEnabled: process.env.APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES === "1", os: { version: "27.2.0", notesAppVersion: "4.13" }, framework: { loaded: true, error: null }, store: { kind: "live", opened: true, reason: null, noteRows: 3 }, syncHostRunning: true, features: mode === "old-writer" || mode === "old-probe" ? { readNoteState: feature(), appendPlainText: feature() } : { readNoteState: feature(), appendPlainText: feature(), planEdit: feature(), editNote: feature(), tables: feature(), pruneOrphanTable: feature(), smartFolders: feature() } });
    case "append_plain_text":
      out({ status: "updated", committed: true, verified: true, identifier: req.identifier, appendedUTF16: req.text.length, separatorInserted: false, revisionBefore: req.ifRevision, revisionAfter: "r1:" + "d".repeat(64), modificationDate: "2026-09-23T00:00:00.000Z", title: "t", cloudSync, pushScheduled: false, pushState: "awaiting_notes_app", syncHostRunning: true, storeKind: "live", echo: req });
    case "read_note_state":
      out({ status: "ok", identifier: req.identifier, echo: req });
    case "plan_edit":
    case "edit_note": {
      const plan = { identifier: req.identifier, revisionBefore: "r1:" + "e".repeat(64), planDigest: "p1:x", operationCount: req.operations.length, targetCount: 1, operations: [{ index: 0, op: req.operations[0].op, matchedCount: 1, targets: [{ paragraphIndex: 2, paragraphStyle: "body", location: 40, length: 5, newLength: 5 }] }], lengthBefore: 100, lengthAfter: 100, unchangedUTF16: 95, wouldChange: mode !== "edit-noop", titleChanged: false, attachmentGlyphs: 1, storeKind: "live", echo: req };
      if (req.action === "plan_edit") out({ status: "planned", dryRun: true, committed: false, ...plan });
      if (mode === "edit-noop") out({ status: "unchanged", dryRun: false, committed: false, revisionAfter: plan.revisionBefore, ...plan });
      if (mode === "edit-attachment") { const id = req.operations[0].selector.identifier; out({ status: "updated", dryRun: false, committed: true, verified: true, revisionAfter: "r1:" + "f".repeat(64), modificationDate: null, title: "t", preservation: { unchangedUTF16: 99, formattingOutsideEditsVerified: true, attachmentGlyphs: 2, attachmentGlyphSequenceVerified: true, attachmentRows: 3, attachmentRowsVerified: true, otherAttachmentRowsUnchanged: 2, removedAttachments: [{ identifier: id, rowStillInNote: true, markedForDeletion: false }] }, cloudSync, pushScheduled: false, pushState: "awaiting_notes_app", syncHostRunning: true, ...plan, attachmentGlyphs: 3, attachmentGlyphsAfter: 2, removedAttachments: [id] }); }
      out({ status: "updated", dryRun: false, committed: true, verified: true, revisionAfter: "r1:" + "f".repeat(64), modificationDate: null, title: "t", preservation: { unchangedUTF16: 95, formattingOutsideEditsVerified: true, attachmentGlyphs: 1, attachmentGlyphSequenceVerified: true, attachmentRows: 1, attachmentRowsVerified: true }, cloudSync, pushScheduled: false, pushState: "awaiting_notes_app", syncHostRunning: true, ...plan });
    }
    case "delete_table_row":
    case "delete_smart_folder":
      out({ status: "planned", echo: req });
    default:
      out({ status: "error", code: "unknown_action", message: "no" }, 1);
  }
});
`;

let root: string;
let installDir: string;
let sourcePath: string;

function deps(env: Record<string, string> = {}): PrivateHelperDeps {
  return defaultWriterDeps({
    env: { PATH: process.env.PATH, APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: installDir, ...env },
    platform: "darwin",
    sourcePath,
  });
}

function install(manifest: Record<string, unknown> = {}, binary = FAKE_WRITER) {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, WRITER_BINARY_NAME), binary);
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
      ...manifest,
    })
  );
}

const ON = {
  APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
  APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
};
const UNVERIFIED = { ...ON, APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-writer-test-"));
  installDir = join(root, "install");
  sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, SOURCE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function thrown(fn: () => unknown): PrivateWriteError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateWriteError);
    return error as PrivateWriteError;
  }
  throw new Error("expected a throw");
}

describe("layer separation", () => {
  it("uses its own source, binary, and manifest, distinct from the read-only helper", () => {
    expect(WRITER_BINARY_NAME).not.toBe(HELPER_BINARY_NAME);
    expect(WRITER_MANIFEST_NAME).not.toBe(MANIFEST_NAME);
    expect(defaultWriterDeps().sourcePath.endsWith(WRITER_SOURCE_RELATIVE)).toBe(true);
  });

  it("shares no write action with the read-only whitelist", () => {
    for (const [action, kind] of Object.entries(WRITER_ACTIONS))
      if (kind === "write") expect(READ_ONLY_ACTIONS.has(action)).toBe(false);
  });

  it("needs both switches", () => {
    expect(privateWritesEnabled({})).toBe(false);
    expect(privateWritesEnabled({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" })).toBe(false);
    expect(privateWritesEnabled({ APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1" })).toBe(false);
    expect(privateWritesEnabled(ON)).toBe(true);
  });
});

describe("inspectWriterInstallation", () => {
  it("reports unsupported off macOS", () => {
    expect(inspectWriterInstallation({ ...deps(), platform: "linux" }).reason).toBe(
      "unsupported_platform"
    );
  });

  it("reports a missing source, binary, or manifest", () => {
    expect(inspectWriterInstallation({ ...deps(), sourcePath: join(root, "nope.m") }).reason).toBe(
      "helper_not_installed"
    );
    const report = inspectWriterInstallation(deps());
    expect(report.reason).toBe("helper_not_installed");
    expect(report.detail).toMatch(/setup --native-writer/);
  });

  it("refuses an unreadable, stale, or modified install", () => {
    install();
    writeFileSync(join(installDir, WRITER_MANIFEST_NAME), "{");
    expect(inspectWriterInstallation(deps()).reason).toBe("helper_manifest_invalid");
    install({ sourceSha256: "0".repeat(64) });
    expect(inspectWriterInstallation(deps()).reason).toBe("helper_stale");
    install({ protocolVersion: 99 });
    expect(inspectWriterInstallation(deps()).reason).toBe("helper_stale");
    install({}, FAKE_WRITER + "// tampered\n");
    expect(inspectWriterInstallation(deps()).reason).toBe("helper_modified");
    install();
    expect(inspectWriterInstallation(deps())).toMatchObject({ ready: true, reason: null });
  });

  it("never reads the read-only helper's manifest", () => {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, MANIFEST_NAME), "{}");
    writeFileSync(join(installDir, HELPER_BINARY_NAME), "x");
    expect(inspectWriterInstallation(deps()).reason).toBe("helper_not_installed");
  });
});

describe("callPrivateWriter", () => {
  beforeEach(() => install());

  it("refuses unknown actions before spawning", () => {
    const error = thrown(() => callPrivateWriter("drop_everything", {}, deps(ON)));
    expect(error.code).toBe("unknown_action");
  });

  it("refuses unless both switches are on, with committed false for writes", () => {
    const off = thrown(() => callPrivateWriter("append_plain_text", {}, deps()));
    expect(off).toMatchObject({ code: "disabled", committed: false });
    const readOnly = thrown(() =>
      callPrivateWriter("append_plain_text", {}, deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" }))
    );
    expect(readOnly).toMatchObject({ code: "writes_disabled", committed: false });
    const read = thrown(() =>
      callPrivateWriter("read_note_state", {}, deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" }))
    );
    expect(read).toMatchObject({ code: "writes_disabled", committed: undefined });
  });

  it("refuses when the install is not ready", () => {
    rmSync(join(installDir, WRITER_MANIFEST_NAME));
    expect(thrown(() => callPrivateWriter("append_plain_text", {}, deps(ON)))).toMatchObject({
      code: "helper_not_installed",
      committed: false,
    });
    expect(thrown(() => callPrivateWriter("probe", {}, deps(ON))).committed).toBeUndefined();
  });

  it("sends the protocol, action, and fields", () => {
    const out = callPrivateWriter("read_note_state", { identifier: NOTE }, deps(ON));
    expect(out.echo).toEqual({ protocol: 1, action: "read_note_state", identifier: NOTE });
  });

  it("allows hello with allowDisabled against an explicit binary", () => {
    const out = callPrivateWriter("hello", {}, deps(), {
      allowDisabled: true,
      binaryPath: join(installDir, WRITER_BINARY_NAME),
    });
    expect(out).toMatchObject({ role: "writer", readOnly: false });
  });

  it("marks a timed-out write indeterminate and a timed-out read not committed", () => {
    const env = { ...ON, FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" };
    const write = thrown(() => callPrivateWriter("append_plain_text", {}, deps(env)));
    expect(write).toMatchObject({ code: "timeout", committed: "unknown" });
    expect(write.message).toMatch(/INDETERMINATE/);
    const read = thrown(() => callPrivateWriter("probe", {}, deps(env)));
    expect(read).toMatchObject({ code: "timeout", committed: undefined });
  }, 20_000);

  it("treats a dry run of a write action as a read", () => {
    const env = { ...ON, FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" };
    const dry = thrown(() =>
      callPrivateWriter("delete_table_row", {}, deps(env), { dryRun: true })
    );
    expect(dry).toMatchObject({ code: "timeout", committed: undefined });
    const apply = thrown(() => callPrivateWriter("delete_table_row", {}, deps(env)));
    expect(apply).toMatchObject({ code: "timeout", committed: "unknown" });
    const off = thrown(() =>
      callPrivateWriter("delete_table_row", {}, deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" }), {
        dryRun: true,
      })
    );
    expect(off).toMatchObject({ code: "writes_disabled", committed: undefined });
  }, 20_000);

  it("reports an unrunnable binary as not committed", () => {
    const error = thrown(() =>
      callPrivateWriter("append_plain_text", {}, deps(ON), {
        binaryPath: join(root, "missing-binary"),
      })
    );
    expect(error).toMatchObject({ code: "helper_unreachable", committed: false });
  });

  it("treats unparseable output after a write as indeterminate", () => {
    for (const mode of ["garbage", "array", "bad-error"]) {
      const write = thrown(() =>
        callPrivateWriter("append_plain_text", {}, deps({ ...ON, FAKE_MODE: mode }))
      );
      expect(write).toMatchObject({ code: "invalid_response", committed: "unknown" });
      const read = thrown(() => callPrivateWriter("probe", {}, deps({ ...ON, FAKE_MODE: mode })));
      expect(read).toMatchObject({ code: "invalid_response", committed: undefined });
    }
  });

  it("passes the writer's committed answer and details through", () => {
    const conflict = thrown(() =>
      callPrivateWriter("append_plain_text", {}, deps({ ...ON, FAKE_MODE: "conflict" }))
    );
    expect(conflict).toMatchObject({ code: "revision_conflict", committed: false });
    expect(conflict.details.currentRevision).toMatch(/^r1:c/);
    const verify = thrown(() =>
      callPrivateWriter("append_plain_text", {}, deps({ ...ON, FAKE_MODE: "verify-failed" }))
    );
    expect(verify).toMatchObject({ code: "verification_failed", committed: true });
    const unknown = thrown(() =>
      callPrivateWriter("append_plain_text", {}, deps({ ...ON, FAKE_MODE: "no-committed" }))
    );
    expect(unknown).toMatchObject({ code: "save_failed", committed: "unknown" });
    const read = thrown(() =>
      callPrivateWriter("read_note_state", {}, deps({ ...ON, FAKE_MODE: "conflict" }))
    );
    expect(read.committed).toBeUndefined();
  });
});

describe("validation helpers", () => {
  it("parseWriterResult marks a malformed write success indeterminate", () => {
    const schema = z.object({ status: z.literal("updated"), committed: z.literal(true) });
    expect(thrown(() => parseWriterResult(schema, { status: "updated" }, true)).committed).toBe(
      "unknown"
    );
    expect(
      thrown(() => parseWriterResult(schema, { status: "updated" }, false)).committed
    ).toBeUndefined();
    expect(parseWriterResult(schema, { status: "updated", committed: true }, true)).toEqual({
      status: "updated",
      committed: true,
    });
  });

  it("requireLiveValidated gates unvalidated writes on ALLOW_UNVERIFIED", () => {
    expect(thrown(() => requireLiveValidated(false, "x", {}))).toMatchObject({
      code: "not_live_validated",
      committed: false,
    });
    expect(() =>
      requireLiveValidated(false, "x", { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" })
    ).not.toThrow();
    expect(() => requireLiveValidated(true, "x", {})).not.toThrow();
  });

  it("assertRevision and assertAppendText refuse bad input with committed false", () => {
    expect(thrown(() => assertRevision("r1:xyz")).code).toBe("invalid_request");
    expect(thrown(() => assertRevision("nope", "native-x")).message).toMatch(/native-x/);
    expect(() => assertRevision(REV)).not.toThrow();
    expect(thrown(() => assertAppendText("")).committed).toBe(false);
    expect(thrown(() => assertAppendText("x".repeat(50_001))).code).toBe("invalid_request");
    for (const bad of ["a\rb", "a\u0000", "a\uFFFCb", "a\u2028b", "a\u2029b", "a\u007fb"])
      expect(thrown(() => assertAppendText(bad)).code).toBe("invalid_request");
    expect(() => assertAppendText("line one\n\tline two")).not.toThrow();
  });
});

describe("appendPlainText", () => {
  beforeEach(() => install());

  it("is not live-validated, so it needs ALLOW_UNVERIFIED", () => {
    expect(APPEND_LIVE_VALIDATED).toBe(false);
    const error = thrown(() =>
      appendPlainText({ identifier: NOTE, text: "x", ifRevision: REV }, deps(ON))
    );
    expect(error).toMatchObject({ code: "not_live_validated", committed: false });
  });

  it("validates before spawning", () => {
    expect(
      thrown(() =>
        appendPlainText({ identifier: "nope", text: "x", ifRevision: REV }, deps(UNVERIFIED))
      ).code
    ).toBe("invalid_request");
    expect(
      thrown(() =>
        appendPlainText({ identifier: NOTE, text: "x", ifRevision: "r1:1" }, deps(UNVERIFIED))
      ).code
    ).toBe("invalid_request");
  });

  it("returns the verified result and sends exactly the guarded request", () => {
    const result = appendPlainText(
      { identifier: NOTE, text: "hello", ifRevision: REV },
      deps(UNVERIFIED)
    );
    expect(result).toMatchObject({ status: "updated", committed: true, verified: true });
    expect(result.revisionBefore).toBe(REV);
    expect((result as Record<string, unknown>).echo).toEqual({
      protocol: 1,
      action: "append_plain_text",
      identifier: NOTE,
      text: "hello",
      ifRevision: REV,
    });
  });

  it("treats a malformed success as indeterminate", () => {
    const error = thrown(() =>
      appendPlainText(
        { identifier: NOTE, text: "x", ifRevision: REV },
        deps({ ...UNVERIFIED, FAKE_MODE: "malformed" })
      )
    );
    expect(error).toMatchObject({ code: "invalid_response", committed: "unknown" });
  });
});

describe("privateWriterCapabilities", () => {
  it("reports each gate in order without throwing", () => {
    expect(
      privateWriterCapabilities({ ...deps(ON), platform: "linux" }).features.appendPlainText
    ).toMatchObject({ reason: "unsupported_platform" });
    expect(privateWriterCapabilities(deps()).features.appendPlainText.reason).toBe("disabled");
    expect(
      privateWriterCapabilities(deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1" })).features
        .appendPlainText.reason
    ).toBe("writes_disabled");
    expect(privateWriterCapabilities(deps(ON)).features.appendPlainText.reason).toBe(
      "helper_not_installed"
    );
  });

  it("probes an installed writer and applies the live-validation gate", () => {
    install();
    const gated = privateWriterCapabilities(deps(ON));
    expect(gated.probe?.writesEnabled).toBe(true);
    expect(gated.features.appendPlainText.reason).toBe("not_live_validated");
    expect(privateWriterCapabilities(deps(UNVERIFIED)).features.appendPlainText).toEqual({
      available: true,
      reason: null,
      detail: null,
    });
  });

  it("reports the table features, gating only the writes", () => {
    install();
    const gated = privateWriterCapabilities(deps(ON)).features;
    expect(gated.readTables).toEqual({ available: true, reason: null, detail: null });
    expect(gated.editTables.reason).toBe("not_live_validated");
    expect(gated.pruneOrphanTable.reason).toBe("not_live_validated");
    const open = privateWriterCapabilities(deps(UNVERIFIED)).features;
    expect(open.editTables.available).toBe(true);
    expect(open.pruneOrphanTable.available).toBe(true);
    const off = privateWriterCapabilities(deps()).features;
    expect(Object.values(off).every((f) => f.reason === "disabled")).toBe(true);
    const old = privateWriterCapabilities(deps({ ...UNVERIFIED, FAKE_MODE: "old-probe" }));
    expect(old.features.readTables).toMatchObject({
      available: false,
      reason: "private_api_unavailable",
    });
    expect(old.features.appendPlainText.available).toBe(true);
  });

  it("reports the smart-folder features, gating only the writes", () => {
    install();
    const gated = privateWriterCapabilities(deps(ON)).features;
    expect(gated.readSmartFolders).toEqual({ available: true, reason: null, detail: null });
    expect(gated.editSmartFolders.reason).toBe("not_live_validated");
    expect(privateWriterCapabilities(deps(UNVERIFIED)).features.editSmartFolders.available).toBe(
      true
    );
    const off = privateWriterCapabilities(deps()).features;
    expect(Object.values(off).every((f) => f.reason === "disabled")).toBe(true);
    const old = privateWriterCapabilities(deps({ ...UNVERIFIED, FAKE_MODE: "old-probe" }));
    expect(old.features.readSmartFolders).toMatchObject({
      available: false,
      reason: "private_api_unavailable",
    });
    expect(old.features.appendPlainText.available).toBe(true);
  });

  it("maps probe feature failures and unreachable writers", () => {
    install();
    expect(
      privateWriterCapabilities(deps({ ...ON, FAKE_MODE: "missing-api" })).features.appendPlainText
    ).toMatchObject({
      reason: "private_api_unavailable",
      detail: "missing: -[ICNote saveNoteData]",
    });
    expect(
      privateWriterCapabilities(deps({ ...ON, FAKE_MODE: "missing-api-empty" })).features
        .appendPlainText.detail
    ).toBe("private_api_unavailable");
    expect(
      privateWriterCapabilities(deps({ ...ON, FAKE_MODE: "no-store" })).features.appendPlainText
        .reason
    ).toBe("store_unavailable");
    expect(
      privateWriterCapabilities(deps({ ...ON, FAKE_MODE: "garbage" })).features.appendPlainText
        .reason
    ).toBe("helper_unreachable");
    expect(probePrivateWriter(deps(ON)).role).toBe("writer");
  });

  it("reports every feature in WRITER_FEATURES, each with its own gate", () => {
    const off = privateWriterCapabilities(deps());
    expect(Object.keys(off.features)).toEqual(WRITER_FEATURES.map((f) => f.key));
    for (const f of WRITER_FEATURES) expect(off.features[f.key].reason).toBe("disabled");
    install();
    // The fake probe reports planEdit/editNote but not checklistToggle.
    const on = privateWriterCapabilities(deps(ON)).features;
    expect(on.checklistToggle).toMatchObject({
      available: false,
      reason: "private_api_unavailable",
    });
    expect(on.planEdit.available).toBe(true);
    expect(on.editNote.reason).toBe("not_live_validated");
    expect(privateWriterCapabilities(deps(UNVERIFIED)).features.editNote.available).toBe(true);
  });
});

const REPLACE = [
  {
    op: "replace" as const,
    selector: { text: "Draft" },
    replacement: { text: "Final" },
    expectedCount: 1,
  },
];

describe("editNote", () => {
  beforeEach(() => install());

  it("plans through the read-only plan_edit without the live-validation gate", () => {
    expect(WRITER_ACTIONS.plan_edit).toBe("read");
    expect(WRITER_ACTIONS.edit_note).toBe("write");
    expect(EDIT_LIVE_VALIDATED).toBe(false);
    const plan = editNote({ identifier: NOTE, dryRun: true, operations: REPLACE }, deps(ON));
    expect(plan).toMatchObject({ status: "planned", committed: false, wouldChange: true });
    expect(plan.revisionBefore).toMatch(/^r1:e+$/);
    expect((plan as Record<string, unknown>).echo).toEqual({
      protocol: 1,
      action: "plan_edit",
      identifier: NOTE,
      operations: REPLACE,
    });
  });

  it("applies through edit_note with ifRevision and reports the read-back's preservation", () => {
    const r = editNote(
      {
        identifier: NOTE,
        dryRun: false,
        ifRevision: REV,
        requireNonSystemPaper: true,
        operations: REPLACE,
      },
      deps(UNVERIFIED)
    );
    expect(r).toMatchObject({
      status: "updated",
      committed: true,
      verified: true,
      pushScheduled: false,
      preservation: {
        formattingOutsideEditsVerified: true,
        attachmentGlyphSequenceVerified: true,
        attachmentRowsVerified: true,
      },
    });
    expect((r as Record<string, unknown>).echo).toEqual({
      protocol: 1,
      action: "edit_note",
      identifier: NOTE,
      operations: REPLACE,
      requireNonSystemPaper: true,
      ifRevision: REV,
    });
  });

  it("reports an unchanged apply as not committed", () => {
    const r = editNote(
      { identifier: NOTE, dryRun: false, ifRevision: REV, operations: REPLACE },
      deps({ ...UNVERIFIED, FAKE_MODE: "edit-noop" })
    );
    expect(r).toMatchObject({ status: "unchanged", committed: false });
  });

  it("requires ifRevision, both switches, and the unverified opt-in to apply", () => {
    expect(
      thrown(() =>
        editNote({ identifier: NOTE, dryRun: false, operations: REPLACE }, deps(UNVERIFIED))
      )
    ).toMatchObject({ code: "invalid_request", committed: false });
    expect(
      thrown(() =>
        editNote(
          { identifier: NOTE, dryRun: false, ifRevision: REV, operations: REPLACE },
          deps(ON)
        )
      )
    ).toMatchObject({ code: "not_live_validated", committed: false });
    expect(
      thrown(() =>
        editNote(
          { identifier: NOTE, dryRun: false, ifRevision: REV, operations: REPLACE },
          deps({ APPLE_NOTES_MCP_ENABLE_PRIVATE: "1", APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" })
        )
      )
    ).toMatchObject({ code: "writes_disabled", committed: false });
  });

  it("validates identifier, revision, and operations before spawning", () => {
    const d = deps(UNVERIFIED);
    expect(
      thrown(() => editNote({ identifier: "x", dryRun: true, operations: REPLACE }, d))
    ).toMatchObject({ code: "invalid_request", committed: undefined });
    expect(
      thrown(() =>
        editNote(
          { identifier: NOTE, dryRun: false, ifRevision: "sha256:x", operations: REPLACE },
          d
        )
      )
    ).toMatchObject({ code: "invalid_request", committed: false });
    expect(
      thrown(() => editNote({ identifier: NOTE, dryRun: false, operations: [] }, d))
    ).toMatchObject({ code: "invalid_request", committed: false });
    const bad = thrown(() =>
      editNote(
        {
          identifier: NOTE,
          dryRun: true,
          operations: [
            { op: "replace", selector: { text: "a\nb" }, replacement: { text: "x" } },
          ] as never,
        },
        d
      )
    );
    expect(bad.code).toBe("invalid_request");
    expect(bad.message).toMatch(/one paragraph/);
  });

  it("passes a native refusal through; a plan failure is not a write", () => {
    const e = thrown(() =>
      editNote(
        { identifier: NOTE, dryRun: true, operations: REPLACE },
        deps({ ...ON, FAKE_MODE: "edit-side-effect" })
      )
    );
    expect(e.code).toBe("unexpected_side_effect");
    expect(e.committed).toBeUndefined();
    expect(e.details.objects).toEqual(["updated ICAttachment (noteUsingTitleForNoteTitle)"]);
    const applied = thrown(() =>
      editNote(
        { identifier: NOTE, dryRun: false, ifRevision: REV, operations: REPLACE },
        deps({ ...UNVERIFIED, FAKE_MODE: "edit-side-effect" })
      )
    );
    expect(applied.committed).toBe(false);
  });

  it("treats a malformed apply success as indeterminate but a malformed plan as not a write", () => {
    const d = deps({ ...UNVERIFIED, FAKE_MODE: "malformed" });
    expect(
      thrown(() => editNote({ identifier: NOTE, dryRun: true, operations: REPLACE }, d)).committed
    ).toBeUndefined();
    expect(
      thrown(() =>
        editNote({ identifier: NOTE, dryRun: false, ifRevision: REV, operations: REPLACE }, d)
      ).committed
    ).toBe("unknown");
  });
});

describe("edit operation schema", () => {
  const ok = (op: unknown) => editOperationSchema.safeParse(op).success;

  it("accepts every operation shape", () => {
    expect(ok(REPLACE[0])).toBe(true);
    expect(
      ok({
        op: "replace",
        selector: {
          kind: "text",
          text: "Mixed bold",
          scope: "all",
          match: "equals",
          occurrence: 2,
        },
        replacement: { runs: [{ text: "x", bold: true, italic: true, underline: true }] },
        expectedCount: 2,
      })
    ).toBe(true);
    expect(
      ok({ op: "delete_paragraph", selector: { text: "Row", occurrence: 2 }, expectedCount: 2 })
    ).toBe(true);
    expect(ok({ op: "delete_paragraph", selector: { kind: "blank", style: "checklist" } })).toBe(
      true
    );
    expect(
      ok({
        op: "insert_after",
        anchor: { kind: "style", style: "subheading", occurrence: 2 },
        expectedCount: 3,
        blocks: [
          { type: "heading", text: "H" },
          { type: "checklist", text: "Done", checked: true },
          { type: "body", text: "" },
          { type: "body", runs: [{ text: "b", strikethrough: true }] },
        ],
      })
    ).toBe(true);
    expect(
      ok({
        op: "insert_before",
        anchor: { text: "Anchor" },
        blocks: [{ type: "dashed", text: "d" }],
      })
    ).toBe(true);
    expect(ok({ op: "set_title", replacement: { text: "New title" } })).toBe(true);
  });

  it("rejects what the writer would refuse", () => {
    expect(ok({ op: "replace", selector: { text: "" }, replacement: { text: "x" } })).toBe(false);
    for (const bad of ["a\u2028b", "a\u2029b", "a\nb", "a\rb", "a\uFFFCb"])
      expect(ok({ op: "replace", selector: { text: bad }, replacement: { text: "x" } })).toBe(
        false
      );
    expect(ok({ op: "replace", selector: { text: "a" }, replacement: { text: "\uFFFC" } })).toBe(
      false
    );
    expect(
      ok({ op: "replace", selector: { text: "a" }, replacement: { text: "x", runs: [] } })
    ).toBe(false);
    expect(ok({ op: "replace", selector: { text: "a" }, replacement: { runs: [] } })).toBe(false);
    expect(
      ok({ op: "replace", selector: { kind: "style", style: "body" }, replacement: { text: "x" } })
    ).toBe(false);
    expect(ok({ op: "delete_paragraph", selector: { kind: "blank", style: "body" } })).toBe(false);
    expect(ok({ op: "delete_paragraph", selector: { kind: "attachment", id: "x" } })).toBe(false);
    expect(
      ok({
        op: "delete_paragraph",
        selector: { kind: "attachment", id: "x-coredata://ABC/ICNote/p1" },
      })
    ).toBe(false);
    expect(
      ok({ op: "insert_after", anchor: { text: "a" }, blocks: [{ type: "title", text: "t" }] })
    ).toBe(false);
    expect(ok({ op: "insert_after", anchor: { text: "a" }, blocks: [{ type: "body" }] })).toBe(
      false
    );
    expect(
      ok({
        op: "insert_after",
        anchor: { text: "a" },
        blocks: [{ type: "body", text: "t", checked: true }],
      })
    ).toBe(false);
    expect(ok({ op: "set_title", replacement: { text: "" } })).toBe(false);
    expect(ok({ op: "rewrite", selector: { text: "a" } })).toBe(false);
    expect(ok({ ...REPLACE[0], extra: 1 })).toBe(false);
  });
});

describe("attachment selector schema", () => {
  const ok = (op: unknown) => editOperationSchema.safeParse(op).success;
  const ATTACHMENT = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
  const CORE_DATA = "x-coredata://ABC-123/ICAttachment/p42";

  it("names one attachment by identifier, x-coredata id, or ordinal in every role", () => {
    for (const named of [{ identifier: ATTACHMENT }, { id: CORE_DATA }, { ordinal: 2 }]) {
      const selector = { kind: "attachment", ...named };
      expect(ok({ op: "replace", selector, replacement: { text: "" } })).toBe(true);
      expect(ok({ op: "delete_paragraph", selector })).toBe(true);
      expect(
        ok({ op: "insert_after", anchor: selector, blocks: [{ type: "body", text: "x" }] })
      ).toBe(true);
      expect(
        ok({ op: "insert_before", anchor: selector, blocks: [{ type: "body", text: "x" }] })
      ).toBe(true);
    }
    for (const position of ["self", "before", "after"])
      expect(
        ok({
          op: "replace",
          selector: { kind: "attachment", ordinal: 1, position },
          replacement: { runs: [{ text: "caption", italic: true }] },
        })
      ).toBe(true);
  });

  it("refuses a selector that names zero or several attachments, or a bad id", () => {
    const replace = (selector: unknown) => ({
      op: "replace",
      selector,
      replacement: { text: "x" },
    });
    expect(ok(replace({ kind: "attachment" }))).toBe(false);
    expect(ok(replace({ kind: "attachment", identifier: ATTACHMENT, ordinal: 1 }))).toBe(false);
    expect(ok(replace({ kind: "attachment", id: CORE_DATA, identifier: ATTACHMENT }))).toBe(false);
    expect(ok(replace({ kind: "attachment", identifier: "not-a-uuid" }))).toBe(false);
    expect(ok(replace({ kind: "attachment", ordinal: 0 }))).toBe(false);
    expect(ok(replace({ kind: "attachment", ordinal: 1, position: "inside" }))).toBe(false);
    expect(ok(replace({ kind: "attachment", ordinal: 1, match: "equals" }))).toBe(false);
    // position is a replace-only field.
    expect(
      ok({
        op: "delete_paragraph",
        selector: { kind: "attachment", ordinal: 1, position: "after" },
      })
    ).toBe(false);
    expect(
      ok({
        op: "insert_after",
        anchor: { kind: "attachment", ordinal: 1, position: "after" },
        blocks: [{ type: "body", text: "x" }],
      })
    ).toBe(false);
    // Replacement text still may not carry a glyph.
    expect(
      ok({
        op: "replace",
        selector: { kind: "attachment", ordinal: 1 },
        replacement: { text: "\uFFFC" },
      })
    ).toBe(false);
  });

  it("passes an attachment edit through and reports what the read-back proved", () => {
    install();
    const operations = [
      {
        op: "replace" as const,
        selector: { kind: "attachment" as const, identifier: ATTACHMENT },
        replacement: { text: "" },
      },
    ];
    const r = editNote(
      { identifier: NOTE, dryRun: false, ifRevision: REV, operations },
      deps({ ...UNVERIFIED, FAKE_MODE: "edit-attachment" })
    );
    expect(r).toMatchObject({
      status: "updated",
      removedAttachments: [ATTACHMENT],
      preservation: {
        attachmentRowsVerified: true,
        otherAttachmentRowsUnchanged: 2,
        removedAttachments: [
          { identifier: ATTACHMENT, rowStillInNote: true, markedForDeletion: false },
        ],
      },
    });
    expect((r as Record<string, unknown>).echo).toMatchObject({ action: "edit_note", operations });
  });
});

describe("trim_blank_lines schema", () => {
  const ok = (op: unknown) => editOperationSchema.safeParse(op).success;

  it("accepts each mode with its own fields", () => {
    expect(ok({ op: "trim_blank_lines", mode: "runs" })).toBe(true);
    expect(ok({ op: "trim_blank_lines", mode: "runs", keep: 0, expectedCount: 4 })).toBe(true);
    expect(ok({ op: "trim_blank_lines", mode: "end", id: "tail" })).toBe(true);
    expect(
      ok({ op: "trim_blank_lines", mode: "around", anchor: { text: "Agenda" }, side: "after" })
    ).toBe(true);
    expect(
      ok({
        op: "trim_blank_lines",
        mode: "around",
        anchor: { kind: "style", style: "heading", occurrence: 2 },
        keep: 1,
      })
    ).toBe(true);
  });

  it("rejects what the writer would refuse", () => {
    expect(ok({ op: "trim_blank_lines" })).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "all" })).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "runs", keep: 11 })).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "runs", keep: -1 })).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "around" })).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "runs", anchor: { text: "A" } })).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "end", side: "before" })).toBe(false);
    expect(
      ok({ op: "trim_blank_lines", mode: "around", anchor: { text: "A" }, side: "middle" })
    ).toBe(false);
    expect(ok({ op: "trim_blank_lines", mode: "runs", selector: { text: "A" } })).toBe(false);
  });

  it("refuses an around trim without an anchor before spawning, and passes a valid one through", () => {
    install();
    expect(
      thrown(() =>
        editNote(
          {
            identifier: NOTE,
            dryRun: true,
            operations: [{ op: "trim_blank_lines", mode: "around" }] as never,
          },
          deps(ON)
        )
      )
    ).toMatchObject({ code: "invalid_request" });
    const operations = [{ op: "trim_blank_lines" as const, mode: "end" as const }];
    const plan = editNote({ identifier: NOTE, dryRun: true, operations }, deps(ON));
    expect((plan as Record<string, unknown>).echo).toMatchObject({
      action: "plan_edit",
      operations,
    });
  });
});

describe("rich runs, inline appends, checklist replacement, and file replacement", () => {
  const ok = (op: unknown) => editOperationSchema.safeParse(op).success;
  const ATTACHMENT = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";

  it("accepts link, highlight, and color on replacement and block runs", () => {
    const runs = [
      { text: "see " },
      { text: "source", link: "https://example.com/a", highlight: "mint", color: "#FF0000" },
      { text: "mail", link: "mailto:a@example.com", bold: true },
    ];
    expect(ok({ op: "replace", selector: { text: "x" }, replacement: { runs } })).toBe(true);
    expect(
      ok({ op: "insert_after", anchor: { text: "a" }, blocks: [{ type: "bulleted", runs }] })
    ).toBe(true);
    expect(ok({ op: "set_title", replacement: { runs } })).toBe(true);
  });

  it("rejects run formatting the writer would refuse", () => {
    const run = (extra: Record<string, unknown>) => ({
      op: "replace",
      selector: { text: "x" },
      replacement: { runs: [{ text: "y", ...extra }] },
    });
    expect(ok(run({ link: "javascript:alert(1)" }))).toBe(false);
    expect(ok(run({ link: "not a url" }))).toBe(false);
    expect(ok(run({ link: "https://" + "a".repeat(4100) }))).toBe(false);
    expect(ok(run({ highlight: "green" }))).toBe(false);
    expect(ok(run({ color: "red" }))).toBe(false);
    expect(ok(run({ color: "#FF00001" }))).toBe(false);
    // The runs together stay within the writer's 10,000 UTF-16 units.
    const long = { text: "a".repeat(6000) };
    expect(
      ok({ op: "replace", selector: { text: "x" }, replacement: { runs: [long, long] } })
    ).toBe(false);
  });

  it("appends runs to the end of one paragraph", () => {
    const runs = [{ text: " " }, { text: "source", link: "https://example.com/" }];
    expect(ok({ op: "append_to_paragraph", anchor: { text: "Buy milk" }, runs })).toBe(true);
    expect(
      ok({
        op: "append_to_paragraph",
        anchor: { kind: "style", style: "bulleted", occurrence: 2 },
        runs,
        expectedCount: 3,
      })
    ).toBe(true);
    expect(ok({ op: "append_to_paragraph", anchor: { text: "a" }, runs: [] })).toBe(false);
    expect(ok({ op: "append_to_paragraph", anchor: { text: "a" }, text: "x" })).toBe(false);
  });

  it("replaces a checklist by block or all with explicit done states", () => {
    const items = [
      { text: "Passport", checked: true },
      { runs: [{ text: "Charger", bold: true }], checked: false, indent: 1 },
    ];
    expect(ok({ op: "replace_checklist", items })).toBe(true);
    expect(
      ok({ op: "replace_checklist", containing: "Socks", occurrence: 1, items, expectedCount: 4 })
    ).toBe(true);
    expect(ok({ op: "replace_checklist", select: "all", items })).toBe(true);
    expect(ok({ op: "replace_checklist", select: "all", containing: "Socks", items })).toBe(false);
    expect(ok({ op: "replace_checklist", select: "all", occurrence: 2, items })).toBe(false);
    expect(ok({ op: "replace_checklist", items: [] })).toBe(false);
    expect(ok({ op: "replace_checklist", items: [{ text: "no state" }] })).toBe(false);
    expect(ok({ op: "replace_checklist", items: [{ text: "", checked: false }] })).toBe(false);
    expect(ok({ op: "replace_checklist", items: [{ text: "a", checked: true, indent: 9 }] })).toBe(
      false
    );
    // Checked rows can also be inserted as blocks.
    expect(
      ok({
        op: "insert_after",
        anchor: { text: "a" },
        blocks: [{ type: "checklist", text: "done", checked: true }],
      })
    ).toBe(true);
  });

  it("takes a file only in an attachment replace at position self", () => {
    const file = { file: "/tmp/chart.png", filename: "Q3.png" };
    expect(
      ok({
        op: "replace",
        selector: { kind: "attachment", identifier: ATTACHMENT },
        replacement: file,
      })
    ).toBe(true);
    expect(
      ok({
        op: "replace",
        selector: { kind: "attachment", ordinal: 1, position: "self" },
        replacement: { file: "/tmp/a.pdf" },
      })
    ).toBe(true);
    expect(
      ok({
        op: "replace",
        selector: { kind: "attachment", ordinal: 1, position: "after" },
        replacement: file,
      })
    ).toBe(false);
    expect(ok({ op: "replace", selector: { text: "x" }, replacement: file })).toBe(false);
    expect(
      ok({
        op: "replace",
        selector: { kind: "attachment", ordinal: 1 },
        replacement: { ...file, text: "x" },
      })
    ).toBe(false);
  });

  it("rejects the other inputs the writer refuses", () => {
    // occurrence picks one of expectedCount matches, so it cannot exceed it.
    expect(
      ok({ op: "replace", selector: { text: "a", occurrence: 2 }, replacement: { text: "b" } })
    ).toBe(false);
    expect(
      ok({
        op: "replace",
        selector: { text: "a", occurrence: 2 },
        replacement: { text: "b" },
        expectedCount: 2,
      })
    ).toBe(true);
    expect(
      ok({
        op: "insert_after",
        anchor: { kind: "style", style: "heading", occurrence: 3 },
        blocks: [{ type: "body", text: "x" }],
        expectedCount: 2,
      })
    ).toBe(false);
    // Only a body block may be empty.
    expect(
      ok({ op: "insert_after", anchor: { text: "a" }, blocks: [{ type: "heading", text: "" }] })
    ).toBe(false);
    expect(
      ok({ op: "insert_after", anchor: { text: "a" }, blocks: [{ type: "body", text: "" }] })
    ).toBe(true);
    // Text beside an attachment must not be empty.
    expect(
      ok({
        op: "replace",
        selector: { kind: "attachment", ordinal: 1, position: "before" },
        replacement: { text: "" },
      })
    ).toBe(false);
    // An unpaired surrogate never reaches the writer; a paired one is fine.
    expect(ok({ op: "replace", selector: { text: "a\uD83D" }, replacement: { text: "b" } })).toBe(
      false
    );
    expect(ok({ op: "replace", selector: { text: "a" }, replacement: { text: "\uDE00" } })).toBe(
      false
    );
    expect(ok({ op: "replace", selector: { text: "a" }, replacement: { text: "😀" } })).toBe(true);
    // Operation ids are unique within a request.
    const twice = [
      { op: "set_title", id: "t", replacement: { text: "A" } },
      { op: "delete_paragraph", id: "t", selector: { text: "x" } },
    ];
    expect(editOperationsSchema.safeParse(twice).success).toBe(false);
  });

  it("checks a replacement file before spawning the writer", () => {
    install();
    const image = join(root, "chart.png");
    writeFileSync(image, "png bytes");
    const replace = (replacement: Record<string, unknown>) => [
      {
        op: "replace" as const,
        selector: { kind: "attachment" as const, ordinal: 1 },
        replacement: replacement as { file: string },
      },
    ];
    const plan = editNote(
      { identifier: NOTE, dryRun: true, operations: replace({ file: image, filename: "Q3.PNG" }) },
      deps(ON)
    );
    expect((plan as Record<string, unknown>).echo).toMatchObject({ action: "plan_edit" });
    const refused = (replacement: Record<string, unknown>) =>
      thrown(() =>
        editNote({ identifier: NOTE, dryRun: true, operations: replace(replacement) }, deps(ON))
      );
    expect(refused({ file: "relative.png" }).message).toMatch(/absolute/);
    expect(refused({ file: "/etc/hosts" }).message).toMatch(/outside allowed locations/);
    expect(refused({ file: join(root, "missing.png") }).message).toMatch(/does not exist/);
    writeFileSync(join(root, "empty.png"), "");
    expect(refused({ file: join(root, "empty.png") }).message).toMatch(/is empty/);
    symlinkSync(image, join(root, "link.png"));
    expect(refused({ file: join(root, "link.png") }).message).toMatch(/symbolic link|resolves/);
    // add-attachment's policy: no hidden paths and no FIFOs.
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id.png"), "secret");
    expect(refused({ file: join(root, ".ssh", "id.png") }).message).toMatch(
      /hidden file or directory/
    );
    execFileSync("mkfifo", [join(root, "pipe.png")]);
    expect(refused({ file: join(root, "pipe.png") }).message).toMatch(/not a regular file/);
    expect(refused({ file: image, filename: "chart.pdf" }).message).toMatch(/extension/);
    expect(refused({ file: image, filename: "a/b.png" }).message).toMatch(/one path component/);
  });

  it("passes ifPlanDigest on apply only", () => {
    install();
    const digest = `p2:${"b".repeat(64)}`;
    const r = editNote(
      {
        identifier: NOTE,
        dryRun: false,
        ifRevision: REV,
        ifPlanDigest: digest,
        operations: REPLACE,
      },
      deps(UNVERIFIED)
    );
    expect((r as Record<string, unknown>).echo).toMatchObject({
      action: "edit_note",
      ifPlanDigest: digest,
    });
    expect(
      thrown(() =>
        editNote(
          { identifier: NOTE, dryRun: true, ifPlanDigest: digest, operations: REPLACE },
          deps(ON)
        )
      ).code
    ).toBe("invalid_request");
    expect(
      thrown(() =>
        editNote(
          {
            identifier: NOTE,
            dryRun: false,
            ifRevision: REV,
            ifPlanDigest: "p1:x",
            operations: REPLACE,
          },
          deps(UNVERIFIED)
        )
      )
    ).toMatchObject({ code: "invalid_request", committed: false });
  });

  it("lists file replacement as its own gated feature", () => {
    expect(WRITER_FEATURES.find((row) => row.key === "editReplaceFile")).toMatchObject({
      key: "editReplaceFile",
      probeKey: "editReplaceFile",
      liveValidated: false,
    });
  });
});

describe("writer feature table", () => {
  it("reports edit planning without the unverified gate and gates applying", () => {
    install();
    expect(WRITER_FEATURES.map((row) => row.key)).toEqual(
      expect.arrayContaining(["appendPlainText", "planEdit", "editNote"])
    );
    const gated = privateWriterCapabilities(deps(ON)).features;
    expect(gated.planEdit).toEqual({ available: true, reason: null, detail: null });
    expect(gated.editNote).toMatchObject({ available: false, reason: "not_live_validated" });
    expect(privateWriterCapabilities(deps(UNVERIFIED)).features.editNote.available).toBe(true);
    expect(privateWriterCapabilities(deps()).features.planEdit.reason).toBe("disabled");
  });

  it("reports a feature the probe does not list as unavailable", () => {
    install();
    const old = privateWriterCapabilities(
      deps({ ...UNVERIFIED, FAKE_MODE: "old-writer" })
    ).features;
    expect(old.appendPlainText.available).toBe(true);
    expect(old.planEdit).toMatchObject({ available: false, reason: "private_api_unavailable" });
    expect(old.editNote.detail).toMatch(/does not report editNote/);
  });
});
