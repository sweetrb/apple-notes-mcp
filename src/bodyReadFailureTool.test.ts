/**
 * A body read that times out on a note with a large image (#237): get-note-content
 * and delete-note name the cause and the remedy, and delete-note still refuses.
 * The manager and the database read are mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const manager = vi.hoisted(() => ({
  getNoteById: vi.fn(),
  readNoteBodyById: vi.fn(),
  deleteNoteByIdIfUnchanged: vi.fn(),
}));
const readNoteStructure = vi.hoisted(() => vi.fn());

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
vi.mock(import("@/utils/noteStructure.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readNoteStructure,
}));

type Response = { content: Array<{ text: string }>; isError?: boolean };
const call = (name: string, args: Record<string, unknown>) =>
  registered.get(name)!(args) as Promise<Response>;

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p10";
const TIMEOUT =
  "Operation timed out after 30 seconds. Notes.app may be unresponsive or the operation involves too many notes.";

beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  await import("@/index.js");
  on.mockRestore();
  stdinOn.mockRestore();
});
afterAll(() => registered.clear());
beforeEach(() => {
  vi.resetAllMocks();
  manager.getNoteById.mockReturnValue({ id: ID, title: "Big scan" });
  manager.readNoteBodyById.mockReturnValue({ body: "", error: TIMEOUT });
  readNoteStructure.mockReturnValue({
    attachments: [{ filename: "scan.tiff", fileSize: 36 * 1024 * 1024 }],
  });
});

describe("body read failure on a note with a large image (#237)", () => {
  it("get-note-content names the attachment and the remedy", async () => {
    const r = await call("get-note-content", { id: ID });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("scan.tiff, 36.0 MB");
    expect(r.content[0].text).toContain("timeoutSeconds");
    expect(readNoteStructure).toHaveBeenCalledWith(ID, { includeText: false });
  });

  it("falls back to the general explanation without Full Disk Access", async () => {
    readNoteStructure.mockImplementation(() => {
      throw new Error("Full Disk Access required");
    });
    const r = await call("get-note-content", { id: ID });
    expect(r.content[0].text).toContain("base64");
    expect(r.content[0].text).not.toContain("scan.tiff");
  });

  it("does not look up attachments for an unrelated failure", async () => {
    manager.readNoteBodyById.mockReturnValue({ body: "", error: "Not found: note id x" });
    const r = await call("get-note-content", { id: ID });
    expect(r.content[0].text).toBe(
      'Failed to read content of note "Big scan": Not found: note id x'
    );
    expect(readNoteStructure).not.toHaveBeenCalled();
  });

  it("delete-note explains the failure and deletes nothing", async () => {
    const r = await call("delete-note", {
      id: ID,
      expectedContentHash: `sha256:${"0".repeat(64)}`,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("scan.tiff, 36.0 MB");
    expect(r.content[0].text).toContain("Nothing was changed.");
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });
});
