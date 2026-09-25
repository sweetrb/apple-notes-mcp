import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

vi.mock(import("../services/privateWriterTables.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readTables: vi.fn(),
  deleteTableRow: vi.fn(),
  insertTableRow: vi.fn(),
  setTableCell: vi.fn(),
  pruneOrphanTable: vi.fn(),
}));
vi.mock(import("../services/privateSyncNudge.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeInPlace: vi.fn(),
}));
import { nudgeInPlace } from "../services/privateSyncNudge.js";
import { PrivateWriteError } from "../services/privateWriter.js";
import {
  deleteTableRow,
  insertTableRow,
  pruneOrphanTable,
  readTables,
  setTableCell,
} from "../services/privateWriterTables.js";
import { registerPrivateWriterTableTools } from "./privateWriterTableTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const TABLE = "060A37B0-CAD4-4A4F-A55D-265099370F9F";
const ROW = "62A0F5AC-4A7A-4877-A6B8-FAE726CC052F";
const COL = "8FA6AAE5-4811-45DF-9900-44DAB38A614A";
const REV = `r1:${"a".repeat(64)}`;
const DIGEST = `t1:${"b".repeat(64)}`;
const CD = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICNote/p11331";
const WRITER = { writer: true };
const NUDGE = { nudge: true };

