/**
 * The create-note handler as src/index.ts registers it, driven through the
 * registered callback rather than the manager, so the `format: "markdown"`
 * branch (account refusal, live-validation gate, response shape) is covered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const configs = vi.hoisted(() => new Map<string, unknown>());
const manager = vi.hoisted(() => ({
  createNote: vi.fn(),
  getNoteById: vi.fn(),
  getNoteContentById: vi.fn(),
  deleteNoteByIdIfUnchanged: vi.fn(),
}));

vi.mock(import("@modelcontextprotocol/sdk/server/mcp.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn(
        (name: string, config: unknown, cb: (args: unknown) => Promise<unknown>) => {
          configs.set(name, config);
          registered.set(name, cb);
        }
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarkdownNote } from "@/services/backgroundNotes.js";
import { callTimeoutMs } from "@/utils/callTimeout.js";
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

const created = (id = "x-coredata://ABCDEF/ICNote/p4") => {
  manager.createNote.mockReturnValueOnce({ id, title: "Plan" });
  manager.getNoteById.mockReturnValueOnce({ id, title: "Plan" });
  manager.getNoteContentById.mockReturnValueOnce("<div>Plan</div>");
};

describe("create-note content sources", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "create-note-source-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the body from contentPath", async () => {
    const file = join(dir, "body.txt");
    writeFileSync(file, "\uFEFFFrom a file\nsecond line");
    created();
    const response = await createNote({ title: "Plan", contentPath: file });
    expect(response.isError).toBeUndefined();
    expect(manager.createNote).toHaveBeenCalledWith(
      "Plan",
      "From a file\nsecond line",
      [],
      undefined,
      undefined,
      "plaintext"
    );
  });

  it("requires exactly one of content and contentPath", async () => {
    for (const args of [{}, { content: "x", contentPath: join(dir, "body.txt") }]) {
      const response = await createNote({ title: "Plan", ...args });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/exactly one of content or contentPath/);
    }
    expect(manager.createNote).not.toHaveBeenCalled();
  });

  it("refuses a content file outside the allowed roots before any write", async () => {
    const response = await createNote({ title: "Plan", contentPath: "/etc/hosts" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/outside allowed locations/);
    expect(manager.createNote).not.toHaveBeenCalled();
  });

  it("refuses markdownRoute for a non-Markdown format", async () => {
    const response = await createNote({ title: "Plan", content: "x", markdownRoute: "html" });
    expect(response.content[0].text).toMatch(/markdownRoute applies to format "markdown" only/);
    expect(manager.createNote).not.toHaveBeenCalled();
  });
});

describe("create-note Markdown title heading and HTML route", () => {
  it("strips an exact duplicate title heading before the Shortcut import", async () => {
    vi.mocked(createMarkdownNote).mockReturnValueOnce({
      ok: true,
      id: "x-coredata://ABCDEF/ICNote/p5",
      title: "Plan",
      folder: undefined,
      account: "iCloud",
      contentHash: "sha256:created",
      verified: true,
    });
    const response = await createNote({
      title: "Plan",
      content: "# Plan\n\n## Goals",
      format: "markdown",
    });
    expect(createMarkdownNote).toHaveBeenCalledWith(manager, {
      title: "Plan",
      content: "## Goals",
      folder: undefined,
    });
    expect(response.structuredContent).toMatchObject({ strippedDuplicateTitle: true });
  });

  it("keeps a first heading that differs from the title", async () => {
    vi.mocked(createMarkdownNote).mockReturnValueOnce({ ok: true, id: "x" } as never);
    const response = await createNote({
      title: "Plan",
      content: "# plan\n\nbody",
      format: "markdown",
    });
    expect(vi.mocked(createMarkdownNote).mock.calls[0][1].content).toBe("# plan\n\nbody");
    expect(response.structuredContent).not.toHaveProperty("strippedDuplicateTitle");
  });

  it("refuses Markdown that holds only the title heading", async () => {
    const response = await createNote({ title: "Plan", content: "# Plan\n", format: "markdown" });
    expect(response.content[0].text).toMatch(/only the title heading/);
    expect(createMarkdownNote).not.toHaveBeenCalled();
  });

  it("creates through AppleScript HTML with visible task glyphs on the html route", async () => {
    created();
    const response = await createNote({
      title: "Plan",
      content: "# Plan\n\n## Goals\n- [ ] draft\n- [x] **review**\n- plain",
      format: "markdown",
      markdownRoute: "html",
      account: "Work",
      tags: ["kept"],
    });
    expect(response.isError).toBeUndefined();
    expect(manager.createNote).toHaveBeenCalledWith(
      "Plan",
      "<h2>Goals</h2><ul><li>☐ draft</li><li>☑ <b>review</b></li><li>plain</li></ul>",
      ["kept"],
      undefined,
      "Work",
      "html"
    );
    expect(requireValidated).not.toHaveBeenCalled();
    expect(createMarkdownNote).not.toHaveBeenCalled();
    expect(response.structuredContent).toMatchObject({
      ok: true,
      verified: true,
      taskItemsRendered: 2,
      strippedDuplicateTitle: true,
    });
    expect(response.content[0].text).toMatch(/2 task item\(s\) were rendered as visible/);
  });
});

describe("per-call timeoutSeconds", () => {
  it("scopes the override to the automation steps of one call", async () => {
    const seen: Array<number | undefined> = [];
    manager.createNote.mockImplementationOnce(() => {
      seen.push(callTimeoutMs());
      return { id: "x-coredata://ABCDEF/ICNote/p6", title: "Plan" };
    });
    manager.getNoteById.mockReturnValueOnce({ id: "x-coredata://ABCDEF/ICNote/p6", title: "P" });
    manager.getNoteContentById.mockReturnValueOnce("<div>Plan</div>");
    await createNote({ title: "Plan", content: "x", timeoutSeconds: 7 });
    expect(seen).toEqual([7000]);
    expect(callTimeoutMs()).toBeUndefined();
  });

  it("is advertised on every public note write", () => {
    for (const name of [
      "create-note",
      "update-note",
      "append-to-note",
      "delete-note",
      "move-note",
    ]) {
      const config = configs.get(name) as {
        inputSchema: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
      };
      expect(config.inputSchema.timeoutSeconds.safeParse(120).success).toBe(true);
      expect(config.inputSchema.timeoutSeconds.safeParse(0).success).toBe(false);
      expect(config.inputSchema.timeoutSeconds.safeParse(121).success).toBe(false);
      expect(config.inputSchema.timeoutSeconds.safeParse(1.5).success).toBe(false);
    }
  });
});

describe("delete-note placement check", () => {
  it("reports a delete that left the note in its folder as not deleted", async () => {
    const id = "x-coredata://ABCDEF/ICNote/p7";
    manager.getNoteById.mockReturnValueOnce({ id, title: "Plan" });
    manager.getNoteContentById.mockReturnValueOnce("<div>Plan</div>");
    manager.deleteNoteByIdIfUnchanged.mockReturnValueOnce({ status: "not-deleted" });
    const response = (await registered.get("delete-note")!({
      id,
      expectedContentHash: "sha256:plain",
    })) as Response;
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/still in its original folder.*Nothing was deleted/);
  });
});
