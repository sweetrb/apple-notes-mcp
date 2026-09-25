import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock(import("../services/privateWriterSmartFolders.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readSmartFolder: vi.fn(),
  createSmartFolder: vi.fn(),
  updateSmartFolder: vi.fn(),
  deleteSmartFolder: vi.fn(),
}));
import { PrivateWriteError } from "../services/privateWriter.js";
import {
  createSmartFolder,
  deleteSmartFolder,
  readSmartFolder,
  updateSmartFolder,
} from "../services/privateWriterSmartFolders.js";
import { registerPrivateWriterSmartFolderTools } from "./privateWriterSmartFolderTools.js";

const FOLDER = "E2729208-DF8F-44C9-B6D6-1E5D0D02B8C2";
const REV = `f1:${"a".repeat(64)}`;
const QUERY = { entity: "note", type: { checklist: true } };
const WRITER = { writer: true };

function fixture(nudge: Record<string, unknown> = {}) {
  const registerTool = vi.fn();
  registerPrivateWriterSmartFolderTools({ registerTool } as unknown as McpServer, () => ({
    writer: WRITER as never,
    nudge: nudge as never,
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const item = registerTool.mock.calls.find((c) => c[0] === name);
    if (!item) throw new Error(`missing ${name}`);
    return item[2](args);
  };
  const config = (name: string) => registerTool.mock.calls.find((c) => c[0] === name)?.[1];
  return { call, config, registerTool };
}

beforeEach(() => vi.clearAllMocks());

describe("smart folder writer tools", () => {
  it("registers four tools with honest annotations and the write gates", () => {
    const { config, registerTool } = fixture();
    expect(registerTool.mock.calls.map((c) => c[0])).toEqual([
      "native-read-smart-folder",
      "native-create-smart-folder",
      "native-update-smart-folder",
      "native-delete-smart-folder",
    ]);
    expect(config("native-read-smart-folder").annotations.readOnlyHint).toBe(true);
    expect(config("native-create-smart-folder").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(config("native-delete-smart-folder").annotations.destructiveHint).toBe(true);
    for (const name of [
      "native-create-smart-folder",
      "native-update-smart-folder",
      "native-delete-smart-folder",
    ]) {
      expect(config(name).description).toMatch(/APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES=1/);
      expect(config(name).description).toMatch(/APPLE_NOTES_MCP_ALLOW_UNVERIFIED=1/);
    }
    expect(config("native-create-smart-folder").description).toMatch(/smart_folder_destination/);
  });

  it("passes every request through with the writer deps", async () => {
    vi.mocked(readSmartFolder).mockReturnValue({ status: "ok" } as never);
    vi.mocked(createSmartFolder).mockReturnValue({ status: "created" } as never);
    vi.mocked(updateSmartFolder).mockReturnValue({ status: "updated" } as never);
    vi.mocked(deleteSmartFolder).mockReturnValue({ status: "planned" });
    const { call } = fixture();
    expect(
      (await call("native-read-smart-folder", { identifier: FOLDER })).structuredContent
    ).toEqual({ ok: true, status: "ok" });
    expect(readSmartFolder).toHaveBeenCalledWith(FOLDER, WRITER);
    await call("native-create-smart-folder", { title: "T", query: QUERY, account: "iCloud" });
    expect(createSmartFolder).toHaveBeenCalledWith(
      { title: "T", query: QUERY, account: "iCloud" },
      WRITER
    );
    await call("native-update-smart-folder", { identifier: FOLDER, query: QUERY, ifRevision: REV });
    expect(updateSmartFolder).toHaveBeenCalledWith(
      { identifier: FOLDER, query: QUERY, ifRevision: REV },
      WRITER
    );
    await call("native-delete-smart-folder", { identifier: FOLDER, dryRun: true });
    expect(deleteSmartFolder).toHaveBeenCalledWith({ identifier: FOLDER, dryRun: true }, WRITER);
  });

  it("passes the scope guard and asks a running Notes.app whether it shows a committed change", async () => {
    const F1 = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICFolder/p10298";
    const URI = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICFolder/p77";
    const scripts: string[] = [];
    let clock = 0;
    const nudge = {
      notesRunning: () => true,
      runAppleScript: (script: string) => {
        scripts.push(script);
        return { success: true, output: `${URI}\t1\tReading\n` };
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    };
    vi.mocked(createSmartFolder).mockReturnValue({
      status: "created",
      committed: true,
      identifier: FOLDER,
      objectURI: URI,
      title: "Reading",
      markedForDeletion: false,
    } as never);
    const { call } = fixture(nudge);
    const r = await call("native-create-smart-folder", {
      title: "Reading",
      query: QUERY,
      parentIdentifier: F1,
      ifFolderId: F1,
      adoptionWaitSeconds: 0,
    });
    expect(vi.mocked(createSmartFolder).mock.calls[0][0]).toMatchObject({
      scope: { ifFolderId: F1 },
    });
    expect(scripts).toHaveLength(1);
    expect(r.structuredContent).toMatchObject({
      ok: true,
      adoptedByNotesApp: true,
      adoption: { checked: true, expected: "visible", nameInNotesApp: "Reading" },
    });

    // A deleted smart folder is adopted once Notes.app stops showing it.
    vi.mocked(deleteSmartFolder).mockReturnValue({
      status: "deleted",
      committed: true,
      identifier: FOLDER,
      objectURI: URI,
      title: "Reading",
      markedForDeletion: true,
    });
    const deleted = await call("native-delete-smart-folder", {
      identifier: FOLDER,
      dryRun: false,
      ifRevision: REV,
      adoptionWaitSeconds: 0,
    });
    expect(deleted.structuredContent).toMatchObject({
      adoptedByNotesApp: false,
      adoption: { expected: "absent", reason: "still_visible" },
    });

    // Nothing committed (a no-op or a dry run): no AppleScript at all.
    vi.mocked(updateSmartFolder).mockReturnValue({ status: "ok", committed: false } as never);
    const noop = await call("native-update-smart-folder", {
      identifier: FOLDER,
      query: QUERY,
      ifRevision: REV,
    });
    expect(scripts).toHaveLength(2);
    expect(noop.structuredContent).not.toHaveProperty("adoptedByNotesApp");
  });

  it("reports the smart-folder destination refusal like the destination guard", async () => {
    vi.mocked(createSmartFolder).mockImplementation(() => {
      throw new PrivateWriteError("unsupported_folder", "smart parent", false, {
        reason: "smart_folder_destination",
      });
    });
    const r = await fixture().call("native-create-smart-folder", {
      title: "T",
      query: QUERY,
      parentIdentifier: FOLDER,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "unsupported",
      helperCode: "unsupported_folder",
      committed: false,
      indeterminate: false,
      reason: "smart_folder_destination",
    });
  });

  it("maps query and title refusals onto the shared vocabulary", async () => {
    const cases: Array<[string, string]> = [
      ["invalid_query", "validation_error"],
      ["query_not_representable", "unsupported"],
      ["tag_not_found", "not_found"],
      ["folder_exists", "validation_error"],
    ];
    for (const [helperCode, code] of cases) {
      vi.mocked(createSmartFolder).mockImplementationOnce(() => {
        throw new PrivateWriteError(helperCode, "no", false);
      });
      const r = await fixture().call("native-create-smart-folder", { title: "T", query: QUERY });
      expect(r.structuredContent).toMatchObject({ code, helperCode, committed: false });
    }
  });

  it("declares strict input schemas", () => {
    const { config } = fixture();
    const del = config("native-delete-smart-folder").inputSchema;
    expect(del.identifier.safeParse("DefaultFolder-CloudKit").success).toBe(false);
    expect(del.ifRevision.safeParse(`r1:${"a".repeat(64)}`).success).toBe(false);
    expect(del.dryRun.safeParse("yes").success).toBe(false);
    const create = config("native-create-smart-folder").inputSchema;
    expect(create.query.safeParse(QUERY).success).toBe(true);
    expect(create.query.safeParse("{}").success).toBe(true);
    expect(create.query.safeParse(3).success).toBe(false);
    expect(create.title.safeParse("x".repeat(257)).success).toBe(false);
  });

  it("uses the real writer dependencies when none are injected", async () => {
    vi.mocked(readSmartFolder).mockReturnValue({} as never);
    const registerTool = vi.fn();
    registerPrivateWriterSmartFolderTools({ registerTool } as unknown as McpServer);
    await registerTool.mock.calls.find((c) => c[0] === "native-read-smart-folder")![2]({
      identifier: FOLDER,
    });
    const deps = vi.mocked(readSmartFolder).mock.calls[0][1]!;
    expect(deps.sourcePath).toMatch(/apple-notes-private-writer\.m$/);
  });
});
