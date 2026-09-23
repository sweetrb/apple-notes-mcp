/**
 * delete-note's copy-then-retire guard (guardNoteId, expectedGuardContentHash,
 * requireActiveNoteId), driven through the handler src/index.ts registers.
 * The manager and the database read are mocked; the manager's own tests
 * cover the generated AppleScript.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const configs = vi.hoisted(() => new Map<string, unknown>());
const manager = vi.hoisted(() => {
  const m = {
    getNoteById: vi.fn(),
    getNoteContentById: vi.fn(),
    deleteNoteByIdIfUnchanged: vi.fn(),
    // readNoteBodyById is the error-keeping form of getNoteContentById (#237).
    readNoteBodyById: vi.fn((id: string) => ({ body: m.getNoteContentById(id) ?? "" })),
  };
  return m;
});
const quickNoteFlag = vi.hoisted(() => vi.fn());

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
vi.mock(import("@/utils/noteListings.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  quickNoteFlag,
}));
vi.mock("@/utils/noteRichText.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/noteRichText.js")>()),
  enrichNoteRead: vi.fn(() => ({})),
  richContentHash: vi.fn((body: string) => `hash:${body}`),
}));

import { NoteStoreError, STORE_FDA_MESSAGE } from "@/utils/noteStoreSql.js";

type Response = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const deleteNote = (args: Record<string, unknown>) =>
  registered.get("delete-note")!(args) as Promise<Response>;

const ORIGINAL = "x-coredata://ABCDEF/ICNote/p10";
const COPY = "x-coredata://ABCDEF/ICNote/p11";
const OTHER = "x-coredata://ABCDEF/ICNote/p12";
const BODIES: Record<string, string> = {
  [ORIGINAL]: "<div>Original</div>",
  [COPY]: "<div>Copy</div>",
  [OTHER]: "<div>Other</div>",
};

beforeAll(async () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  const stdinOn = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
  await import("@/index.js");
  on.mockRestore();
  stdinOn.mockRestore();
});
afterAll(() => registered.clear());
beforeEach(() => {
  vi.clearAllMocks();
  manager.getNoteById.mockImplementation((id: string) =>
    BODIES[id] ? { id, title: `Synthetic ${id.slice(-3)}` } : null
  );
  manager.getNoteContentById.mockImplementation((id: string) => BODIES[id] ?? "");
  manager.deleteNoteByIdIfUnchanged.mockReturnValue({ status: "deleted" });
  quickNoteFlag.mockReturnValue(false);
});

const guarded = (extra: Record<string, unknown> = {}) =>
  deleteNote({
    id: ORIGINAL,
    expectedContentHash: `hash:${BODIES[ORIGINAL]}`,
    guardNoteId: COPY,
    expectedGuardContentHash: `hash:${BODIES[COPY]}`,
    ...extra,
  });

describe("delete-note copy-then-retire guard", () => {
  it("retires the original while the verified copy is intact", async () => {
    const response = await guarded();
    expect(response.isError).toBeUndefined();
    expect(quickNoteFlag).toHaveBeenCalledWith(COPY);
    expect(manager.deleteNoteByIdIfUnchanged).toHaveBeenCalledWith(
      ORIGINAL,
      BODIES[ORIGINAL],
      expect.any(Object),
      [{ id: COPY, expectedBody: BODIES[COPY] }]
    );
    expect(response.structuredContent).toMatchObject({
      ok: true,
      id: ORIGINAL,
      guardNoteId: COPY,
      guardContentHash: `hash:${BODIES[COPY]}`,
    });
    expect(response.structuredContent).not.toHaveProperty("requireActiveNoteId");
  });

  it("lets a copy the database does not have yet pass on the live checks", async () => {
    quickNoteFlag.mockReturnValue(null);
    const response = await guarded();
    expect(response.isError).toBeUndefined();
    expect(manager.deleteNoteByIdIfUnchanged).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale guard revision without deleting", async () => {
    const response = await guarded({ expectedGuardContentHash: "hash:<div>Older copy</div>" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Guard note .* changed after it was read/);
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a Quick Note guard", async () => {
    quickNoteFlag.mockReturnValue(true);
    const response = await guarded();
    expect(response.content[0].text).toMatch(/Guard note is a Quick Note/);
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("says the guard needs Full Disk Access when the database is unreadable", async () => {
    quickNoteFlag.mockImplementation(() => {
      throw new NoteStoreError(STORE_FDA_MESSAGE, "no_fda");
    });
    const response = await guarded();
    expect(response.content[0].text).toMatch(/guard needs Full Disk Access.*Nothing was deleted/);
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses when the Quick Note check fails for another reason", async () => {
    quickNoteFlag.mockImplementation(() => {
      throw new Error("boom");
    });
    const response = await guarded();
    expect(response.content[0].text).toMatch(/Guard note could not be checked \(boom\)/);
    quickNoteFlag.mockImplementation(() => {
      throw "plain";
    });
    expect((await guarded()).content[0].text).toMatch(/could not be checked \(plain\)/);
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a missing guard note", async () => {
    manager.getNoteById.mockImplementation((id: string) =>
      id === COPY ? null : { id, title: "Synthetic" }
    );
    const response = await guarded();
    expect(response.content[0].text).toMatch(/Guard note: Note with ID .* not found/);
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("validates the guard arguments", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ expectedGuardContentHash: undefined }, /together/],
      [{ guardNoteId: ORIGINAL }, /different note/],
      [
        {
          guardNoteId: undefined,
          expectedGuardContentHash: undefined,
          requireActiveNoteId: ORIGINAL,
        },
        /different note/,
      ],
      [{ requireActiveNoteId: COPY }, /repeats guardNoteId/],
    ];
    for (const [extra, message] of cases) {
      const response = await guarded(extra);
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(message);
    }
    expect(quickNoteFlag).not.toHaveBeenCalled();
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });

  it("reports the in-script guard outcomes by label", async () => {
    manager.deleteNoteByIdIfUnchanged.mockReturnValueOnce({ status: "guard-conflict", index: 0 });
    expect((await guarded()).content[0].text).toMatch(
      /Guard note changed just before the delete\. Nothing was deleted/
    );
    manager.deleteNoteByIdIfUnchanged.mockReturnValueOnce({
      status: "guard-inactive",
      index: 1,
      reason: "in Recently Deleted",
    });
    expect((await guarded({ requireActiveNoteId: OTHER })).content[0].text).toMatch(
      /Required active note is no longer active \(in Recently Deleted\)\. Nothing was deleted/
    );
  });

  it("keeps main's Recently Deleted refusal for the note being deleted", async () => {
    manager.deleteNoteByIdIfUnchanged.mockReturnValueOnce({ status: "in-recently-deleted" });
    const response = await guarded();
    expect(response.content[0].text).toMatch(/already in Recently Deleted.*Nothing was deleted/);
  });
});

describe("delete-note requireActiveNoteId", () => {
  const withActive = () =>
    deleteNote({
      id: ORIGINAL,
      expectedContentHash: `hash:${BODIES[ORIGINAL]}`,
      requireActiveNoteId: OTHER,
    });

  it("requires the second note without fingerprinting it", async () => {
    const response = await withActive();
    expect(response.isError).toBeUndefined();
    expect(quickNoteFlag).toHaveBeenCalledWith(OTHER);
    expect(manager.getNoteContentById).not.toHaveBeenCalledWith(OTHER);
    expect(manager.deleteNoteByIdIfUnchanged).toHaveBeenCalledWith(
      ORIGINAL,
      BODIES[ORIGINAL],
      expect.any(Object),
      [{ id: OTHER }]
    );
    expect(response.structuredContent).toMatchObject({ requireActiveNoteId: OTHER });
    expect(response.structuredContent).not.toHaveProperty("guardNoteId");
  });

  it("refuses a Quick Note, a missing note, or a locked note", async () => {
    quickNoteFlag.mockReturnValueOnce(true);
    expect((await withActive()).content[0].text).toMatch(/Required active note is a Quick Note/);
    manager.getNoteById.mockImplementation((id: string) =>
      id === OTHER ? null : { id, title: "Synthetic" }
    );
    expect((await withActive()).content[0].text).toMatch(
      /Required active note with ID .* not found/
    );
    manager.getNoteById.mockImplementation((id: string) => ({
      id,
      title: "Synthetic",
      passwordProtected: id === OTHER,
    }));
    expect((await withActive()).content[0].text).toMatch(/password-protected/);
    expect(manager.deleteNoteByIdIfUnchanged).not.toHaveBeenCalled();
  });
});

describe("delete-note guard schema", () => {
  it("says the guard needs Full Disk Access and advertises the guard fields", () => {
    const config = configs.get("delete-note") as {
      description: string;
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
    };
    expect(config.description).toMatch(/Safety:.*guard needs Full Disk Access/s);
    for (const key of ["guardNoteId", "expectedGuardContentHash", "requireActiveNoteId"]) {
      expect(config.inputSchema).toHaveProperty(key);
    }
    for (const key of ["guardNoteId", "guardContentHash", "requireActiveNoteId"]) {
      expect((config.outputSchema as { shape: Record<string, unknown> }).shape).toHaveProperty(key);
    }
  });
});
