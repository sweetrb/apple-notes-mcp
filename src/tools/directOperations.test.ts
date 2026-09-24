import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const pasteboard = vi.hoisted(() => ({ freeze: vi.fn() }));
vi.mock("../utils/pasteboardFreeze.js", async (original) => ({
  ...(await original<typeof import("../utils/pasteboardFreeze.js")>()),
  freezePasteboard: pasteboard.freeze,
}));
import { registerDirectOperations } from "./directOperations.js";
import { PasteboardError } from "../utils/pasteboardFreeze.js";

const directories: string[] = [];
/** A saveAttachmentById mock that writes `content` where the caller asked. */
const savesAs = (content: Buffer) =>
  vi.fn((_note: string, _attachment: string, dest: string) => {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    return { success: true, savedPath: dest };
  });
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
      saveAttachmentById: savesAs(valid ? bytes : Buffer.from("wrong")),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );
    const handler = registerTool.mock.calls.find((call) => call[0] === "add-attachment")![2];
    const result = await handler({ id, expectedContentHash: "revision", path });
    expect(manager.addAttachmentById).toHaveBeenCalledTimes(1);
    expect(manager.saveAttachmentById).toHaveBeenCalledWith(id, attachmentId, expect.any(String));
    if (valid) expect(result.structuredContent).toMatchObject({ ok: true, attachmentId });
    else expect(result).toMatchObject({ isError: true });
  });

  it("verifies a file over the 25 MiB base64 fetch cap (#243)", async () => {
    const id = "x-coredata://ABC/ICNote/p1";
    const attachmentId = "x-coredata://ABC/ICAttachment/p3";
    const bytes = Buffer.alloc(25 * 1024 * 1024 + 1, 7);
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-large-test-"));
    directories.push(directory);
    const path = join(directory, "large.png");
    writeFileSync(path, bytes);
    rich.enrich.mockReturnValue({ complete: true, revision: "rich" });
    rich.read.mockReturnValue({
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
    });
    rich.hash.mockReturnValue("revision");
    const manager = {
      getNoteById: vi.fn(() => ({ id, title: "Example", passwordProtected: false })),
      getNoteContentById: vi.fn(() => "existing"),
      listAttachmentsById: vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValue([{ id: attachmentId, name: "large.png" }]),
      addAttachmentById: vi.fn(() => attachmentId),
      saveAttachmentById: savesAs(bytes),
      // The capped base64 path must not be used for verification.
      getAttachmentBase64ById: vi.fn(() => ({ success: false, error: "too large" })),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );
    const handler = registerTool.mock.calls.find((call) => call[0] === "add-attachment")![2];
    const result = await handler({ id, expectedContentHash: "revision", path });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      attachmentId,
      bytes: bytes.length,
    });
    expect(manager.getAttachmentBase64ById).not.toHaveBeenCalled();
  });

  it("rejects a saved copy one byte short of a large file (#243)", async () => {
    const id = "x-coredata://ABC/ICNote/p1";
    const attachmentId = "x-coredata://ABC/ICAttachment/p3";
    const bytes = Buffer.alloc(25 * 1024 * 1024 + 1, 7);
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-large-test-"));
    directories.push(directory);
    const path = join(directory, "large.png");
    writeFileSync(path, bytes);
    rich.enrich.mockReturnValue({ complete: true, revision: "rich" });
    rich.read.mockReturnValue({
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
    });
    rich.hash.mockReturnValue("revision");
    const manager = {
      getNoteById: vi.fn(() => ({ id, title: "Example", passwordProtected: false })),
      getNoteContentById: vi.fn(() => "existing"),
      listAttachmentsById: vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValue([{ id: attachmentId, name: "large.png" }]),
      addAttachmentById: vi.fn(() => attachmentId),
      saveAttachmentById: savesAs(bytes.subarray(1)),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );
    const handler = registerTool.mock.calls.find((call) => call[0] === "add-attachment")![2];
    const result = await handler({ id, expectedContentHash: "revision", path });
    expect(result).toMatchObject({ isError: true });
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
      saveAttachmentById: savesAs(bytes),
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

  /** A frozen pasteboard copy named like the real one would be. */
  const frozen = (name: string, kind: "data" | "file" = "data", type = "public.png") => {
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-pasteboard-test-"));
    directories.push(directory);
    const path = join(directory, name);
    writeFileSync(path, bytes);
    const cleanup = vi.fn();
    pasteboard.freeze.mockReturnValue({
      kind,
      type,
      path,
      filename: name,
      bytes: bytes.length,
      cleanup,
    });
    return cleanup;
  };

  it("attaches the frozen pasteboard copy through add-attachment's verified path", async () => {
    const cleanup = frozen("Pasted image.png");
    const { manager, handler } = setup("Pasted image.png");
    const result = await handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
    });
    expect(manager.addAttachmentById).toHaveBeenCalledTimes(1);
    expect(manager.addAttachmentById.mock.calls[0][2]).toMatch(/\/Pasted image\.png$/);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      attachmentId,
      bytes: bytes.length,
      name: "Pasted image.png",
      source: { kind: "data", type: "public.png", filename: "Pasted image.png" },
    });
    expect(result.structuredContent).not.toHaveProperty("filenameVerified");
    expect(pasteboard.freeze).toHaveBeenCalledWith({
      pasteboardName: undefined,
      allowPasteAlert: false,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reads a named pasteboard when the testing variable is set", async () => {
    frozen("Pasted image.png");
    const { handler } = setup("Pasted image.png");
    vi.stubEnv("APPLE_NOTES_MCP_PASTEBOARD_NAME", " live-test-board ");
    try {
      await handler("add-attachment-from-pasteboard")({ id, expectedContentHash: "revision" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(pasteboard.freeze).toHaveBeenCalledWith({
      pasteboardName: "live-test-board",
      allowPasteAlert: false,
    });
  });

  it("applies a filename override, adding the pasted type's extension when missing", async () => {
    const cleanup = frozen("report.pdf", "file", "public.file-url");
    const { manager, handler } = setup("Q3 receipt.pdf");
    const result = await handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
      filename: "Q3 receipt",
    });
    expect(manager.addAttachmentById.mock.calls[0][2]).toMatch(/\/Q3 receipt\.pdf$/);
    expect(result.structuredContent).toMatchObject({
      name: "Q3 receipt.pdf",
      filenameVerified: true,
      source: { kind: "file", filename: "report.pdf" },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("refuses an override whose extension does not match the pasted type, then cleans up", async () => {
    const cleanup = frozen("Pasted image.png");
    const { manager, handler } = setup("x");
    const result = await handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
      filename: "photo.jpg",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/);
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports a pasteboard failure with its code and never inserts", async () => {
    pasteboard.freeze.mockImplementation(() => {
      throw new PasteboardError("unsupported_content", "no image on the pasteboard");
    });
    const { manager, handler } = setup("x");
    const result = await handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no image on the pasteboard");
    expect(result.structuredContent).toMatchObject({
      code: "validation_error",
      pasteboardCode: "unsupported_content",
      committed: false,
    });
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
  });

  it("passes allowPasteAlert through and reports an access refusal as permission_denied", async () => {
    pasteboard.freeze.mockImplementation(() => {
      throw new PasteboardError("pasteboard_access_denied", "macOS would ask", {
        accessBehavior: "default",
      });
    });
    const { manager, handler } = setup("x");
    const result = await handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
      allowPasteAlert: true,
    });
    expect(pasteboard.freeze).toHaveBeenCalledWith({
      pasteboardName: undefined,
      allowPasteAlert: true,
    });
    expect(result.structuredContent).toMatchObject({
      code: "permission_denied",
      pasteboardCode: "pasteboard_access_denied",
      accessBehavior: "default",
      committed: false,
    });
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
  });

  it("checks the note, revision, and filename before reading the pasteboard", async () => {
    frozen("Pasted image.png");
    const stale = setup("x");
    const staleResult = await stale.handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "stale",
    });
    expect(staleResult.structuredContent).toMatchObject({ code: "revision_conflict" });

    const missing = setup("x");
    missing.manager.getNoteById.mockReturnValue(null as never);
    const missingResult = await missing.handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
    });
    expect(missingResult.structuredContent).toMatchObject({ code: "not_found" });

    const badName = setup("x");
    const badNameResult = await badName.handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
      filename: "a/b",
    });
    expect(badNameResult.isError).toBe(true);
    expect(badName.manager.getNoteById).not.toHaveBeenCalled();

    expect(pasteboard.freeze).not.toHaveBeenCalled();
  });

  it("reads the note once before freezing and re-checks it before inserting", async () => {
    const order: string[] = [];
    const cleanup = frozen("Pasted image.png");
    const { manager, handler } = setup("Pasted image.png");
    manager.getNoteById.mockImplementation(() => {
      order.push("note");
      return { id, title: "New", passwordProtected: false };
    });
    const frozenValue = pasteboard.freeze();
    pasteboard.freeze.mockImplementation(() => {
      order.push("freeze");
      return frozenValue;
    });
    manager.addAttachmentById.mockImplementation(() => {
      order.push("insert");
      return attachmentId;
    });
    const result = await handler("add-attachment-from-pasteboard")({
      id,
      expectedContentHash: "revision",
    });
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(order.slice(0, 3)).toEqual(["note", "freeze", "note"]);
    expect(order.indexOf("insert")).toBeGreaterThan(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

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

  it("hands off to add-attachment when the attach step fails before insertion", async () => {
    const { manager, handler } = setup("x");
    manager.listAttachmentsById.mockReset().mockImplementation(() => {
      throw new Error("Notes.app is busy");
    });
    const result = await handler("create-note-with-attachment")({ title: "New", path: source() });
    expect(result.isError).toBe(true);
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(
      new RegExp(`Note ${id} was created; attach to it with add-attachment`)
    );
    expect(result.structuredContent).toMatchObject({ committed: true, indeterminate: false });
  });

  // The attachment path gets the same read scope as create-note's contentPath
  // (#256): a prompt must not attach ~/.ssh/id_ed25519 to a synced note.
  describe("attachment read scope", () => {
    const privateTree = () => {
      const directory = mkdtempSync(join(tmpdir(), "direct-operation-scope-test-"));
      directories.push(directory);
      mkdirSync(join(directory, ".ssh"));
      writeFileSync(join(directory, ".ssh", "key.txt"), bytes);
      symlinkSync(join(directory, ".ssh"), join(directory, "keys"), "dir");
      return directory;
    };

    it("refuses a file in a hidden directory", async () => {
      const { manager, handler } = setup("key.txt");
      const result = await handler("add-attachment")({
        id,
        expectedContentHash: "revision",
        path: join(privateTree(), ".ssh", "key.txt"),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/hidden file or directory/);
      expect(result.content[0].text).toMatch(/APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS/);
      expect(result.structuredContent).toEqual({
        code: "validation_error",
        committed: false,
        indeterminate: false,
      });
      expect(manager.addAttachmentById).not.toHaveBeenCalled();
    });

    it("refuses a hidden directory reached through a visible symlinked directory", async () => {
      const { manager, handler } = setup("key.txt");
      const result = await handler("add-attachment")({
        id,
        expectedContentHash: "revision",
        path: join(privateTree(), "keys", "key.txt"),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/hidden file or directory/);
      expect(manager.addAttachmentById).not.toHaveBeenCalled();
    });

    it("refuses a private path before create-note-with-attachment creates the note", async () => {
      const { manager, handler } = setup("key.txt");
      const result = await handler("create-note-with-attachment")({
        title: "New",
        path: join(privateTree(), ".ssh", "key.txt"),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/hidden file or directory/);
      expect(manager.createNote).not.toHaveBeenCalled();
    });

    // On a case-insensitive volume "~/library" names ~/Library; only the
    // re-check after realpath sees the real spelling.
    it.runIf(process.platform === "darwin")(
      "refuses a case variant of ~/Library after realpath",
      async () => {
        const caches = join(homedir(), "Library", "Caches");
        mkdirSync(caches, { recursive: true });
        const directory = mkdtempSync(join(caches, "direct-operation-case-test-"));
        directories.push(directory);
        writeFileSync(join(directory, "key.txt"), bytes);
        const variant = join(homedir(), "library", "Caches", basename(directory), "key.txt");
        if (!existsSync(variant)) return; // case-sensitive volume: nothing to alias
        const { manager, handler } = setup("key.txt");
        const result = await handler("add-attachment")({
          id,
          expectedContentHash: "revision",
          path: variant,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/~\/Library/);
        expect(manager.addAttachmentById).not.toHaveBeenCalled();
      }
    );

    it("refuses a path outside home, temp and /Volumes", async () => {
      const { manager, handler } = setup("hosts");
      const result = await handler("add-attachment")({
        id,
        expectedContentHash: "revision",
        path: "/etc/hosts",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/outside allowed locations/);
      expect(manager.addAttachmentById).not.toHaveBeenCalled();
    });

    it("refuses a FIFO without blocking on open", async () => {
      const directory = mkdtempSync(join(tmpdir(), "direct-operation-fifo-test-"));
      directories.push(directory);
      const fifo = join(directory, "pipe.txt");
      execFileSync("mkfifo", [fifo]);
      const { manager, handler } = setup("pipe.txt");
      const result = await handler("add-attachment")({
        id,
        expectedContentHash: "revision",
        path: fifo,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not a regular file/);
      expect(manager.addAttachmentById).not.toHaveBeenCalled();
    });

    it("attaches a hidden path only when the server opts in", async () => {
      const { handler } = setup("key.txt");
      vi.stubEnv("APPLE_NOTES_MCP_ALLOW_PRIVATE_CONTENT_PATHS", "1");
      try {
        const result = await handler("add-attachment")({
          id,
          expectedContentHash: "revision",
          path: join(privateTree(), ".ssh", "key.txt"),
        });
        expect(result.structuredContent).toMatchObject({ ok: true, attachmentId });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // The note was created, so a pre-insertion revision conflict must not read
  // as committed: false, which would invite a retry that creates a second note.
  it("never reports committed: false once the note exists", async () => {
    const { manager, handler } = setup("x");
    manager.listAttachmentsById.mockReset().mockImplementation(() => {
      throw new Error("Note revision changed");
    });
    const result = await handler("create-note-with-attachment")({ title: "New", path: source() });
    expect(result.isError).toBe(true);
    expect(manager.addAttachmentById).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      code: "revision_conflict",
      committed: true,
      indeterminate: false,
    });
  });

  // #196: after insertion the file may already be in the note, so sending the
  // caller to add-attachment would duplicate it.
  it("reports an uncertain attachment after insertion without the add-attachment hand-off", async () => {
    const { manager, handler } = setup("x");
    manager.saveAttachmentById.mockImplementation(savesAs(Buffer.from("wrong")));
    const result = await handler("create-note-with-attachment")({ title: "New", path: source() });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      new RegExp(`Note ${id} was created, but the attachment outcome is uncertain`)
    );
    expect(result.content[0].text).not.toMatch(/attach to it with add-attachment/);
    expect(result.structuredContent).toEqual({
      code: "verification_failed",
      committed: true,
      indeterminate: true,
    });
  });
});

describe("add-attachment verifies through NoteStore when AppleScript lists nothing (#236)", () => {
  const id = "x-coredata://ABC/ICNote/p1";
  const bytes = Buffer.from("%PDF-1.7 synthetic");
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
  const row = (
    pk: number,
    identifier: string,
    assetPaths: string[],
    parent: string | null = null
  ) => ({
    pk,
    identifier,
    uti: "com.adobe.pdf",
    kind: "pdf",
    parentIdentifier: parent,
    filename: "report.pdf",
    bodyIndex: null,
    assetPaths,
    previewPath: null,
    paths: assetPaths,
  });
  const setup = (stored: () => unknown, returnedId = "") => {
    rich.enrich.mockReturnValue({ complete: true, revision: "rich" });
    rich.read.mockReturnValue(richBase);
    rich.hash.mockReturnValue("revision");
    const directory = mkdtempSync(join(tmpdir(), "direct-operation-pdf-test-"));
    directories.push(directory);
    const path = join(directory, "report.pdf");
    writeFileSync(path, bytes);
    const manager = {
      getNoteById: vi.fn(() => ({ id, title: "Note", passwordProtected: false })),
      getNoteContentById: vi.fn(() => "existing"),
      // Notes' AppleScript on macOS 27 never lists the PDF.
      listAttachmentsById: vi.fn(() => []),
      addAttachmentById: vi.fn(() => returnedId),
      saveAttachmentById: vi.fn(),
      getAttachmentAssetsById: vi.fn(stored),
    };
    const registerTool = vi.fn();
    registerDirectOperations(
      { registerTool } as unknown as McpServer,
      manager as unknown as AppleNotesManager
    );
    const handler = registerTool.mock.calls.find((call) => call[0] === "add-attachment")![2];
    return {
      manager,
      directory,
      run: () =>
        handler({ id, expectedContentHash: "revision", path }) as Promise<{
          structuredContent?: Record<string, unknown>;
          isError?: boolean;
          content: Array<{ text: string }>;
        }>,
    };
  };
  const mediaFile = (directory: string, data: Buffer) => {
    const media = join(directory, "media.pdf");
    writeFileSync(media, data);
    return media;
  };

  it("reports success when exactly one new row appears with the same bytes", async () => {
    let media = "";
    let calls = 0;
    const { manager, directory, run } = setup(() => ({
      orderSource: "creation",
      attachments:
        calls++ === 0
          ? [row(4, "OLD", [])]
          : [row(4, "OLD", []), row(9, "NEW", [media]), row(10, "CHILD", [], "NEW")],
    }));
    media = mediaFile(directory, bytes);
    const result = await run();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      attachmentId: "x-coredata://ABC/ICAttachment/p9",
      name: "report.pdf",
      verifiedBy: "database",
      bytes: bytes.length,
    });
    expect(manager.addAttachmentById).toHaveBeenCalledTimes(1);
    expect(manager.saveAttachmentById).not.toHaveBeenCalled();
  });

  it("refuses a new row whose file bytes differ, and says not to attach again", async () => {
    let media = "";
    let calls = 0;
    const { directory, run } = setup(() => ({
      orderSource: "creation",
      attachments: calls++ === 0 ? [] : [row(9, "NEW", [media])],
    }));
    media = mediaFile(directory, Buffer.from("different"));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ICAttachment\/p9.*do not attach the file again/);
  });

  it("refuses a row that disagrees with the id Notes returned", async () => {
    let media = "";
    let calls = 0;
    const { directory, run } = setup(
      () => ({
        orderSource: "creation",
        attachments: calls++ === 0 ? [] : [row(9, "NEW", [media])],
      }),
      "x-coredata://ABC/ICAttachment/p8"
    );
    media = mediaFile(directory, bytes);
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome uncertain/);
  });

  it("stays uncertain when no new row appears", async () => {
    const { run } = setup(() => ({ orderSource: "creation", attachments: [row(4, "OLD", [])] }));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome uncertain/);
    expect(result.content[0].text).not.toMatch(/Full Disk Access/);
  });

  it("stays uncertain and names Full Disk Access when the database cannot be read", async () => {
    const { run } = setup(() => {
      throw new Error("Full Disk Access is required");
    });
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome uncertain.*Full Disk Access/);
  });
});
