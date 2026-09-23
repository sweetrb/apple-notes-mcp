import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";

const rich = vi.hoisted(() => ({ enrich: vi.fn(), read: vi.fn(), hash: vi.fn() }));
vi.mock("../utils/noteRichText.js", async (original) => ({
  ...(await original<typeof import("../utils/noteRichText.js")>()),
  enrichNoteRead: rich.enrich,
  readRichNote: rich.read,
  richContentHash: rich.hash,
}));
import { registerDirectOperations } from "./directOperations.js";

const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("direct Notes operations", () => {
  it("refuses a symlink instead of checking one file and reading another", async () => {
    const id = "x-coredata://ABC/ICNote/p1";
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-symlink-test-"));
    directories.push(directory);
    const target = join(directory, "target.txt");
    const path = join(directory, "attachment.txt");
    writeFileSync(target, "content");
    symlinkSync(target, path);

    rich.enrich.mockReturnValue({ complete: true, revision: "rich-before" });
    rich.read.mockReturnValue({
      text: "existing",
      links: [],
      nativeTags: [],
      nativeObjectIds: [],
      hasNativeObjects: false,
      hasChecklist: false,
      revision: "rich-before",
      objects: [],
      checklistItems: [],
      styleRuns: [],
      objectData: [],
    });
    rich.hash.mockReturnValue("revision");
    const manager = {
      getNoteById: vi.fn(() => ({ id, title: "Example", passwordProtected: false })),
      getNoteContentById: vi.fn(() => "existing"),
      listAttachmentsById: vi.fn(),
      addAttachmentById: vi.fn(),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );

    const handler = registerTool.mock.calls.find((call) => call[0] === "add-attachment")![2];
    const result = await handler({ id, expectedContentHash: "revision", path });

    expect(result).toMatchObject({ isError: true });
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
  });

  it.each([true, false])("adds one attachment and verifies bytes=%s", async (valid) => {
    const id = "x-coredata://ABC/ICNote/p1";
    const attachmentId = "x-coredata://ABC/ICAttachment/p3";
    const bytes = Buffer.from("Кириллица 🧭");
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-test-"));
    directories.push(directory);
    const path = join(directory, "example.txt");
    writeFileSync(path, bytes);
    const before = {
      text: "existing",
      links: [],
      nativeTags: [],
      nativeObjectIds: [],
      hasNativeObjects: false,
      hasChecklist: false,
      revision: "rich-before",
      objects: [],
      checklistItems: [],
      styleRuns: [],
      objectData: [],
    };
    const after = {
      ...before,
      revision: "rich-after",
      nativeObjectIds: ["new-object"],
      objectData: [{ id: "new-object", pk: 3, type: "file", mergeable: "", view: null }],
    };
    rich.enrich
      .mockReturnValueOnce({ complete: true, revision: "rich-before" })
      .mockReturnValueOnce({ complete: true, revision: "rich-before" })
      .mockReturnValueOnce({ complete: true, revision: "rich-after" });
    rich.read.mockReturnValueOnce(before).mockReturnValueOnce(before).mockReturnValueOnce(after);
    rich.hash
      .mockReturnValueOnce("revision")
      .mockReturnValueOnce("revision")
      .mockReturnValueOnce("next");
    const manager = {
      getNoteById: vi.fn(() => ({ id, title: "Example", passwordProtected: false })),
      getNoteContentById: vi.fn(() => "existing"),
      listAttachmentsById: vi
        .fn()
        .mockReturnValueOnce([{ id: "existing" }])
        .mockReturnValue([{ id: "existing" }, { id: attachmentId }, { id: attachmentId }]),
      addAttachmentById: vi.fn(() => attachmentId),
      getAttachmentBase64ById: vi.fn(() => ({
        base64: Buffer.from(valid ? bytes : Buffer.from("wrong")).toString("base64"),
      })),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );
    const handler = registerTool.mock.calls.find((call) => call[0] === "add-attachment")![2];
    const result = await handler({ id, expectedContentHash: "revision", path });
    expect(manager.addAttachmentById).toHaveBeenCalledTimes(1);
    expect(manager.getAttachmentBase64ById).toHaveBeenCalledWith(id, attachmentId);
    if (valid) expect(result.structuredContent).toMatchObject({ ok: true, attachmentId });
    else expect(result).toMatchObject({ isError: true });
  });
});

