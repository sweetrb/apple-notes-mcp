/**
 * get-note-content by exact id when Notes.app is slow (#316): a note the
 * NoteStore database holds (the store get-note-structure reads) either returns
 * content and a contentHash, or a distinct timeout / Notes-unavailable state.
 * It is never reported as not_found. The manager and database reads are mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_ID_NOT_FOUND_MESSAGE } from "@/utils/applescript.js";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const manager = vi.hoisted(() => ({
  readNoteById: vi.fn(),
  readNoteBodyById: vi.fn(),
}));
const readNotePresence = vi.hoisted(() => vi.fn());
const readNoteStructure = vi.hoisted(() => vi.fn());
const enrichNoteRead = vi.hoisted(() => vi.fn());

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
vi.mock("@/utils/notePresence.js", () => ({ readNotePresence }));
vi.mock(import("@/utils/noteStructure.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readNoteStructure,
}));
vi.mock(import("@/utils/noteRichText.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  enrichNoteRead,
}));

type Response = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const call = (args: Record<string, unknown>) =>
  registered.get("get-note-content")!(args) as Promise<Response>;

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p316";
const BODY = "<div><h1>Plain note</h1></div><div>No attachments here.</div>";
const APPLE_EVENT_TIMEOUT = "Notes got an error: AppleEvent timed out.";
const STORED = { title: "Plain note", locked: false, inRecentlyDeleted: false };

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
  readNotePresence.mockReturnValue(STORED);
  readNoteStructure.mockReturnValue({ attachments: [] });
  enrichNoteRead.mockImplementation((_id: string, body: string) => ({
    content: body,
    links: [],
    nativeTags: [],
    complete: true,
    writable: true,
    revision: "rev-1",
  }));
  manager.readNoteBodyById.mockReturnValue({ body: BODY });
});

describe("get-note-content for a note the NoteStore database holds (#316)", () => {
  it("returns content and a contentHash without the AppleScript metadata step", async () => {
    const r = await call({ id: ID });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      id: ID,
      title: "Plain note",
      content: BODY,
      contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      writable: true,
    });
    expect(readNotePresence).toHaveBeenCalledWith(ID);
    expect(manager.readNoteById).not.toHaveBeenCalled();
    expect(manager.readNoteBodyById).toHaveBeenCalledTimes(1);
  });

  it("refuses a locked note from the database flag before any AppleScript read", async () => {
    readNotePresence.mockReturnValue({ ...STORED, locked: true });
    const r = await call({ id: ID });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "unsupported" });
    expect(r.content[0].text).toContain("password-protected");
    expect(manager.readNoteById).not.toHaveBeenCalled();
    expect(manager.readNoteBodyById).not.toHaveBeenCalled();
  });

  it("reports a body-read timeout as timeout_indeterminate, keeping the AppleEvent diagnostic", async () => {
    manager.readNoteBodyById.mockReturnValue({ body: "", error: APPLE_EVENT_TIMEOUT });
    const r = await call({ id: ID });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "timeout_indeterminate", indeterminate: true });
    expect(r.content[0].text).toContain(APPLE_EVENT_TIMEOUT);
    // An attachment-free note is not blamed on an image.
    expect(r.content[0].text).toContain("no attachments");
    expect(r.content[0].text).not.toContain("shrink");
  });

  it.each([
    ["the executor's missing-ID diagnostic", NOTE_ID_NOT_FOUND_MESSAGE],
    ["Notes' raw missing-ID error", 'Can\'t get note id "x-coredata://S/ICNote/p316".'],
  ])("does not report %s as not_found", async (_name, error) => {
    manager.readNoteBodyById.mockReturnValue({ body: "", error });
    const r = await call({ id: ID });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "notes_unavailable" });
    expect(r.content[0].text).toContain("NoteStore database holds this note");
    expect(r.content[0].text).toContain(error);
  });

  it("falls back to the AppleScript metadata read when the database has no title", async () => {
    readNotePresence.mockReturnValue({ ...STORED, title: null });
    manager.readNoteById.mockReturnValue({
      note: { id: ID, title: "From AppleScript", passwordProtected: false },
    });
    const r = await call({ id: ID });
    expect(r.structuredContent).toMatchObject({ title: "From AppleScript", content: BODY });
    expect(manager.readNoteById).toHaveBeenCalledWith(ID);
  });
});

describe("get-note-content when the database cannot vouch for the note", () => {
  beforeEach(() => readNotePresence.mockReturnValue(null));

  it("keeps a metadata timeout distinct even when a retry then reported the note missing", async () => {
    const error = `${APPLE_EVENT_TIMEOUT} A retry then failed: ${NOTE_ID_NOT_FOUND_MESSAGE}`;
    manager.readNoteById.mockReturnValue({ note: null, error });
    const r = await call({ id: ID });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "timeout_indeterminate", indeterminate: true });
    expect(r.content[0].text).toContain("AppleEvent timed out");
    expect(manager.readNoteBodyById).not.toHaveBeenCalled();
  });

  it("still reports a definitive missing note as not_found", async () => {
    manager.readNoteById.mockReturnValue({ note: null, error: NOTE_ID_NOT_FOUND_MESSAGE });
    const r = await call({ id: ID });
    expect(r.structuredContent).toEqual({ code: "not_found" });
  });

  it("reports a missing ID on the body read as not_found, not an uncertain write", async () => {
    manager.readNoteById.mockReturnValue({
      note: { id: ID, title: "Gone", passwordProtected: false },
    });
    manager.readNoteBodyById.mockReturnValue({ body: "", error: NOTE_ID_NOT_FOUND_MESSAGE });
    const r = await call({ id: ID });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "not_found" });
  });
});
