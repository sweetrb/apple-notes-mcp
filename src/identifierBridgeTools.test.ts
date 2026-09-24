/**
 * The identifier bridge as src/index.ts and the src/tools modules register it:
 * every note-id and folder-id input accepts a Notes UUID or numeric key and
 * hands the handler the x-coredata id, and list/read tools add stable
 * identifier fields when the database is readable.
 *
 * The NoteStore query is answered by a stubbed sqlite3 (the real SQL is
 * exercised against a fixture store in utils/noteIdentifiers.test.ts), so no
 * test here reads the live database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

type Config = { inputSchema?: Record<string, z.ZodTypeAny> };
type Callback = (args: unknown) => Promise<Response>;
type Response = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const registered = vi.hoisted(() => new Map<string, { config: Config; cb: Callback }>());
const sqlite = vi.hoisted(() => ({ mode: "ok" as "ok" | "no_fda", calls: [] as string[] }));
const manager = vi.hoisted(() => ({
  getNoteById: vi.fn(),
  listNoteRefs: vi.fn(),
  listNoteRefsDetailed: vi.fn(),
  listFolders: vi.fn(),
  listAccounts: vi.fn(),
}));

const STORE = "11111111-2222-3333-4444-555555555555";
const NOTE_UUID = "CCCCCCCC-0000-0000-0000-000000000042";
const FOLDER_UUID = "BBBBBBBB-0000-0000-0000-000000000042";
const ACCOUNT_UUID = "AAAAAAAA-0000-0000-0000-000000000042";
const PARENT_UUID = "BBBBBBBB-0000-0000-0000-000000000001";
const NOTE_ID = `x-coredata://${STORE}/ICNote/p42`;
const FOLDER_ID = `x-coredata://${STORE}/ICFolder/p42`;

vi.mock(import("child_process"), async (importOriginal) => {
  const original = await importOriginal();
  const execFileSync = ((file: string, args: string[], options: unknown) => {
    const sql = Array.isArray(args) ? String(args[args.length - 1]) : "";
    if (file === "sqlite3" && args?.[0] === "-readonly" && sql.includes("Z_METADATA")) {
      sqlite.calls.push(sql);
      if (sqlite.mode === "no_fda") throw new Error("Error: unable to open database file");
      const entity = /Z_NAME = '(\w+)'/.exec(sql)?.[1];
      const identifier = entity === "ICFolder" ? FOLDER_UUID : NOTE_UUID;
      return JSON.stringify({
        store: STORE,
        rows: [
          {
            pk: 42,
            identifier,
            folderIdentifier: FOLDER_UUID,
            parentIdentifier: PARENT_UUID,
            accountIdentifier: ACCOUNT_UUID,
          },
        ],
      });
    }
    return (original.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
  }) as typeof original.execFileSync;
  return { ...original, execFileSync, default: { ...original, execFileSync } };
});
vi.mock(import("fs"), async (importOriginal) => {
  const original = await importOriginal();
  const existsSync = ((p: string) =>
    String(p).endsWith("NoteStore.sqlite") || original.existsSync(p)) as typeof original.existsSync;
  return { ...original, existsSync, default: { ...original, existsSync } };
});
vi.mock(import("@modelcontextprotocol/sdk/server/mcp.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn((name: string, config: Config, cb: Callback) =>
        registered.set(name, { config, cb })
      ),
      resource: vi.fn(),
      prompt: vi.fn(),
      connect: vi.fn(async () => undefined),
    };
  }) as never,
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));
vi.mock("@/utils/jsonSchemaDialect.js", () => ({ withJsonSchema2020_12: (t: unknown) => t }));
vi.mock("@/services/fileConfig.js", () => ({ loadFileConfig: vi.fn() }));
vi.mock("@/utils/syncDetection.js", () => ({
  getSyncStatus: vi.fn(() => ({ syncDetected: false })),
  withSyncAwarenessSync: vi.fn((_op: string, fn: () => unknown) => ({
    result: fn(),
    syncBefore: { syncDetected: false },
    syncInterference: false,
  })),
}));
vi.mock(import("@/services/appleNotesManager.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  AppleNotesManager: vi.fn().mockImplementation(function () {
    return manager;
  }) as never,
}));

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
  sqlite.mode = "ok";
  sqlite.calls = [];
});

const field = (tool: string, name: string): z.ZodTypeAny => {
  const schema = registered.get(tool)?.config.inputSchema?.[name];
  if (!schema) throw new Error(`${tool} has no input field ${name}`);
  return schema;
};

/** Tools whose single note-id field is strict (validated shape) today. */
const STRICT_NOTE_ID: Array<[string, string]> = [
  ["get-native-objects", "id"],
  ["get-note-blocks", "id"],
  ["list-note-paragraphs", "id"],
  ["get-paragraph-link", "id"],
  ["get-note-structure", "id"],
  ["list-note-links", "id"],
  ["get-note-tables", "id"],
  ["get-audio-transcripts", "id"],
  ["get-note-drawings", "id"],
  ["transcribe-note-audio", "id"],
  ["export-notes-markdown", "id"],
  ["export-notes-html", "id"],
  ["export-attachments", "noteId"],
  ["list-paper-attachments", "id"],
  ["export-paper-image", "noteId"],
  ["update-note", "id"],
  ["append-to-note", "id"],
  ["delete-note", "id"],
  ["move-note", "id"],
  ["append-native", "id"],
  ["create-checklist-item", "id"],
  ["create-checklist-items", "id"],
  ["create-table", "id"],
  ["set-note-pinned", "id"],
  ["remove-native-tags", "id"],
  ["insert-note-link", "id"],
  ["insert-note-link", "linkedNoteId"],
  ["insert-link", "id"],
  ["add-native-tags", "id"],
  ["add-attachment", "id"],
  ["add-attachment-from-pasteboard", "id"],
];
/** Tools whose note-id field was free-form (title-or-id tools and friends). */
const LOOSE_NOTE_ID: Array<[string, string]> = [
  ["get-note-content", "id"],
  ["get-note-plaintext", "id"],
  ["get-note-by-id", "id"],
  ["show-note", "id"],
  ["get-note-link", "id"],
  ["list-attachments", "id"],
  ["save-attachment", "noteId"],
  ["fetch-attachment", "noteId"],
  ["show-attachment", "noteId"],
  ["get-note-markdown", "id"],
  ["get-checklist-state", "id"],
  ["get-note-metadata", "id"],
];
const FOLDER_ID_FIELDS: Array<[string, string]> = [
  ["show-folder", "id"],
  ["get-folder-by-id", "id"],
  ["rename-folder", "id"],
  ["delete-folder-by-id", "id"],
  ["delete-folder-by-id", "expectedParentId"],
];

