/**
 * The create-note handler as src/index.ts registers it, driven through the
 * registered callback rather than the manager, so the `format: "markdown"`
 * branch (account refusal, live-validation gate, response shape) is covered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const manager = vi.hoisted(() => ({
  createNote: vi.fn(),
  getNoteById: vi.fn(),
  getNoteContentById: vi.fn(),
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
vi.mock(import("@/services/backgroundNotes.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  createMarkdownNote: vi.fn(),
}));
vi.mock(import("@/tools/nativeOperations.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  requireValidated: vi.fn(),
}));
vi.mock("@/utils/noteRichText.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/noteRichText.js")>()),
  enrichNoteRead: vi.fn(() => ({})),
  richContentHash: vi.fn(() => "sha256:plain"),
}));

import { createMarkdownNote } from "@/services/backgroundNotes.js";
import { requireValidated } from "@/tools/nativeOperations.js";

type Response = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const createNote = (args: Record<string, unknown>) =>
  registered.get("create-note")!(args) as Promise<Response>;

// Importing the entry point registers every tool, then connects the (mocked)
// transport. Keep its process-level listeners out of the test worker.
beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  await import("@/index.js");
  on.mockRestore();
  stdinOn.mockRestore();
});
afterAll(() => registered.clear());
beforeEach(() => vi.clearAllMocks());

describe("create-note format markdown (#172)", () => {
  it("refuses account before the gate or any write", async () => {
    const response = await createNote({
      title: "Plan",
      content: "## Goals",
      format: "markdown",
      account: "iCloud",
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/created in the iCloud account.*omit account/);
    expect(requireValidated).not.toHaveBeenCalled();
    expect(createMarkdownNote).not.toHaveBeenCalled();
    expect(manager.createNote).not.toHaveBeenCalled();
  });

  it("stops at the live-validation gate without creating anything", async () => {
    vi.mocked(requireValidated).mockImplementationOnce(() => {
      throw new Error("create-note-markdown has not passed live background validation");
    });
    const response = await createNote({ title: "Plan", content: "## Goals", format: "markdown" });
    expect(requireValidated).toHaveBeenCalledWith("create-note-markdown");
    expect(response).toMatchObject({ isError: true });
    expect(response.content[0].text).toBe(
      "Error creating note: create-note-markdown has not passed live background validation"
    );
    expect(createMarkdownNote).not.toHaveBeenCalled();
  });

  it("refuses tags before the gate or any write", async () => {
    const response = await createNote({
      title: "Plan",
      content: "## Goals",
      format: "markdown",
      tags: ["work"],
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(
      /tags are not supported with format "markdown".*add-native-tags/
    );
    expect(requireValidated).not.toHaveBeenCalled();
    expect(createMarkdownNote).not.toHaveBeenCalled();
    expect(manager.createNote).not.toHaveBeenCalled();
  });

  it("creates through the bridge and returns the verified result", async () => {
    const result = {
      ok: true,
      id: "x-coredata://ABCDEF/ICNote/p2",
      title: "Plan",
      folder: "Work",
      account: "iCloud",
      contentHash: "sha256:created",
      verified: true,
    };
    vi.mocked(createMarkdownNote).mockReturnValueOnce(result);
    const response = await createNote({
      title: "Plan",
      content: "## Goals",
      format: "markdown",
      folder: "Work",
    });
    expect(createMarkdownNote).toHaveBeenCalledWith(manager, {
      title: "Plan",
      content: "## Goals",
      folder: "Work",
    });
    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe(
      'Note created from Markdown: "Plan" [id: x-coredata://ABCDEF/ICNote/p2]'
    );
    expect(response.structuredContent).toEqual(result);
    expect(manager.createNote).not.toHaveBeenCalled();
  });

  it("reports a bridge failure as a create-note error", async () => {
    vi.mocked(createMarkdownNote).mockImplementationOnce(() => {
      throw new Error("Operation outcome uncertain; read note x before any retry: moved");
    });
    const response = await createNote({ title: "Plan", content: "## Goals", format: "markdown" });
    expect(response.content[0].text).toBe(
      "Error creating note: Operation outcome uncertain; read note x before any retry: moved"
    );
  });

  it("leaves plaintext and HTML creation on the AppleScript path", async () => {
    manager.createNote.mockReturnValueOnce({ id: "x-coredata://ABCDEF/ICNote/p3", title: "Plan" });
    manager.getNoteById.mockReturnValueOnce({ id: "x-coredata://ABCDEF/ICNote/p3", title: "Plan" });
    manager.getNoteContentById.mockReturnValueOnce("<div>Plan</div>");
    const response = await createNote({ title: "Plan", content: "<p>x</p>", format: "html" });
    expect(manager.createNote).toHaveBeenCalledWith(
      "Plan",
      "<p>x</p>",
      [],
      undefined,
      undefined,
      "html"
    );
    expect(response.structuredContent).toMatchObject({ ok: true, verified: true });
    expect(requireValidated).not.toHaveBeenCalled();
    expect(createMarkdownNote).not.toHaveBeenCalled();
  });
});