function fixture() {
  const registerTool = vi.fn();
  const manager = {
    getNoteLinkById: vi.fn(() => `notes://showNote?identifier=${NOTE}`),
  } as unknown as AppleNotesManager;
  registerPrivateWriterTableTools({ registerTool } as unknown as McpServer, manager, () => ({
    writer: WRITER as never,
    nudge: NUDGE as never,
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const item = registerTool.mock.calls.find((c) => c[0] === name);
    if (!item) throw new Error(`missing ${name}`);
    return item[2](args);
  };
  const config = (name: string) => registerTool.mock.calls.find((c) => c[0] === name)?.[1];
  return { call, config, registerTool, manager };
}

beforeEach(() => vi.clearAllMocks());

describe("native table writer tools", () => {
  it("registers five tools with honest annotations and the write gates", () => {
    const { config, registerTool } = fixture();
    expect(registerTool.mock.calls.map((c) => c[0])).toEqual([
      "native-read-tables",
      "native-delete-table-row",
      "native-insert-table-row",
      "native-set-table-cell",
      "native-prune-orphan-table",
    ]);
    expect(config("native-read-tables").annotations.readOnlyHint).toBe(true);
    expect(config("native-delete-table-row").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(config("native-prune-orphan-table").annotations.destructiveHint).toBe(true);
    expect(config("native-insert-table-row").annotations.destructiveHint).toBe(false);
    for (const name of [
      "native-delete-table-row",
      "native-insert-table-row",
      "native-set-table-cell",
      "native-prune-orphan-table",
    ]) {
      expect(config(name).description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
      expect(config(name).description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
    }
    expect(config("native-set-table-cell").description).toMatch(/Safety:.*ifTableDigest/s);
  });

  it("reads tables by identifier or x-coredata id through the writer deps", async () => {
    vi.mocked(readTables).mockReturnValue({ tableCount: 0 } as never);
    const { call, manager } = fixture();
    const r = await call("native-read-tables", { id: CD });
    expect(manager.getNoteLinkById).toHaveBeenCalledWith(CD);
    expect(readTables).toHaveBeenCalledWith(NOTE, WRITER);
    expect(r.structuredContent).toEqual({ ok: true, tableCount: 0 });
  });

  it("passes delete and prune requests through unchanged", async () => {
    vi.mocked(deleteTableRow).mockReturnValue({ status: "planned", committed: false });
    vi.mocked(pruneOrphanTable).mockReturnValue({ status: "planned", committed: false });
    const { call } = fixture();
    await call("native-delete-table-row", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      rowIdentifier: ROW,
      dryRun: false,
      ifRevision: REV,
      ifTableDigest: DIGEST,
    });
    expect(deleteTableRow).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        tableIdentifier: TABLE,
        rowIdentifier: ROW,
        dryRun: false,
        ifRevision: REV,
        ifTableDigest: DIGEST,
      },
      WRITER
    );
    await call("native-prune-orphan-table", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      dryRun: true,
      nudge: true,
    });
    expect(pruneOrphanTable).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        tableIdentifier: TABLE,
        dryRun: true,
        ifRevision: undefined,
        ifTableDigest: undefined,
      },
      WRITER
    );
    // A dry run never nudges, even when asked.
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("passes insert and cell edits through unchanged", async () => {
    vi.mocked(insertTableRow).mockReturnValue({ rowIdentifier: ROW } as never);
    vi.mocked(setTableCell).mockReturnValue({ previousText: "" } as never);
    const { call } = fixture();
    const inserted = await call("native-insert-table-row", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      afterRowIdentifier: ROW,
      cells: ["a"],
      ifRevision: REV,
      ifTableDigest: DIGEST,
    });
    expect(inserted.structuredContent).toEqual({ ok: true, rowIdentifier: ROW });
    expect(insertTableRow).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        tableIdentifier: TABLE,
        afterRowIdentifier: ROW,
        cells: ["a"],
        ifRevision: REV,
        ifTableDigest: DIGEST,
      },
      WRITER
    );
    await call("native-set-table-cell", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      rowIdentifier: ROW,
      columnIdentifier: COL,
      text: "b",
      ifRevision: REV,
      ifTableDigest: DIGEST,
    });
    expect(setTableCell).toHaveBeenCalledWith(
      {
        identifier: NOTE,
        tableIdentifier: TABLE,
        rowIdentifier: ROW,
        columnIdentifier: COL,
        text: "b",
        ifRevision: REV,
        ifTableDigest: DIGEST,
      },
      WRITER
    );
    expect(nudgeInPlace).not.toHaveBeenCalled();
  });

  it("nudges the note after a committed apply when asked", async () => {
    vi.mocked(setTableCell).mockReturnValue({ committed: true, verified: true } as never);
    vi.mocked(nudgeInPlace).mockResolvedValueOnce({
      allUploadsRecorded: false,
      targets: [],
      before: {},
      after: {},
    } as never);
    const r = await fixture().call("native-set-table-cell", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      rowIdentifier: ROW,
      columnIdentifier: COL,
      text: "b",
      ifRevision: REV,
      ifTableDigest: DIGEST,
      nudge: true,
      nudgeWaitSeconds: 3,
    });
    expect(vi.mocked(nudgeInPlace).mock.calls[0]).toEqual([
      { identifiers: [NOTE], waitSeconds: 3 },
      NUDGE,
    ]);
    expect(r.structuredContent).toMatchObject({
      committed: true,
      sync: { ok: true, allUploadsRecorded: false },
    });
  });

  it("reports writer errors with the shared code and committed state", async () => {
    vi.mocked(deleteTableRow).mockImplementation(() => {
      throw new PrivateWriteError("attachment_conflict", "changed", false, {
        currentTableDigest: DIGEST,
      });
    });
    const r = await fixture().call("native-delete-table-row", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      rowIdentifier: ROW,
      dryRun: false,
      ifRevision: REV,
      ifTableDigest: DIGEST,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "revision_conflict",
      helperCode: "attachment_conflict",
      committed: false,
      indeterminate: false,
      currentTableDigest: DIGEST,
    });
    vi.mocked(insertTableRow).mockImplementation(() => {
      throw new PrivateWriteError("timeout", "slow", "unknown");
    });
    const slow = await fixture().call("native-insert-table-row", {
      identifier: NOTE,
      tableIdentifier: TABLE,
      ifRevision: REV,
      ifTableDigest: DIGEST,
    });
    expect(slow.structuredContent).toMatchObject({
      code: "timeout_indeterminate",
      indeterminate: true,
    });
  });

  it("declares strict input schemas", () => {
    const { config } = fixture();
    const del = config("native-delete-table-row").inputSchema;
    expect(del.rowIdentifier.safeParse("row-1").success).toBe(false);
    expect(del.ifTableDigest.safeParse(REV).success).toBe(false);
    expect(del.dryRun.safeParse("yes").success).toBe(false);
    const cell = config("native-set-table-cell").inputSchema;
    expect(cell.text.safeParse("x".repeat(10_001)).success).toBe(false);
    expect(cell.text.safeParse("").success).toBe(true);
    expect(cell.nudgeWaitSeconds.safeParse(181).success).toBe(false);
  });

  it("uses the real writer dependencies when none are injected", async () => {
    vi.mocked(readTables).mockReturnValue({} as never);
    const registerTool = vi.fn();
    registerPrivateWriterTableTools(
      { registerTool } as unknown as McpServer,
      {} as AppleNotesManager
    );
    await registerTool.mock.calls.find((c) => c[0] === "native-read-tables")![2]({
      identifier: NOTE,
    });
    const deps = vi.mocked(readTables).mock.calls[0][1]!;
    expect(deps.sourcePath).toMatch(/apple-notes-private-writer\.m$/);
  });
});