describe("id inputs accept Notes UUIDs and numeric keys", () => {
  it.each([...STRICT_NOTE_ID, ...LOOSE_NOTE_ID])(
    "%s.%s resolves a UUID and a numeric key",
    (tool, name) => {
      const schema = field(tool, name);
      expect(schema.parse(NOTE_UUID)).toBe(NOTE_ID);
      expect(schema.parse("42")).toBe(NOTE_ID);
    }
  );

  it.each([...STRICT_NOTE_ID, ...LOOSE_NOTE_ID])(
    "%s.%s passes an x-coredata id through without a database read",
    (tool, name) => {
      expect(field(tool, name).parse(NOTE_ID)).toBe(NOTE_ID);
      expect(sqlite.calls).toEqual([]);
    }
  );

  it.each(STRICT_NOTE_ID)("%s.%s still rejects a malformed id", (tool, name) => {
    expect(field(tool, name).safeParse("p42").success).toBe(false);
    expect(field(tool, name).safeParse("Meeting notes").success).toBe(false);
  });

  it.each(LOOSE_NOTE_ID)("%s.%s still passes other values through unchanged", (tool, name) => {
    expect(field(tool, name).parse("some legacy value")).toBe("some legacy value");
    expect(sqlite.calls).toEqual([]);
  });

  it.each(FOLDER_ID_FIELDS)("%s.%s resolves folder UUIDs and keys", (tool, name) => {
    expect(field(tool, name).parse(FOLDER_UUID)).toBe(FOLDER_ID);
    expect(field(tool, name).parse("42")).toBe(FOLDER_ID);
    expect(sqlite.calls.every((sql) => sql.includes("Z_NAME = 'ICFolder'"))).toBe(true);
  });

  it("resolves note lookups against the ICNote entity only", () => {
    field("get-note-by-id", "id").parse("42");
    expect(sqlite.calls).toHaveLength(1);
    expect(sqlite.calls[0]).toContain("Z_NAME = 'ICNote'");
  });

  it("resolves nested batch entries and a whole id array", () => {
    const deleteNotes = field("batch-delete-notes", "notes");
    const hash = `sha256:${"a".repeat(64)}`;
    expect(deleteNotes.parse([{ id: NOTE_UUID, expectedContentHash: hash }])).toEqual([
      { id: NOTE_ID, expectedContentHash: hash },
    ]);
    sqlite.calls = [];
    expect(field("batch-move-notes", "ids").parse([NOTE_UUID, "42", NOTE_ID])).toEqual([
      NOTE_ID,
      NOTE_ID,
      NOTE_ID,
    ]);
    expect(sqlite.calls).toHaveLength(1);
    const replace = field("replace-native-tag", "notes");
    expect(
      replace.parse([{ id: "42", expectedContentHash: hash, scopeText: "a distinctive phrase" }])
    ).toEqual([{ id: NOTE_ID, expectedContentHash: hash, scopeText: "a distinctive phrase" }]);
  });

  it("keeps the batch size limit", () => {
    const ids = Array.from({ length: 501 }, () => NOTE_ID);
    expect(field("batch-move-notes", "ids").safeParse(ids).success).toBe(false);
  });

  it("fails a UUID with a Full Disk Access message while x-coredata ids keep working", () => {
    sqlite.mode = "no_fda";
    const result = field("get-note-content", "id").safeParse(NOTE_UUID);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0].message).toMatch(/Full Disk Access/);
    expect(field("get-note-content", "id").parse(NOTE_ID)).toBe(NOTE_ID);
  });

  it("covers every registered note or folder id field", () => {
    const covered = new Set(
      [...STRICT_NOTE_ID, ...LOOSE_NOTE_ID, ...FOLDER_ID_FIELDS].map(([t, f]) => `${t}.${f}`)
    );
    covered.add("batch-delete-notes.notes").add("batch-move-notes.ids");
    covered.add("replace-native-tag.notes");
    // show-account takes an account id, which the bridge does not resolve.
    // The private-helper tools take a Notes UUID in their own `identifier`
    // field, so their `id` field is x-coredata only and needs no bridge.
    const exempt = new Set(["show-account.id", "native-note-state.id"]);
    const idFields: string[] = [];
    for (const [tool, { config }] of registered) {
      for (const name of Object.keys(config.inputSchema ?? {})) {
        if (/^(id|ids|noteId|linkedNoteId)$/.test(name)) idFields.push(`${tool}.${name}`);
      }
    }
    expect(idFields.length).toBeGreaterThan(25);
    expect(idFields.filter((f) => !covered.has(f) && !exempt.has(f))).toEqual([]);
  });
});

