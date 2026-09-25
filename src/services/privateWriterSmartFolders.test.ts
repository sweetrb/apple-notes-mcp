/**
 * Smart-folder writer client tests. A Node script stands in for the writer
 * binary, so these exercise the real spawn, checksum, switches, request
 * shape, and response validation paths without NotesShared or the store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./privateHelper.js";
import {
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  SMART_FOLDERS_LIVE_VALIDATED,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import {
  assertFolderReference,
  assertFolderTitle,
  createSmartFolder,
  deleteSmartFolder,
  queryText,
  readSmartFolder,
  updateSmartFolder,
} from "./privateWriterSmartFolders.js";

const FOLDER = "E2729208-DF8F-44C9-B6D6-1E5D0D02B8C2";
const PARENT = "6D246B17-0E48-47C4-BD1C-72D9F8AEAC0C";
const ACCOUNT = "68D7C21A-A0B1-4A43-A220-9D0002F386B5";
const REV = `f1:${"a".repeat(64)}`;
const QUERY = { entity: "note", type: { checklist: true } };
const STORED = '{"entity":"note","type":{"and":[{"deleted":false},{"and":[{"checklist":true}]}]}}';

/** Answers per FAKE_MODE and echoes the request so tests can assert the wire shape. */
const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  if (mode === "conflict") out({ status: "error", code: "revision_conflict", message: "changed", committed: false, currentRevision: "f1:" + "c".repeat(64) }, 1);
  if (mode === "parent") out({ status: "error", code: "unsupported_folder", message: "smart parent", committed: false, reason: "smart_folder_destination" }, 1);
  if (mode === "no-committed") out({ status: "error", code: "save_failed", message: "?" }, 1);
  if (mode === "malformed") out({ status: "ok" });
  const state = {
    identifier: "${FOLDER}", objectURI: "x-coredata://S/ICFolder/p1", title: "T", folderType: 2,
    accountIdentifier: "${ACCOUNT}", parentIdentifier: "${PARENT}", queryJSON: ${JSON.stringify(STORED)},
    markedForDeletion: false, childFolderCount: 0, physicalNoteCount: 0, titleDurability: "stamped",
    parentDurability: "stamped", revision: "f1:" + "b".repeat(64),
    cloudSync: { available: true, inICloudAccount: true, currentLocalVersion: 2, latestVersionSyncedToCloud: 0, uploadPending: true },
  };
  const push = { pushScheduled: false, syncHostRunning: true, pushState: "awaiting_notes_app", storeKind: "copy" };
  const resolution = { requestedQueryJSON: req.queryJSON, queryJSON: ${JSON.stringify(STORED)}, queryNormalized: true,
    deletedWrapperAdded: true, resolvedTags: [], filterCount: 1, nativeQueryValidated: true, nativeMinimumSupportedVersion: 9 };
  switch (req.action) {
    case "read_smart_folder":
      out({ ...state, status: "ok", syncHostRunning: true, echo: req });
    case "create_smart_folder":
      out({ ...state, ...push, ...resolution, status: "created", changed: true, existing: false, committed: true, verified: true, echo: req });
    case "update_smart_folder":
      out({ ...state, ...push, ...resolution, status: "updated", changed: true, committed: true, verified: true, revisionBefore: req.ifRevision, revisionAfter: state.revision, previousQueryJSON: "{}", echo: req });
    case "delete_smart_folder":
      if (req.dryRun) out({ ...state, status: "planned", dryRun: true, committed: false, echo: req });
      out({ ...state, ...push, markedForDeletion: true, status: "deleted", dryRun: false, committed: true, verified: true, revisionBefore: req.ifRevision, revisionAfter: state.revision, echo: req });
    default:
      out({ status: "error", code: "unknown_action", message: "no" }, 1);
  }
});
`;

let root: string;
let deps: (env?: Record<string, string>) => PrivateHelperDeps;
const GATED = { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "writer-smart-folder-test-"));
  const installDir = join(root, "install");
  const sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, "// fake writer source\n");
  mkdirSync(installDir, { recursive: true });
  const binaryPath = join(installDir, WRITER_BINARY_NAME);
  writeFileSync(binaryPath, FAKE_WRITER);
  chmodSync(binaryPath, 0o755);
  writeFileSync(
    join(installDir, WRITER_MANIFEST_NAME),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: PRIVATE_WRITER_PROTOCOL,
      sourceSha256: sha256Hex("// fake writer source\n"),
      binarySha256: sha256Hex(FAKE_WRITER),
      builtAt: "2026-09-24T00:00:00.000Z",
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
        APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1",
        ...env,
      },
      platform: "darwin",
      sourcePath,
    });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

describe("input validation", () => {
  it("serializes a query object and checks a query string", () => {
    expect(queryText(QUERY, "query")).toBe(JSON.stringify(QUERY));
    expect(queryText(STORED, "query")).toBe(STORED);
    expect(caught(() => queryText("{", "query")).message).toMatch(/not valid JSON/);
    expect(caught(() => queryText("[1]", "query")).message).toMatch(/JSON object/);
    expect(caught(() => queryText("x".repeat(70_000), "query")).code).toBe("invalid_request");
    const big = { entity: "note", type: { tag: "x".repeat(70_000) } };
    expect(caught(() => queryText(big, "query")).message).toMatch(/64 KiB/);
  });

  it("refuses bad titles and folder references with committed false", () => {
    for (const bad of ["", " padded", "a\u0000b", "x".repeat(257)])
      expect(caught(() => assertFolderTitle(bad))).toMatchObject({
        code: "invalid_request",
        committed: false,
      });
    expect(() => assertFolderTitle("Checklists")).not.toThrow();
    expect(() => assertFolderReference(PARENT, "p")).not.toThrow();
    expect(() => assertFolderReference("DefaultFolder-CloudKit", "p")).not.toThrow();
    expect(() =>
      assertFolderReference("x-coredata://8FA9FE0E-3B93/ICFolder/p12", "p")
    ).not.toThrow();
    expect(caught(() => assertFolderReference("a/b", "p")).code).toBe("invalid_request");
  });
});

describe("switches and gates", SPAWN_TIMEOUT, () => {
  it("refuses every smart-folder action without the write switch, reads included", () => {
    const off = { APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "" };
    expect(caught(() => readSmartFolder(FOLDER, deps(off)))).toMatchObject({
      code: "writes_disabled",
      committed: undefined,
    });
    expect(caught(() => createSmartFolder({ title: "T", query: QUERY }, deps(off)))).toMatchObject({
      code: "writes_disabled",
      committed: false,
    });
    expect(
      caught(() => deleteSmartFolder({ identifier: FOLDER, dryRun: true }, deps(off)))
    ).toMatchObject({ code: "writes_disabled", committed: undefined });
  });

  it("gates every write until live validation, but not the reads or the dry run", () => {
    expect(SMART_FOLDERS_LIVE_VALIDATED).toBe(false);
    for (const [fn, tool] of [
      [() => createSmartFolder({ title: "T", query: QUERY }, deps(GATED)), /create-smart/],
      [
        () => updateSmartFolder({ identifier: FOLDER, query: QUERY, ifRevision: REV }, deps(GATED)),
        /update-smart/,
      ],
      [
        () =>
          deleteSmartFolder({ identifier: FOLDER, dryRun: false, ifRevision: REV }, deps(GATED)),
        /delete-smart/,
      ],
    ] as const) {
      const error = caught(fn);
      expect(error).toMatchObject({ code: "not_live_validated", committed: false });
      expect(error.message).toMatch(tool);
    }
    expect(readSmartFolder(FOLDER, deps(GATED)).status).toBe("ok");
    expect(deleteSmartFolder({ identifier: FOLDER, dryRun: true }, deps(GATED)).status).toBe(
      "planned"
    );
  });
});

describe("readSmartFolder", SPAWN_TIMEOUT, () => {
  it("validates the identifier and decodes the stored rules", () => {
    expect(caught(() => readSmartFolder("DefaultFolder-CloudKit", deps())).code).toBe(
      "invalid_request"
    );
    const folder = readSmartFolder(FOLDER, deps());
    expect(folder.echo).toEqual({ protocol: 1, action: "read_smart_folder", identifier: FOLDER });
    expect(folder.decoded).toMatchObject({ match: "all", fullyDecoded: true });
    expect(folder.decoded.filters[0].type).toBe("checklist");
  });

  it("rejects a malformed read as a failed read", () => {
    expect(caught(() => readSmartFolder(FOLDER, deps({ FAKE_MODE: "malformed" })))).toMatchObject({
      code: "invalid_response",
      committed: undefined,
    });
  });
});

describe("createSmartFolder", SPAWN_TIMEOUT, () => {
  it("sends only the fields given and returns the verified result", () => {
    const created = createSmartFolder(
      { title: "T", query: QUERY, parentIdentifier: PARENT },
      deps()
    );
    expect(created).toMatchObject({ status: "created", committed: true, filterCount: 1 });
    expect(created.decoded.fullyDecoded).toBe(true);
    expect(created.echo).toEqual({
      protocol: 1,
      action: "create_smart_folder",
      title: "T",
      queryJSON: JSON.stringify(QUERY),
      parentIdentifier: PARENT,
    });
    const root = createSmartFolder({ title: "T", query: STORED, account: "iCloud" }, deps());
    expect(root.echo).toMatchObject({ account: "iCloud", queryJSON: STORED });
  });

  it("refuses account plus parent, and an empty account, before spawning", () => {
    expect(
      caught(() =>
        createSmartFolder(
          { title: "T", query: QUERY, account: "iCloud", parentIdentifier: PARENT },
          deps()
        )
      ).message
    ).toMatch(/not both/);
    expect(
      caught(() => createSmartFolder({ title: "T", query: QUERY, account: " " }, deps())).code
    ).toBe("invalid_request");
  });

  it("passes the smart-folder destination refusal through with its reason", () => {
    const error = caught(() =>
      createSmartFolder(
        { title: "T", query: QUERY, parentIdentifier: FOLDER },
        deps({ FAKE_MODE: "parent" })
      )
    );
    expect(error).toMatchObject({ code: "unsupported_folder", committed: false });
    expect(error.details.reason).toBe("smart_folder_destination");
  });

  it("reports a timeout and a missing committed answer as indeterminate", () => {
    expect(
      caught(() =>
        createSmartFolder(
          { title: "T", query: QUERY },
          deps({ FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" })
        )
      )
    ).toMatchObject({ code: "timeout", committed: "unknown" });
    expect(
      caught(() =>
        createSmartFolder({ title: "T", query: QUERY }, deps({ FAKE_MODE: "no-committed" }))
      )
    ).toMatchObject({ code: "save_failed", committed: "unknown" });
  });
});

describe("updateSmartFolder", SPAWN_TIMEOUT, () => {
  it("sends the guarded request and returns both revisions", () => {
    const updated = updateSmartFolder(
      { identifier: FOLDER, query: QUERY, ifRevision: REV },
      deps()
    );
    expect(updated).toMatchObject({ status: "updated", revisionBefore: REV, committed: true });
    expect(updated.echo).toEqual({
      protocol: 1,
      action: "update_smart_folder",
      identifier: FOLDER,
      queryJSON: JSON.stringify(QUERY),
      ifRevision: REV,
    });
  });

  it("refuses a note revision or a bad identifier, and passes a conflict through", () => {
    expect(
      caught(() =>
        updateSmartFolder(
          { identifier: FOLDER, query: QUERY, ifRevision: `r1:${"a".repeat(64)}` },
          deps()
        )
      ).message
    ).toMatch(/native-read-smart-folder/);
    expect(
      caught(() => updateSmartFolder({ identifier: "x", query: QUERY, ifRevision: REV }, deps()))
        .code
    ).toBe("invalid_request");
    const conflict = caught(() =>
      updateSmartFolder(
        { identifier: FOLDER, query: QUERY, ifRevision: REV },
        deps({ FAKE_MODE: "conflict" })
      )
    );
    expect(conflict).toMatchObject({ code: "revision_conflict", committed: false });
    expect(conflict.details.currentRevision).toMatch(/^f1:c/);
  });
});

describe("deleteSmartFolder", SPAWN_TIMEOUT, () => {
  it("plans without a revision, then applies with one", () => {
    const plan = deleteSmartFolder({ identifier: FOLDER, dryRun: true }, deps());
    expect(plan).toMatchObject({ status: "planned", committed: false });
    expect(plan.echo).toEqual({
      protocol: 1,
      action: "delete_smart_folder",
      identifier: FOLDER,
      dryRun: true,
    });
    const done = deleteSmartFolder({ identifier: FOLDER, dryRun: false, ifRevision: REV }, deps());
    expect(done).toMatchObject({ status: "deleted", verified: true, markedForDeletion: true });
  });

  it("refuses a revision on the dry run and a missing one on the apply", () => {
    expect(
      caught(() => deleteSmartFolder({ identifier: FOLDER, dryRun: true, ifRevision: REV }, deps()))
        .message
    ).toMatch(/only accepted with dryRun: false/);
    expect(
      caught(() => deleteSmartFolder({ identifier: FOLDER, dryRun: false }, deps())).code
    ).toBe("invalid_request");
  });

  it("treats a dry-run timeout as a failed read and an apply timeout as indeterminate", () => {
    const slow = { FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300" };
    expect(
      caught(() => deleteSmartFolder({ identifier: FOLDER, dryRun: true }, deps(slow)))
    ).toMatchObject({ code: "timeout", committed: undefined });
    expect(
      caught(() =>
        deleteSmartFolder({ identifier: FOLDER, dryRun: false, ifRevision: REV }, deps(slow))
      )
    ).toMatchObject({ code: "timeout", committed: "unknown" });
  });
});
