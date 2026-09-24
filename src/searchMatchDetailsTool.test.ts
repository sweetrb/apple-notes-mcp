/**
 * search-notes and query-notes as src/index.ts registers them, driven through
 * the registered callbacks: `includeWordCount` reaches the right data path,
 * AppleScript results are enriched by one batched database read (never per
 * note), and matchedIn/wordCount appear in both the text and structured output.
 *
 * The matching and counting logic itself runs against real fixture stores in
 * utils/noteQuery.test.ts, utils/noteQueryStore.test.ts, and
 * utils/searchContentDb.test.ts; here the database functions are stubbed so
 * no test reads the live NoteStore.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Response = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Callback = (args: unknown) => Promise<Response>;

const registered = vi.hoisted(() => new Map<string, Callback>());
const manager = vi.hoisted(() => ({
  searchNotes: vi.fn(),
  searchAccountScope: vi.fn((account?: string) => account),
}));
const db = vi.hoisted(() => ({
  searchContentViaDatabase: vi.fn(),
  addWordCountsFromDatabase: vi.fn(),
  queryNotes: vi.fn(),
}));

vi.mock(import("@modelcontextprotocol/sdk/server/mcp.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn((name: string, _config: unknown, cb: Callback) =>
        registered.set(name, cb)
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
vi.mock(import("@/utils/noteIdentifiers.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  withStableIdentifiers: vi.fn(<T>(items: T) => items),
}));
vi.mock(import("@/utils/searchContentDb.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  searchContentViaDatabase: db.searchContentViaDatabase,
  addWordCountsFromDatabase: db.addWordCountsFromDatabase,
}));
vi.mock(import("@/utils/noteQueryStore.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  queryNotes: db.queryNotes,
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
beforeEach(() => vi.clearAllMocks());

const call = (tool: string, args: Record<string, unknown>) => registered.get(tool)!(args);

const ID = "x-coredata://11111111-2222-3333-4444-555555555555/ICNote/p42";
const appleScriptHit = {
  id: ID,
  title: "Plan",
  folder: "Work",
  content: "",
  tags: [],
  created: new Date(0),
  modified: new Date(0),
};

describe("search-notes match details", () => {
  it("leaves AppleScript results alone without includeWordCount", async () => {
    manager.searchNotes.mockReturnValueOnce([appleScriptHit]);
    const response = await call("search-notes", { query: "plan" });
    expect(db.addWordCountsFromDatabase).not.toHaveBeenCalled();
    expect(response.content[0].text).toMatch(/- Plan \(Work\) \[id: [^\]]+\]$/m);
    expect(response.content[0].text).not.toContain(" · ");
    const [note] = response.structuredContent?.notes as Array<Record<string, unknown>>;
    expect(note).not.toHaveProperty("matchedIn");
    expect(note).not.toHaveProperty("wordCount");
  });

  it("enriches AppleScript title results with one batched database read", async () => {
    manager.searchNotes.mockReturnValueOnce([appleScriptHit]);
    db.addWordCountsFromDatabase.mockReturnValueOnce({
      notes: [{ ...appleScriptHit, matchedIn: ["title", "body"], wordCount: 12 }],
    });
    const response = await call("search-notes", { query: "plan", includeWordCount: true });
    expect(db.addWordCountsFromDatabase).toHaveBeenCalledTimes(1);
    expect(db.addWordCountsFromDatabase).toHaveBeenCalledWith([appleScriptHit], "plan");
    expect(response.content[0].text).toContain(
      `- Plan (Work) [id: ${ID}] · matched in title, body · 12 words`
    );
    expect(response.structuredContent?.notes).toEqual([
      expect.objectContaining({ matchedIn: ["title", "body"], wordCount: 12 }),
    ]);
    expect(response.structuredContent).not.toHaveProperty("wordCountUnavailable");
  });

  it("says why word counts are missing when the database cannot be read", async () => {
    manager.searchNotes.mockReturnValueOnce([appleScriptHit]);
    db.addWordCountsFromDatabase.mockReturnValueOnce({
      notes: [appleScriptHit],
      unavailable: "no_fda",
    });
    const response = await call("search-notes", { query: "plan", includeWordCount: true });
    expect(response.structuredContent?.wordCountUnavailable).toBe("no_fda");
    expect(response.content[0].text).toContain("Word counts were not added");
    expect(response.content[0].text).toContain("Full Disk Access");

    manager.searchNotes.mockReturnValueOnce([appleScriptHit]);
    db.addWordCountsFromDatabase.mockReturnValueOnce({
      notes: [appleScriptHit],
      unavailable: "schema",
    });
    const other = await call("search-notes", { query: "plan", includeWordCount: true });
    expect(other.content[0].text).toContain("the Notes database could not be read");
  });

  it("skips the extra read when nothing matched", async () => {
    manager.searchNotes.mockReturnValueOnce([]);
    await call("search-notes", { query: "zzz", includeWordCount: true });
    expect(db.addWordCountsFromDatabase).not.toHaveBeenCalled();
  });

  it("takes both fields from a database body search without a second read", async () => {
    db.searchContentViaDatabase.mockReturnValueOnce({
      notes: [{ ...appleScriptHit, matchedIn: ["body"], wordCount: 3 }],
      scan: { scanned: 1, eligible: 1, scanTruncated: false, matched: 1 },
    });
    const response = await call("search-notes", {
      query: "plan",
      searchContent: true,
      includeWordCount: true,
    });
    expect(db.searchContentViaDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ query: "plan", includeWordCount: true })
    );
    expect(db.addWordCountsFromDatabase).not.toHaveBeenCalled();
    expect(manager.searchNotes).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain("· matched in body · 3 words");
    expect(response.structuredContent).toMatchObject({ source: "database" });
  });
});

describe("query-notes match details", () => {
  it("passes includeWordCount through and renders matchedIn and wordCount", async () => {
    db.queryNotes.mockReturnValueOnce({
      notes: [
        { id: ID, title: "Plan", folder: "Work", snippet: "", matchedIn: ["title"], wordCount: 7 },
        { id: ID, title: "Locked", snippet: "", locked: true, wordCount: null },
      ],
      count: 2,
      matched: 2,
      scanned: 2,
      eligible: 2,
      scanLimit: 500,
      scanTruncated: false,
      limit: 50,
      truncated: false,
      unreadable: 0,
    });
    const response = await call("query-notes", { query: "title:plan", includeWordCount: true });
    expect(db.queryNotes).toHaveBeenCalledWith(
      "title:plan",
      expect.objectContaining({ includeWordCount: true })
    );
    const text = response.content[0].text;
    expect(text).toContain(`[id: ${ID}] · matched in title · 7 words`);
    expect(text).toContain("[locked] [id: " + ID + "] · word count unavailable");
    expect(response.structuredContent?.notes).toEqual([
      expect.objectContaining({ matchedIn: ["title"], wordCount: 7 }),
      expect.objectContaining({ wordCount: null }),
    ]);
  });
});
