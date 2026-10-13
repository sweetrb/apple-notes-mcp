/** Exercises the actual registered tool callback and shared folder schemas. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scopeConflictMessage } from "@/utils/scopeGuard.js";

type Response = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Config = { inputSchema: Record<string, z.ZodTypeAny>; description: string };
type Callback = (args: unknown) => Promise<Response>;
const registered = vi.hoisted(() => new Map<string, { config: Config; cb: Callback }>());
const manager = vi.hoisted(() => ({ batchMoveNotes: vi.fn() }));

vi.mock(import("@modelcontextprotocol/sdk/server/mcp.js"), async (original) => ({
  ...(await original()),
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn((name: string, config: Config, cb: Callback) =>
        registered.set(name, { config, cb })
      ),
      resource: vi.fn(),
      prompt: vi.fn(),
      connect: vi.fn(async () => undefined),
    };
  }) as never,
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));
vi.mock("@/utils/jsonSchemaDialect.js", () => ({ withJsonSchema2020_12: (t: unknown) => t }));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock(import("@/services/appleNotesManager.js"), async (original) => ({
  ...(await original()),
  AppleNotesManager: vi.fn().mockImplementation(function () {
    return manager;
  }) as never,
}));

const STORE = "x-coredata://ABC00000-0000-0000-0000-000000000004";
const ID1 = `${STORE}/ICNote/p1`;
const ID2 = `${STORE}/ICNote/p2`;
const F1 = `${STORE}/ICFolder/p10`;
const F2 = `${STORE}/ICFolder/p20`;
const guardNames = ["ifFolderId", "ifAncestorFolderId", "forbiddenAncestorFolderIds"] as const;
const tool = () => registered.get("batch-move-notes")!;
const call = async (args: Record<string, unknown>) => {
  const parsed = z.object(tool().config.inputSchema).parse(args);
  return tool().cb(parsed);
};

beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  await import("@/index.js");
  on.mockRestore();
  stdinOn.mockRestore();
}, 30000);
afterAll(() => registered.clear());
beforeEach(() => {
  vi.clearAllMocks();
  manager.batchMoveNotes.mockReturnValue([{ id: ID1, success: true }]);
});

describe("registered batch-move-notes scope contract", () => {
  it("shares the single-note folder schemas, including alternate-ID resolution", () => {
    for (const name of guardNames) {
      expect(tool().config.inputSchema[name]).toBe(
        registered.get("move-note")!.config.inputSchema[name]
      );
    }
    expect(tool().config.description).toMatch(/every note.*same AppleScript/);
  });

  it.each([
    { ifFolderId: F1 },
    { ifAncestorFolderId: F1 },
    { forbiddenAncestorFolderIds: [F2] },
    { ifFolderId: F1, ifAncestorFolderId: F1, forbiddenAncestorFolderIds: [F2] },
  ])("passes shared guards to the manager with the batch and account intact: %j", async (guard) => {
    const response = await call({ ids: [ID1], folder: "Archive", account: "Work", ...guard });
    expect(manager.batchMoveNotes).toHaveBeenCalledWith(
      [ID1],
      "Archive",
      "Work",
      expect.objectContaining(guard)
    );
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
  });

  it("keeps mixed refusal and success rows in the original order", async () => {
    const rows = [
      {
        id: ID1,
        success: false,
        error: scopeConflictMessage("the note is not in the expected folder", "batch-move"),
        committed: false,
        indeterminate: false,
      },
      { id: ID2, success: true },
    ];
    manager.batchMoveNotes.mockReturnValue(rows);
    const response = await call({ ids: [ID1, ID2], folder: "Archive", ifFolderId: F1 });
    expect(response.structuredContent).toMatchObject({
      ok: false,
      succeeded: 1,
      failed: 1,
      results: rows,
    });
    expect(response.content[0].text).toContain(`${ID1}: Scope guard failed:`);
    expect(response.isError).toBeUndefined();
  });

  it("reports all-note scope refusals as the existing batch error result", async () => {
    manager.batchMoveNotes.mockReturnValue([
      {
        id: ID1,
        success: false,
        error: scopeConflictMessage("the destination is inside a forbidden folder", "batch-move"),
        committed: false,
        indeterminate: false,
      },
    ]);
    const response = await call({
      ids: [ID1],
      folder: "Archive",
      forbiddenAncestorFolderIds: [F2],
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("0 succeeded, 1 failed");
    expect(response.content[0].text).toContain(`${ID1}: Scope guard failed: the destination`);
    expect(response.structuredContent).toMatchObject({
      code: "revision_conflict",
      committed: false,
      indeterminate: false,
    });
  });

  it.each(["Destination folder verification failed", "Move failed", "Unknown error"])(
    "keeps scope refusal plus a post-move/unknown failure uncertain: %s",
    async (error) => {
      manager.batchMoveNotes.mockReturnValue([
        {
          id: ID1,
          success: false,
          error: scopeConflictMessage("the note is not in the expected folder", "batch-move"),
          committed: false,
          indeterminate: false,
        },
        { id: ID2, success: false, error, indeterminate: true },
      ]);
      const response = await call({ ids: [ID1, ID2], folder: "Archive", ifFolderId: F1 });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        code: "verification_failed",
        indeterminate: true,
      });
      expect(response.structuredContent).not.toHaveProperty("committed");
      expect(response.content[0].text).toContain(`${ID1}: Scope guard failed:`);
      expect(response.content[0].text).toContain(`${ID2}: ${error}`);
      expect(response.content[0].text).toContain("Batch move outcome is uncertain");
      expect(response.content[0].text).not.toContain("Nothing was changed");
    }
  );

  it("keeps a batch of only proven prewrite refusals uncommitted", async () => {
    manager.batchMoveNotes.mockReturnValue([
      { id: ID1, success: false, error: "Note not found", committed: false, indeterminate: false },
      {
        id: ID2,
        success: false,
        error: "Note is password-protected",
        committed: false,
        indeterminate: false,
      },
    ]);
    const response = await call({ ids: [ID1, ID2], folder: "Archive" });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      code: "not_found",
      committed: false,
      indeterminate: false,
    });
    expect(response.content[0].text).not.toContain("outcome is uncertain");
  });

  it("does not promote whole-script scope prose to an uncommitted batch", async () => {
    manager.batchMoveNotes.mockReturnValue([
      {
        id: ID1,
        success: false,
        error: "Scope guard failed: a reported script error",
        indeterminate: true,
      },
      {
        id: ID2,
        success: false,
        error: "Scope guard failed: a reported script error",
        indeterminate: true,
      },
    ]);
    const response = await call({ ids: [ID1, ID2], folder: "Archive" });
    expect(response.structuredContent).toMatchObject({
      code: "verification_failed",
      indeterminate: true,
    });
    expect(response.structuredContent).not.toHaveProperty("committed");
  });

  it("refuses to infer certainty when manager rows lack outcome metadata", async () => {
    manager.batchMoveNotes.mockReturnValue([{ id: ID1, success: false, error: "Note not found" }]);
    const response = await call({ ids: [ID1], folder: "Archive" });
    expect(response.structuredContent).toMatchObject({ indeterminate: true });
    expect(response.structuredContent).not.toHaveProperty("committed");
  });

  it("does not claim a complete prewrite refusal from an incomplete result list", async () => {
    manager.batchMoveNotes.mockReturnValue([
      { id: ID1, success: false, error: "Note not found", committed: false, indeterminate: false },
    ]);
    const response = await call({ ids: [ID1, ID2], folder: "Archive" });
    expect(response.structuredContent).toMatchObject({ indeterminate: true });
    expect(response.structuredContent).not.toHaveProperty("committed");
  });

  it("preserves unguarded calls and empty forbidden lists", async () => {
    await call({ ids: [ID1], folder: "Archive" });
    expect(manager.batchMoveNotes).toHaveBeenCalledWith([ID1], "Archive", undefined, {
      ifFolderId: undefined,
      ifAncestorFolderId: undefined,
      forbiddenAncestorFolderIds: undefined,
    });
    await call({ ids: [ID1], folder: "Archive", forbiddenAncestorFolderIds: [] });
    expect(manager.batchMoveNotes).toHaveBeenLastCalledWith(
      [ID1],
      "Archive",
      undefined,
      expect.objectContaining({ forbiddenAncestorFolderIds: [] })
    );
  });

  it.each([
    { ifFolderId: ID1 },
    { ifAncestorFolderId: 'x" & quit & "' },
    { forbiddenAncestorFolderIds: [ID1] },
    { forbiddenAncestorFolderIds: Array.from({ length: 51 }, () => F1) },
  ])("rejects invalid scope schemas before calling the manager: %j", async (guard) => {
    await expect(call({ ids: [ID1], folder: "Archive", ...guard })).rejects.toThrow();
    expect(manager.batchMoveNotes).not.toHaveBeenCalled();
  });

  it("still enforces the batch size and exact note-ID schema", async () => {
    await expect(
      call({ ids: Array.from({ length: 501 }, () => ID1), folder: "Archive", ifFolderId: F1 })
    ).rejects.toThrow();
    await expect(call({ ids: [F1], folder: "Archive", ifFolderId: F1 })).rejects.toThrow();
    expect(manager.batchMoveNotes).not.toHaveBeenCalled();
  });

  it("does not call the manager for an empty batch", async () => {
    const response = await call({ ids: [], folder: "Archive", ifFolderId: F1 });
    expect(response.isError).toBe(true);
    expect(manager.batchMoveNotes).not.toHaveBeenCalled();
  });
});
