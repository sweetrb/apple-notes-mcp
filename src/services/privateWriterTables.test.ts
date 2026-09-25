/**
 * Native table client tests. A Node script stands in for the writer binary,
 * so the real spawn, checksum, gating, and response-validation paths run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./privateHelper.js";
import {
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  TABLE_WRITES_LIVE_VALIDATED,
  WRITER_BINARY_NAME,
  WRITER_MANIFEST_NAME,
  defaultWriterDeps,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import {
  assertCellText,
  deleteTableRow,
  insertTableRow,
  pruneOrphanTable,
  readTables,
  setTableCell,
} from "./privateWriterTables.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const TABLE = "060A37B0-CAD4-4A4F-A55D-265099370F9F";
const ROW = "62A0F5AC-4A7A-4877-A6B8-FAE726CC052F";
const COL = "8FA6AAE5-4811-45DF-9900-44DAB38A614A";
const REV = `r1:${"a".repeat(64)}`;
const DIGEST = `t1:${"b".repeat(64)}`;

const FAKE_WRITER = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const mode = process.env.FAKE_MODE || "ok";
  const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + "\\n"); process.exit(code); };
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  if (mode === "malformed") out({ status: "ok" });
  const rev = "r1:" + "c".repeat(64), dig = "t1:" + "d".repeat(64);
  const cloudSync = { available: true, inICloudAccount: true };
  const push = { pushScheduled: false, pushState: "awaiting_notes_app", syncHostRunning: true, storeKind: "copy", cloudSync };
  const write = { status: "updated", dryRun: false, committed: true, verified: true, identifier: req.identifier, tableIdentifier: req.tableIdentifier, revisionBefore: req.ifRevision, revisionAfter: rev, tableDigestBefore: req.ifTableDigest, tableDigestAfter: dig, rowCount: 3, columnCount: 2, cloudSync, ...push, echo: req };
  const plan = { status: "planned", dryRun: true, committed: false, identifier: req.identifier, tableIdentifier: req.tableIdentifier, revision: rev, tableDigest: dig, echo: req };
  switch (req.action) {
    case "read_tables":
      out({ status: "ok", identifier: req.identifier, revision: rev, deletedOrInTrash: false, sharedViaICloud: false, tableCount: 1,
        tables: [{ identifier: "${TABLE}", glyphCount: 1, orphan: false, digest: dig, readable: true, rowCount: 1, columnCount: 2,
          columnIdentifiers: ["${COL}", "C2"], rows: [{ identifier: "${ROW}", cells: ["a", "b"] }] }] });
    case "delete_table_row":
      if (req.dryRun) out({ ...plan, rowIdentifier: req.rowIdentifier, rowIndex: 1, rowCells: ["a", "b"], rowCountBefore: 4, columnCount: 2 });
      out(write);
    case "insert_table_row":
      out({ ...write, rowIdentifier: "NEW", rowIndex: 2 });
    case "set_table_cell":
      out({ ...write, previousText: "old" });
    case "prune_orphan_table":
      if (req.dryRun) out({ ...plan, glyphCount: 0, activeTableCountBefore: 2, readable: true });
      out({ status: "updated", dryRun: false, committed: true, verified: true, identifier: req.identifier, tableIdentifier: req.tableIdentifier, removedTableIdentifier: req.tableIdentifier, activeTableCountBefore: 2, activeTableCountAfter: 1, revisionBefore: req.ifRevision, revisionAfter: req.ifRevision, cloudSync, ...push, echo: req });
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
}
const ALLOW = { APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-writer-tables-"));
  installDir = join(root, "install");
  sourcePath = join(root, "writer.m");
  writeFileSync(sourcePath, "// fake\n");
  mkdirSync(installDir, { recursive: true });
  const binaryPath = join(installDir, WRITER_BINARY_NAME);
  writeFileSync(binaryPath, FAKE_WRITER);
  chmodSync(binaryPath, 0o755);
  writeFileSync(
    join(installDir, WRITER_MANIFEST_NAME),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: PRIVATE_WRITER_PROTOCOL,
      sourceSha256: sha256Hex("// fake\n"),
      binarySha256: sha256Hex(FAKE_WRITER),
      builtAt: "2026-09-23T00:00:00.000Z",
      osVersion: "27.2",
      compiler: "clang",
    })
  );
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

describe("switches", SPAWN_TIMEOUT, () => {
  it("refuses every table action without the write switch, reads included", () => {
    const off = { APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "" };
    expect(caught(() => readTables(NOTE, deps(off)))).toMatchObject({
      code: "writes_disabled",
      committed: undefined,
    });
    expect(
      caught(() =>
        deleteTableRow(
          { identifier: NOTE, tableIdentifier: TABLE, rowIdentifier: ROW, dryRun: true },
          deps(off)
        )
      )
    ).toMatchObject({ code: "writes_disabled", committed: undefined });
    expect(
      caught(() =>
        setTableCell(
          {
            identifier: NOTE,
            tableIdentifier: TABLE,
            rowIdentifier: ROW,
            columnIdentifier: COL,
            text: "x",
            ifRevision: REV,
            ifTableDigest: DIGEST,
          },
          deps({ ...off, ...ALLOW })
        )
      )
    ).toMatchObject({ code: "writes_disabled", committed: false });
  });
});

describe("readTables", SPAWN_TIMEOUT, () => {
  it("validates the note identifier and parses the tables", () => {
    expect(caught(() => readTables("nope", deps())).code).toBe("invalid_request");
    const r = readTables(NOTE, deps());
    expect(r.tables[0]).toMatchObject({ identifier: TABLE, orphan: false, rowCount: 1 });
  });

  it("rejects a malformed response as a read failure", () => {
    const e = caught(() => readTables(NOTE, deps({ FAKE_MODE: "malformed" })));
    expect(e).toMatchObject({ code: "invalid_response", committed: undefined });
  });
});

describe("deleteTableRow", SPAWN_TIMEOUT, () => {
  const base = { identifier: NOTE, tableIdentifier: TABLE, rowIdentifier: ROW };

  it("plans without the live-validation gate and sends no guards", () => {
    const plan = deleteTableRow({ ...base, dryRun: true }, deps());
    expect(plan).toMatchObject({ status: "planned", rowIndex: 1, rowCells: ["a", "b"] });
    expect(plan.echo).toEqual({ protocol: 1, action: "delete_table_row", ...base, dryRun: true });
  });

  it("refuses guards on a dry run and missing guards on an apply", () => {
    expect(
      caught(() => deleteTableRow({ ...base, dryRun: true, ifRevision: REV }, deps())).message
    ).toMatch(/only accepted with dryRun: false/);
    expect(caught(() => deleteTableRow({ ...base, dryRun: false }, deps())).message).toMatch(
      /ifRevision/
    );
    expect(
      caught(() => deleteTableRow({ ...base, dryRun: false, ifRevision: REV }, deps())).message
    ).toMatch(/ifTableDigest/);
  });

  it("validates identifiers before spawning", () => {
    for (const bad of [
      { ...base, tableIdentifier: "t" },
      { ...base, rowIdentifier: "r" },
      { ...base, identifier: "n" },
    ])
      expect(caught(() => deleteTableRow({ ...bad, dryRun: true }, deps())).code).toBe(
        "invalid_request"
      );
  });

  it("gates the apply until live validation", () => {
    expect(TABLE_WRITES_LIVE_VALIDATED).toBe(false);
    const e = caught(() =>
      deleteTableRow({ ...base, dryRun: false, ifRevision: REV, ifTableDigest: DIGEST }, deps())
    );
    expect(e).toMatchObject({ code: "not_live_validated", committed: false });
    expect(e.message).toMatch(/native-delete-table-row/);
  });

  it("applies with both guards and returns the verified result", () => {
    const r = deleteTableRow(
      { ...base, dryRun: false, ifRevision: REV, ifTableDigest: DIGEST },
      deps(ALLOW)
    );
    expect(r).toMatchObject({ committed: true, verified: true, rowCount: 3 });
    expect(r.echo).toMatchObject({ dryRun: false, ifRevision: REV, ifTableDigest: DIGEST });
  });

  it("treats a dry-run timeout as a failed read and an apply timeout as indeterminate", () => {
    const slow = { FAKE_MODE: "hang", APPLE_NOTES_MCP_PRIVATE_HELPER_TIMEOUT_MS: "300", ...ALLOW };
    const read = caught(() => deleteTableRow({ ...base, dryRun: true }, deps(slow)));
    expect(read).toMatchObject({ code: "timeout", committed: undefined });
    const write = caught(() =>
      deleteTableRow({ ...base, dryRun: false, ifRevision: REV, ifTableDigest: DIGEST }, deps(slow))
    );
    expect(write).toMatchObject({ code: "timeout", committed: "unknown" });
  });

  it("marks a malformed apply response indeterminate", () => {
    const e = caught(() =>
      deleteTableRow(
        { ...base, dryRun: false, ifRevision: REV, ifTableDigest: DIGEST },
        deps({ ...ALLOW, FAKE_MODE: "malformed" })
      )
    );
    expect(e).toMatchObject({ code: "invalid_response", committed: "unknown" });
  });
});

describe("insertTableRow and setTableCell", SPAWN_TIMEOUT, () => {
  const guards = { ifRevision: REV, ifTableDigest: DIGEST };

  it("inserts at the end or after a row, passing only the fields given", () => {
    const end = insertTableRow(
      { identifier: NOTE, tableIdentifier: TABLE, ...guards },
      deps(ALLOW)
    );
    expect(end.echo).toEqual({
      protocol: 1,
      action: "insert_table_row",
      identifier: NOTE,
      tableIdentifier: TABLE,
      ...guards,
    });
    const after = insertTableRow(
      {
        identifier: NOTE,
        tableIdentifier: TABLE,
        afterRowIdentifier: ROW,
        cells: ["x"],
        ...guards,
      },
      deps(ALLOW)
    );
    expect(after).toMatchObject({ rowIdentifier: "NEW", rowIndex: 2 });
    expect(after.echo).toMatchObject({ afterRowIdentifier: ROW, cells: ["x"] });
  });

  it("validates insert input and the gate before spawning", () => {
    const req = { identifier: NOTE, tableIdentifier: TABLE, ...guards };
    expect(caught(() => insertTableRow({ ...req, afterRowIdentifier: "x" }, deps())).code).toBe(
      "invalid_request"
    );
    expect(caught(() => insertTableRow({ ...req, cells: ["a\u0000"] }, deps())).code).toBe(
      "invalid_request"
    );
    expect(caught(() => insertTableRow({ ...req, ifTableDigest: "x" }, deps())).code).toBe(
      "invalid_request"
    );
    expect(caught(() => insertTableRow(req, deps())).code).toBe("not_live_validated");
  });

  it("sets one cell and returns the previous text", () => {
    const req = {
      identifier: NOTE,
      tableIdentifier: TABLE,
      rowIdentifier: ROW,
      columnIdentifier: COL,
      text: "",
      ...guards,
    };
    const r = setTableCell(req, deps(ALLOW));
    expect(r).toMatchObject({ previousText: "old", verified: true });
    expect(r.echo).toEqual({ protocol: 1, action: "set_table_cell", ...req });
    expect(caught(() => setTableCell({ ...req, columnIdentifier: "c" }, deps())).code).toBe(
      "invalid_request"
    );
    expect(caught(() => setTableCell({ ...req, text: "x".repeat(10_001) }, deps())).code).toBe(
      "invalid_request"
    );
    expect(caught(() => setTableCell(req, deps())).code).toBe("not_live_validated");
  });
});

describe("pruneOrphanTable", SPAWN_TIMEOUT, () => {
  const base = { identifier: NOTE, tableIdentifier: TABLE };

  it("plans, then applies with guards", () => {
    const plan = pruneOrphanTable({ ...base, dryRun: true }, deps());
    expect(plan).toMatchObject({ status: "planned", glyphCount: 0, activeTableCountBefore: 2 });
    const done = pruneOrphanTable(
      { ...base, dryRun: false, ifRevision: REV, ifTableDigest: DIGEST },
      deps(ALLOW)
    );
    expect(done).toMatchObject({ removedTableIdentifier: TABLE, activeTableCountAfter: 1 });
  });

  it("validates and gates the apply", () => {
    expect(
      caught(() => pruneOrphanTable({ ...base, tableIdentifier: "x", dryRun: true }, deps())).code
    ).toBe("invalid_request");
    expect(
      caught(() =>
        pruneOrphanTable({ ...base, dryRun: false, ifRevision: REV, ifTableDigest: DIGEST }, deps())
      ).code
    ).toBe("not_live_validated");
    expect(
      caught(() => pruneOrphanTable({ ...base, dryRun: true, ifTableDigest: DIGEST }, deps())).code
    ).toBe("invalid_request");
  });
});

describe("assertCellText", () => {
  it("accepts empty and multi-line cells", () => {
    expect(() => assertCellText("")).not.toThrow();
    expect(() => assertCellText("a\tb\nc é 🙂")).not.toThrow();
  });

  it.each([
    ["carriage return", "a\rb"],
    ["attachment glyph", "a\uFFFCb"],
    ["paragraph separator", "a\u2029b"],
    ["too long", "x".repeat(10_001)],
  ])("rejects %s", (_label, text) => {
    expect(() => assertCellText(text)).toThrow(PrivateWriteError);
  });
});
