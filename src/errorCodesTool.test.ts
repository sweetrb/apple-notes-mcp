/**
 * Error codes through the real tool wrappers: tools registered by src/index.ts
 * (withErrorHandling and direct errorResponse returns) and by the native tool
 * modules, driven through their registered callbacks with a mocked manager.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const manager = vi.hoisted(() => {
  const m = {
    getNoteById: vi.fn(),
    readNoteById: vi.fn(),
    getNoteLinkById: vi.fn(),
    getNoteDetails: vi.fn(),
    getNoteLink: vi.fn(),
    getNoteContentById: vi.fn(),
    listAccounts: vi.fn(),
    getFolderById: vi.fn(),
    // readNoteBodyById is the error-keeping form of getNoteContentById (#237).
    readNoteBodyById: vi.fn((id: string) => ({ body: m.getNoteContentById(id) ?? "" })),
  };
  return m;
});

vi.mock(import("@modelcontextprotocol/sdk/server/mcp.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn(
        (name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) =>
          registered.set(name, cb)
      ),
      resource: vi.fn(),
      prompt: vi.fn(),
      connect: vi.fn(async () => undefined),
    };
  }) as never,
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));
vi.mock("@/utils/jsonSchemaDialect.js", () => ({ withJsonSchema2020_12: (t: unknown) => t }));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock(import("@/services/appleNotesManager.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  AppleNotesManager: vi.fn().mockImplementation(function () {
    return manager;
  }) as never,
}));

type Response = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const call = (name: string, args: Record<string, unknown>) =>
  registered.get(name)!(args) as Promise<Response>;
/** The text blocks of an error result: its own text, then the mirrored envelope (#264). */
const errorText = (text: string, envelope: Record<string, unknown>) => [
  { type: "text", text },
  { type: "text", text: `structuredContent: ${JSON.stringify(envelope)}` },
];
const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p999999";

beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  await import("@/index.js");
  on.mockRestore();
  stdinOn.mockRestore();
});
afterAll(() => registered.clear());
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.resetAllMocks());

