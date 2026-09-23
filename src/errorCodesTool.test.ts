/**
 * Error codes through the real tool wrappers: tools registered by src/index.ts
 * (withErrorHandling and direct errorResponse returns) and by the native tool
 * modules, driven through their registered callbacks with a mocked manager.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const manager = vi.hoisted(() => ({
  getNoteById: vi.fn(),
  getNoteContentById: vi.fn(),
  listAccounts: vi.fn(),
  getFolderById: vi.fn(),
}));

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
const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p999999";

beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  await import("@/index.js");
  on.mockRestore();
  stdinOn.mockRestore();
});
afterAll(() => registered.clear());
beforeEach(() => vi.resetAllMocks());

describe("error codes through tool wrappers", () => {
  it("adds not_found to a direct errorResponse without changing its text", async () => {
    manager.getNoteById.mockReturnValue(null);
    const r = await call("get-note-content", { id: ID });
    expect(r).toEqual({
      content: [{ type: "text", text: `Note with ID "${ID}" not found` }],
      structuredContent: { code: "not_found" },
      isError: true,
    });
  });

  it("classifies a thrown error caught by withErrorHandling, keeping the prefixed text", async () => {
    manager.getNoteById.mockImplementation(() => {
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
      content: [{ type: "text", text: "Note not found" }],
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
      content: [{ type: "text", text: "Folder not found" }],
      structuredContent: { code: "not_found" },
      isError: true,
    });
  });

  it("returns paragraph-tool refusals in the envelope with a reason", async () => {
    // The selector is checked before the Notes database is opened.
    const r = await call("get-paragraph-link", { id: ID, title: "Synthetic", contains: "x" });
    expect(r).toEqual({
      content: [{ type: "text", text: "No paragraph link: Choose exactly one of id or title" }],
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
