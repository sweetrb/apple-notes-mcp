import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  read: vi.fn(),
  parse: vi.fn(),
}));
vi.mock(import("../services/backgroundNotes.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  mutateBackground: mocks.mutate,
  backgroundDependencies: vi.fn(() => ({})),
}));
vi.mock(import("../utils/noteRichText.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readRichNote: mocks.read,
}));
vi.mock(import("../utils/noteTables.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  parseNoteTable: mocks.parse,
}));
import { EMPTY_TABLE_ROWS, registerNativeOperations } from "./nativeOperations.js";

afterEach(() => vi.resetAllMocks());

const createTable = () => {
  const registerTool = vi.fn();
  registerNativeOperations({ registerTool } as unknown as McpServer, {} as AppleNotesManager);
  const call = registerTool.mock.calls.find((c) => c[0] === "create-table")!;
  return {
    schema: call[1].inputSchema as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } }
    >,
    handler: call[2] as (args: unknown) => Promise<{
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content: Array<{ text: string }>;
    }>,
  };
};

const args = {
  id: "x-coredata://ABC/ICNote/p1",
  expectedContentHash: `sha256:${"a".repeat(64)}`,
  scopeText: "existing phrase here",
};

describe("create-table without rows", () => {
  it("accepts an omitted rows argument", () => {
    const { schema } = createTable();
    expect(schema.rows.safeParse(undefined).success).toBe(true);
    expect(schema.rows.safeParse([]).success).toBe(false);
  });

  it("inserts and verifies an empty 2 x 2 table", async () => {
    mocks.read.mockReturnValueOnce({ nativeObjectIds: [] }).mockReturnValueOnce({
      nativeObjectIds: ["T"],
      objectData: [{ id: "T", type: "com.apple.notes.table", mergeable: "00" }],
    });
    mocks.mutate.mockReturnValue({ ok: true, id: args.id });
    mocks.parse.mockReturnValue({
      rows: [
        ["", ""],
        ["", ""],
      ],
      rowIds: [],
      columnIds: [],
    });
    const { handler } = createTable();
    const result = await handler(args);
    expect(result.isError).toBeUndefined();
    const [, operation, data] = mocks.mutate.mock.calls[0];
    expect(operation).toBe("append-html");
    expect(data.text).toBe(
      "<div><br></div><table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>"
    );
    expect(result.structuredContent).toMatchObject({ table: { id: "T", rows: EMPTY_TABLE_ROWS } });
  });

  it("still refuses ragged explicit rows", async () => {
    const { handler } = createTable();
    const result = await handler({ ...args, rows: [["a", "b"], ["c"]] });
    expect(result.content[0].text).toMatch(/equal cell counts/);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
