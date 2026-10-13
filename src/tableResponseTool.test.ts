/** Drive the registered get-note-tables handler; no Notes or native calls run. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import type { NoteTable, NoteTablesResult } from "@/types.js";
import {
  tablePageResponse,
  MAX_TABLE_RESPONSE_BYTES,
  MIN_TABLE_RESPONSE_BYTES,
  MAX_TABLES_PER_PAGE,
} from "@/services/tableResponse.js";
import { withStructuredText, STRUCTURED_TEXT_PREFIX } from "@/utils/structuredText.js";

interface ToolConfig {
  inputSchema: Record<string, ZodTypeAny>;
  outputSchema?: ZodTypeAny;
  annotations?: { readOnlyHint?: boolean };
  description?: string;
}
interface Response {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
const registered = vi.hoisted(
  () =>
    new Map<
      string,
      {
        config: ToolConfig;
        handler: (args: Record<string, unknown>) => Promise<Response>;
      }
    >()
);
const manager = vi.hoisted(() => ({
  getNoteTablesById: vi.fn(),
  getNoteById: vi.fn(),
  getNoteContentById: vi.fn(),
  readNoteBodyById: vi.fn(),
}));
const getNoteMetadata = vi.hoisted(() => vi.fn());
const readRichNote = vi.hoisted(() => vi.fn());

vi.mock(import("@modelcontextprotocol/sdk/server/mcp.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn(
        (
          name: string,
          config: ToolConfig,
          handler: (args: Record<string, unknown>) => Promise<Response>
        ) => {
          registered.set(name, { config, handler });
        }
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
vi.mock(import("@/services/appleNotesManager.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  AppleNotesManager: vi.fn().mockImplementation(function () {
    return manager;
  }) as never,
}));
vi.mock("@/utils/noteMetadata.js", () => ({ getNoteMetadata }));
vi.mock(import("@/utils/noteRichText.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readRichNote,
}));

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p10";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const tool = () => registered.get("get-note-tables")!;
const call = (args: Record<string, unknown>) => tool().handler(args);
const mirrored = (response: Response) => {
  const line = response.content.find((item) => item.text.startsWith(STRUCTURED_TEXT_PREFIX));
  if (!line) throw new Error("Structured fields missing from text response");
  return JSON.parse(line.text.slice(STRUCTURED_TEXT_PREFIX.length)) as Record<string, unknown>;
};

function table(index: number, text = `body ${index}`): NoteTable {
  return {
    index,
    id: `table-${index}`,
    attachmentId: `x-coredata://ABC/ICAttachment/p${index}`,
    complete: true,
    rows: [["Column"], [text]],
    rowIds: [`header-${index}`, `body-${index}`],
    columnIds: [`column-${index}`],
    rowCount: 2,
    columnCount: 1,
    markdown: `| Column |\n| --- |\n| ${text} |`,
  };
}
const result = (tables: NoteTable[]): NoteTablesResult => ({
  tables,
  tableCellsComplete: tables.every((item) => item.complete),
  markdown: tables.map((item) => item.markdown ?? "").join("\n\n"),
});

beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  try {
    await import("@/index.js");
  } finally {
    on.mockRestore();
    stdinOn.mockRestore();
  }
}, 30000);
afterAll(() => registered.clear());
beforeEach(() => {
  vi.resetAllMocks();
  getNoteMetadata.mockReturnValue({ metadata: { passwordProtected: false } });
  manager.getNoteTablesById.mockReturnValue(result([]));
});

describe("get-note-tables registration", () => {
  it("advertises read-only paging and validates integer bounds in its actual schema", () => {
    const { config } = tool();
    expect(config.annotations).toEqual({ readOnlyHint: true });
    expect(config.description).toContain("serialized tool response");
    expect(config.description).toContain("page.nextOffset");
    for (const field of ["offset", "limit", "maxBytes"])
      expect(config.inputSchema[field].safeParse(undefined).success).toBe(true);
    expect(config.inputSchema.offset.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(config.inputSchema.limit.safeParse(MAX_TABLES_PER_PAGE).success).toBe(true);
    expect(config.inputSchema.maxBytes.safeParse(MIN_TABLE_RESPONSE_BYTES).success).toBe(true);
    expect(config.inputSchema.maxBytes.safeParse(MAX_TABLE_RESPONSE_BYTES).success).toBe(true);
    for (const [field, value] of [
      ["offset", -1],
      ["offset", 0.5],
      ["offset", Number.MAX_SAFE_INTEGER + 1],
      ["limit", 0],
      ["limit", 1.5],
      ["limit", MAX_TABLES_PER_PAGE + 1],
      ["maxBytes", MIN_TABLE_RESPONSE_BYTES - 1],
      ["maxBytes", MIN_TABLE_RESPONSE_BYTES + 0.5],
      ["maxBytes", MAX_TABLE_RESPONSE_BYTES + 1],
    ] as const)
      expect(config.inputSchema[field].safeParse(value).success).toBe(false);
    expect(getNoteMetadata).not.toHaveBeenCalled();
    expect(manager.getNoteTablesById).not.toHaveBeenCalled();
  });

  it.each([
    { offset: -1 },
    { offset: 0.1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: NaN },
    { limit: 0 },
    { limit: 2.5 },
    { limit: MAX_TABLES_PER_PAGE + 1 },
    { maxBytes: MIN_TABLE_RESPONSE_BYTES - 1 },
    { maxBytes: 2048.5 },
    { maxBytes: MAX_TABLE_RESPONSE_BYTES + 1 },
    { maxBytes: Infinity },
  ])(
    "validates handler options before any metadata or table database access: %j",
    async (options) => {
      const response = await call({ id: ID, ...options });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual({ code: "validation_error" });
      expect(mirrored(response)).toEqual(response.structuredContent);
      expect(getNoteMetadata).not.toHaveBeenCalled();
      expect(manager.getNoteTablesById).not.toHaveBeenCalled();
      expect(readRichNote).not.toHaveBeenCalled();
      expect(manager.getNoteById).not.toHaveBeenCalled();
    }
  );
});

describe("get-note-tables final registered response", () => {
  it("bounds the payload after the global structured-text wrapper at an exact Unicode/JSON boundary", async () => {
    const special = table(1, '"\\\n\t🧭漢'.repeat(80));
    const input = result([special]);
    manager.getNoteTablesById.mockReturnValue(input);
    const base = tablePageResponse(ID, input, { maxBytes: MAX_TABLE_RESPONSE_BYTES });
    let maxBytes = bytes(withStructuredText(base));
    for (let attempt = 0; attempt < 10; attempt++) {
      base.structuredContent.page.maxBytes = maxBytes;
      const measured = bytes(withStructuredText(base));
      if (measured === maxBytes) break;
      maxBytes = measured;
    }

    const response = await call({ id: ID, maxBytes });
    expect(response.isError).toBeFalsy();
    expect(bytes(response)).toBe(maxBytes);
    expect(response.structuredContent).toMatchObject({
      id: ID,
      tables: [special],
      tableCount: 1,
      page: { maxBytes, returned: 1, hasMore: false, stoppedAtSizeLimit: false },
    });
    expect(response.content).toHaveLength(2);
    expect(mirrored(response).page).toEqual(response.structuredContent?.page);
    expect(configOutputValid(response)).toBe(true);
    expect(getNoteMetadata).toHaveBeenCalledExactlyOnceWith(ID);
    expect(manager.getNoteTablesById).toHaveBeenCalledExactlyOnceWith(ID);
    expect(readRichNote).not.toHaveBeenCalled();
    expect(manager.getNoteById).not.toHaveBeenCalled();
    expect(manager.getNoteContentById).not.toHaveBeenCalled();
    expect(manager.readNoteBodyById).not.toHaveBeenCalled();

    const smaller = await call({ id: ID, maxBytes: maxBytes - 1 });
    expect(smaller.isError).toBeFalsy();
    expect(bytes(smaller)).toBeLessThanOrEqual(maxBytes - 1);
    expect(smaller.structuredContent).toMatchObject({
      tables: [{ id: special.id, complete: false, contentOmitted: true }],
    });
  });

  it("carries the next offset in text and returns the original nullable cell and stable IDs", async () => {
    const first = table(1);
    first.complete = false;
    first.rows![1][0] = null;
    first.reason = "Cell could not be decoded";
    first.incompleteCells = [{ row: 1, column: 0, reason: first.reason }];
    first.markdown = "| Column |\n| --- |\n| [undecoded cell] |";
    const input = result([first, table(2)]);
    const before = structuredClone(input);
    manager.getNoteTablesById.mockReturnValue(input);
    const response = await call({ id: ID, limit: 1, maxBytes: 4096 });
    expect(bytes(response)).toBeLessThanOrEqual(4096);
    expect(response.structuredContent).toMatchObject({
      tables: [first],
      tableCount: 2,
      tableCellsComplete: false,
      page: { returned: 1, nextOffset: 1, hasMore: true, stoppedAtSizeLimit: false },
    });
    expect(mirrored(response)).toMatchObject({
      tables: [{ rows: [["Column"], [null]], rowIds: first.rowIds, columnIds: first.columnIds }],
      page: { nextOffset: 1 },
    });
    expect(response.content[0].text).toContain("offset 1");
    const resumed = await call({ id: ID, offset: 1, limit: 1, maxBytes: 4096 });
    expect(resumed.structuredContent).toMatchObject({
      tables: [before.tables[1]],
      page: { offset: 1, returned: 1, hasMore: false },
    });
    expect(resumed.structuredContent?.page).not.toHaveProperty("nextOffset");
    expect(input).toEqual(before);
  });

  it("turns oversized metadata into a bounded coded error without echoing it", async () => {
    const oversized = table(1, "cell".repeat(5000));
    oversized.id = "metadata-🧭".repeat(1000);
    manager.getNoteTablesById.mockReturnValue(result([oversized]));
    const response = await call({ id: ID, maxBytes: 4096 });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({ code: "validation_error" });
    expect(bytes(response)).toBeLessThanOrEqual(4096);
    expect(response.content[0].text).toMatch(/metadata.*response limit/i);
    expect(JSON.stringify(response)).not.toContain(oversized.id);
    expect(configOutputValid(response)).toBe(true);
  });
});

function configOutputValid(response: Response): boolean {
  return tool().config.outputSchema!.safeParse(response.structuredContent).success;
}

describe("get-note-tables existing metadata refusals", () => {
  it.each([
    ["not_found", `No note found in the database for ID "${ID}".`, "not_found"],
    ["no_fda", "Full Disk Access is required to read note metadata.", "full_disk_access_missing"],
    ["invalid_id", `Invalid note ID format: "${ID}".`, "validation_error"],
    ["query_error", "Failed to read note metadata.", "operation_failed"],
  ])("keeps %s metadata classification and message", async (error, message, code) => {
    getNoteMetadata.mockReturnValue({ metadata: null, error, message });
    const response = await call({ id: ID, limit: 1, maxBytes: 4096 });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe(message);
    expect(response.structuredContent).toEqual({ code });
    expect(manager.getNoteTablesById).not.toHaveBeenCalled();
    expect(readRichNote).not.toHaveBeenCalled();
    expect(manager.getNoteById).not.toHaveBeenCalled();
  });

  it("refuses password-protected tables before any body decoding", async () => {
    getNoteMetadata.mockReturnValue({ metadata: { passwordProtected: true } });
    const response = await call({ id: ID });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({ code: "unsupported" });
    expect(response.content[0].text).toBe(
      `Note "${ID}" is password-protected; its tables are encrypted. Unlock it in Notes.app first.`
    );
    expect(manager.getNoteTablesById).not.toHaveBeenCalled();
    expect(readRichNote).not.toHaveBeenCalled();
    expect(manager.getNoteById).not.toHaveBeenCalled();
  });
});