describe("attachment filename override and create-then-attach", () => {
  const id = "x-coredata://ABC/ICNote/p1";
  const attachmentId = "x-coredata://ABC/ICAttachment/p3";
  const bytes = Buffer.from("synthetic bytes");
  const richBase = {
    text: "existing",
    links: [],
    nativeTags: [],
    nativeObjectIds: [],
    hasNativeObjects: false,
    hasChecklist: false,
    revision: "rich",
    objects: [],
    checklistItems: [],
    styleRuns: [],
    objectData: [],
  };
  const source = () => {
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-name-test-"));
    directories.push(directory);
    const path = join(directory, "source.txt");
    writeFileSync(path, bytes);
    return path;
  };
  const setup = (reportedName: string) => {
    rich.enrich.mockReturnValue({ complete: true, revision: "rich" });
    rich.read.mockReturnValue(richBase);
    rich.hash.mockReturnValue("revision");
    const manager = {
      createNote: vi.fn(() => ({ id, title: "New" })),
      getNoteById: vi.fn(() => ({ id, title: "New", passwordProtected: false })),
      getNoteContentById: vi.fn(() => "existing"),
      listAttachmentsById: vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValue([{ id: attachmentId, name: reportedName }]),
      addAttachmentById: vi.fn(() => attachmentId),
      getAttachmentBase64ById: vi.fn(() => ({ base64: bytes.toString("base64") })),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );
    const handler = (name: string) =>
      registerTool.mock.calls.find((call) => call[0] === name)![2] as (args: unknown) => Promise<{
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
        content: Array<{ text: string }>;
      }>;
    return { manager, handler };
  };

  it("names the private copy after the override and verifies the reported name", async () => {
    const { manager, handler } = setup("Renamed Report.txt");
    const result = await handler("add-attachment")({
      id,
      expectedContentHash: "revision",
      path: source(),
      filename: "Renamed Report.txt",
    });
    expect(manager.addAttachmentById.mock.calls[0][2]).toMatch(/\/Renamed Report\.txt$/);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      attachmentId,
      name: "Renamed Report.txt",
      filenameVerified: true,
    });
  });

  it("attaches to a note whose rich read is not writable because it holds native objects", async () => {
    const { handler } = setup("source.txt");
    // A note with any native object (such as an earlier attachment) reads as
    // complete: false; only a revision mismatch means the read was inconsistent.
    rich.enrich.mockReturnValue({ complete: false, writable: false, revision: "rich" });
    const result = await handler("add-attachment")({
      id,
      expectedContentHash: "revision",
      path: source(),
    });
    expect(result.structuredContent).toMatchObject({ ok: true, attachmentId, name: "source.txt" });
    expect(result.structuredContent).not.toHaveProperty("filenameVerified");
  });

  it("still refuses a read whose metadata revisions disagree", async () => {
    const { manager, handler } = setup("source.txt");
    rich.enrich.mockReturnValue({ complete: false, writable: false, revision: "other" });
    const result = await handler("add-attachment")({
      id,
      expectedContentHash: "revision",
      path: source(),
    });
    expect(result.content[0].text).toMatch(/changed during read/);
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
  });

  it("reports a verified attachment whose name Notes changed without failing", async () => {
    const { handler } = setup("Other.txt");
    const result = await handler("add-attachment")({
      id,
      expectedContentHash: "revision",
      path: source(),
      filename: "Renamed.txt",
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      filenameVerified: false,
      filenameWarning: expect.stringMatching(/different name/),
    });
  });

  it.each(["../x.txt", "a/b.txt", "a:b.txt", ".hidden.txt", "report.pdf", " pad.txt", "tab\t.txt"])(
    "refuses the unsafe or retyped filename %j before touching Notes",
    async (filename) => {
      const { manager, handler } = setup("x");
      const result = await handler("add-attachment")({
        id,
        expectedContentHash: "revision",
        path: source(),
        filename,
      });
      expect(result.isError).toBe(true);
      expect(manager.getNoteById).not.toHaveBeenCalled();
      expect(manager.addAttachmentById).not.toHaveBeenCalled();
    }
  );

  it("creates a note and attaches the file in one call", async () => {
    const { manager, handler } = setup("Renamed.txt");
    const result = await handler("create-note-with-attachment")({
      title: "New",
      folder: "apple-notes-mcp test",
      account: "iCloud",
      path: source(),
      filename: "Renamed.txt",
    });
    expect(manager.createNote).toHaveBeenCalledWith(
      "New",
      "",
      [],
      "apple-notes-mcp test",
      "iCloud",
      "plaintext"
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      id,
      attachmentId,
      noteCreated: true,
      filenameVerified: true,
    });
  });

  it("refuses a bad file before creating the note", async () => {
    const { manager, handler } = setup("x");
    const result = await handler("create-note-with-attachment")({
      title: "New",
      path: join(tmpdir(), "does-not-exist-for-this-test.txt"),
    });
    expect(result.isError).toBe(true);
    expect(manager.createNote).not.toHaveBeenCalled();
  });

  it("names the created note when the attachment step fails", async () => {
    const { manager, handler } = setup("x");
    manager.getAttachmentBase64ById.mockReturnValue({ base64: "d3Jvbmc=" });
    const result = await handler("create-note-with-attachment")({ title: "New", path: source() });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      new RegExp(`Note ${id} was created; attach to it with add-attachment`)
    );
  });
});