describe("error codes through tool wrappers", () => {
  it.each([
    ["direct", "id"],
    ["direct", "title"],
    ["brokered", "id"],
    ["brokered", "title"],
  ])("names the FDA grant target in %s get-note-link failures by %s", async (mode, lookup) => {
    const app = "/Users/test/Applications/Test Broker.app";
    vi.stubEnv("APPLE_NOTES_MCP_BROKERED", mode === "brokered" ? "1" : "0");
    vi.stubEnv("APPLE_NOTES_MCP_BROKER_APP", app);
    const note = { id: ID, title: "Synthetic", passwordProtected: false };
    manager.getNoteById.mockReturnValue(note);
    manager.getNoteDetails.mockReturnValue(note);
    manager.getNoteLinkById.mockReturnValue(null);
    manager.getNoteLink.mockReturnValue(null);
    const result = await call(
      "get-note-link",
      lookup === "id" ? { id: ID } : { title: note.title }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("full_disk_access_missing");
    expect(result.content[0].text).toContain(mode === "brokered" ? app : process.execPath);
    expect(result.content[0].text).not.toContain(mode === "brokered" ? process.execPath : app);
  });

  it("adds not_found when the metadata executor reports a missing note", async () => {
    manager.readNoteById.mockReturnValue({ note: null, error: "Can't get note id" });
    const r = await call("get-note-content", { id: ID });
    expect(r).toEqual({
      content: errorText(`Failed to read metadata of note with ID "${ID}": Can't get note id`, {
        code: "not_found",
      }),
      structuredContent: { code: "not_found" },
      isError: true,
    });
  });

  it.each([
    ["Not authorized to send Apple events to Notes. (-1743)", { code: "permission_denied" }],
    [
      "Operation timed out after 30 seconds",
      { code: "timeout_indeterminate", indeterminate: true },
    ],
    ["Lost connection to Notes.app", { code: "notes_unavailable" }],
    ["spawnSync osascript EACCES", { code: "operation_failed" }],
    ["spawnSync osascript EACCES: Operation not permitted", { code: "permission_denied" }],
    ["Can't get note id", { code: "not_found" }],
    ["Note not found. The note may have been deleted or the ID is invalid.", { code: "not_found" }],
    ["Unexpected note metadata response", { code: "operation_failed" }],
    ["AppleScript note metadata read failed", { code: "operation_failed" }],
    ['Metadata read failed near "timed out, not found, -1743"', { code: "operation_failed" }],
    ["Metadata read failed near “timed out, not found, -1743”", { code: "operation_failed" }],
    [
      'Metadata read failed near "Note not found. The note may have been deleted or the ID is invalid."',
      { code: "operation_failed" },
    ],
    [
      "Metadata read may have been interrupted",
      { code: "verification_failed", indeterminate: true },
    ],
  ])(
    "preserves metadata lookup diagnostics without a false missing-note result: %s",
    async (error, envelope) => {
      manager.getNoteById.mockReturnValue(null);
      manager.readNoteById.mockReturnValue({ note: null, error });
      const result = await call("get-note-content", { id: ID });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(envelope);
      expect(result.content[0].text).toContain(error);
      expect(manager.getNoteById).not.toHaveBeenCalled();
      expect(manager.readNoteBodyById).not.toHaveBeenCalled();
    }
  );

  it("checks the preserved password flag before any body read", async () => {
    manager.readNoteById.mockReturnValue({
      note: { id: ID, title: "timed out -1743", passwordProtected: true },
    });
    const result = await call("get-note-content", { id: ID });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "unsupported" });
    expect(result.content[0].text).toContain("password-protected");
    expect(manager.readNoteBodyById).not.toHaveBeenCalled();
  });

  it("classifies a thrown error caught by withErrorHandling, keeping the prefixed text", async () => {
    manager.readNoteById.mockImplementation(() => {
      throw new Error(
        "Operation timed out after 30 seconds. Notes.app may be unresponsive or the operation involves too many notes."
      );
    });
    const r = await call("get-note-content", { id: ID });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error retrieving note content: Operation timed out/);
    expect(r.structuredContent).toEqual({ code: "timeout_indeterminate", indeterminate: true });
  });

  it("adds a code in the native tool wrapper", async () => {
    manager.getNoteById.mockReturnValue(null);
    const r = await call("add-native-tags", {
      id: ID,
      expectedContentHash: `sha256:${"0".repeat(64)}`,
      title: "Synthetic",
      scopeText: "synthetic scope phrase",
      tags: ["alpha"],
    });
    expect(r).toEqual({
      content: errorText("Note not found", { code: "not_found" }),
      structuredContent: { code: "not_found" },
      isError: true,
    });
  });

  it("adds a code in the direct-operations wrapper", async () => {
    manager.getFolderById.mockImplementation(() => {
      throw new Error("Folder not found");
    });
    const r = await call("get-folder-by-id", {
      id: "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICFolder/p1",
    });
    expect(r).toEqual({
      content: errorText("Folder not found", { code: "not_found" }),
      structuredContent: { code: "not_found" },
      isError: true,
    });
  });

  it("returns paragraph-tool refusals in the envelope with a reason", async () => {
    // The selector is checked before the Notes database is opened.
    const r = await call("get-paragraph-link", { id: ID, title: "Synthetic", contains: "x" });
    expect(r).toEqual({
      content: errorText("No paragraph link: Choose exactly one of id or title", {
        code: "validation_error",
        reason: "invalid-argument",
      }),
      structuredContent: { code: "validation_error", reason: "invalid-argument" },
      isError: true,
    });
    const list = await call("list-note-paragraphs", { id: ID, folder: "Work" });
    expect(list.structuredContent).toEqual({
      code: "validation_error",
      reason: "invalid-argument",
    });
    expect(list.content[0].text).toBe(
      "Error listing paragraphs: folder only narrows a title lookup"
    );
  });

  it("leaves success results without an error code", async () => {
    manager.listAccounts.mockReturnValue([{ name: "Synthetic" }]);
    const r = await call("list-accounts", {});
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).not.toHaveProperty("code");
  });
});
