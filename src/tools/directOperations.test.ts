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
