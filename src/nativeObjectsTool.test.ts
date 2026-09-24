/**
 * get-native-objects on a note that also holds a tel: or sms: link. The
 * strict rich-text read refuses those schemes (writes need that); this
 * read-only tool must use the lenient read instead. The manager and the
 * database read are mocked; the mock enforces the same contract as
 * readRichNote (strict unless skipUnsafeLinks is set).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const manager = vi.hoisted(() => ({
  getNoteById: vi.fn(),
  getNoteContentById: vi.fn(),
}));
const readRichNote = vi.hoisted(() => vi.fn());

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
vi.mock(import("@/utils/noteRichText.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readRichNote,
}));

type Response = {
  content: Array<{ text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
const call = (name: string, args: Record<string, unknown>) =>
  registered.get(name)!(args) as Promise<Response>;

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p10";

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
  manager.getNoteById.mockReturnValue({ id: ID, title: "Contacts" });
  manager.getNoteContentById.mockReturnValue("<div>Call <a href='tel:+15555550100'>me</a></div>");
  readRichNote.mockImplementation((_id: string, options?: { skipUnsafeLinks?: boolean }) => {
    if (!options?.skipUnsafeLinks) throw new Error("Unsupported link scheme in note");
    return {
      text: "Call me",
      links: [],
      nativeTags: [],
      nativeObjectIds: ["C1"],
      hasNativeObjects: true,
      hasChecklist: true,
      revision: "r1",
      objects: [{ id: "C1", type: "checklist", start: 0, length: 7 }],
      checklistItems: [{ id: "aa", start: 0, text: "Call me", done: false }],
      objectData: [],
    };
  });
});

describe("get-native-objects on a note with a tel: link", () => {
  it("reads the native objects instead of failing on the link scheme", async () => {
    const r = await call("get-native-objects", { id: ID });
    expect(r.isError).toBeFalsy();
    expect(readRichNote).toHaveBeenCalledWith(ID, { skipUnsafeLinks: true });
    expect(r.structuredContent).toMatchObject({
      id: ID,
      checklistItems: [{ id: "aa", done: false }],
      tables: [],
    });
    expect(String(r.structuredContent?.contentHash)).toMatch(/^sha256:/);
  });
});