describe("list and read tools add stable identifiers", () => {
  const note = {
    id: NOTE_ID,
    title: "t",
    created: new Date(0),
    modified: new Date(0),
    shared: false,
    passwordProtected: false,
  };

  it("get-note-by-id adds the note, folder, and account UUIDs", async () => {
    manager.getNoteById.mockReturnValue(note);
    const response = await registered.get("get-note-by-id")!.cb({ id: NOTE_ID });
    expect(response.structuredContent).toMatchObject({
      id: NOTE_ID,
      identifier: NOTE_UUID,
      folderIdentifier: FOLDER_UUID,
      accountIdentifier: ACCOUNT_UUID,
    });
  });

  it("list-notes enriches every row with one batched query", async () => {
    manager.listNoteRefsDetailed.mockReturnValue({
      refs: [
        { title: "a", id: NOTE_ID },
        { title: "b", id: `x-coredata://${STORE}/ICNote/p7` },
      ],
      excludedRecentlyDeleted: 0,
    });
    const response = await registered.get("list-notes")!.cb({});
    const notes = response.structuredContent?.notes as Array<Record<string, unknown>>;
    expect(notes[0]).toMatchObject({ id: NOTE_ID, identifier: NOTE_UUID });
    expect(notes[1]).toEqual({ title: "b", id: `x-coredata://${STORE}/ICNote/p7` });
    expect(sqlite.calls).toHaveLength(1);
  });

  it("list-folders adds folder, parent, and account UUIDs", async () => {
    manager.listFolders.mockReturnValue([{ id: FOLDER_ID, name: "f", account: "a" }]);
    const response = await registered.get("list-folders")!.cb({});
    const folders = response.structuredContent?.folders as Array<Record<string, unknown>>;
    expect(folders[0]).toMatchObject({
      identifier: FOLDER_UUID,
      parentIdentifier: PARENT_UUID,
      accountIdentifier: ACCOUNT_UUID,
    });
  });

  it("returns the same rows unchanged when the database is unreadable", async () => {
    sqlite.mode = "no_fda";
    const rows = [{ title: "a", id: NOTE_ID }];
    manager.listNoteRefsDetailed.mockReturnValue({ refs: rows, excludedRecentlyDeleted: 0 });
    const response = await registered.get("list-notes")!.cb({});
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent?.notes).toEqual(rows);
  });
});
