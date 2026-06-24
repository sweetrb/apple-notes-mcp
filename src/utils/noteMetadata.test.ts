/**
 * Tests for the read-only note metadata reader.
 *
 * The NoteStore SQLite access is mocked, so these exercise the pk extraction,
 * column feature-detection, JSON parsing, boolean coercion, and error
 * classification without touching a real database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { getNoteMetadata } from "./noteMetadata.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);

const NOTE_ID = "x-coredata://ABC/ICNote/p123";

/** Builds a PRAGMA table_info dump from a list of column names. */
function tableInfo(columns: string[]): string {
  return columns.map((name, i) => `${i}|${name}|INTEGER|0||0`).join("\n");
}

/** The query string is the third sqlite3 argument: [-readonly, dbPath, query]. */
function queryOf(call: unknown[]): string {
  const args = call[1] as string[];
  return args[2];
}

describe("getNoteMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it("rejects a malformed note id without touching the database", () => {
    const result = getNoteMetadata("not-a-real-id");

    expect(result.metadata).toBeNull();
    expect(result.error).toBe("invalid_id");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("reads pinned/checklist/snippet and coerces 0/1 to booleans", () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const query = (args as string[])[2];
      if (query.includes("table_info")) {
        return tableInfo(["Z_PK", "ZISPINNED", "ZHASCHECKLIST", "ZSNIPPET", "ZPASSWORDHINT"]);
      }
      return JSON.stringify({
        pinned: 1,
        hasChecklist: 0,
        snippet: "Hello world",
        passwordHint: null,
      });
    });

    const result = getNoteMetadata(NOTE_ID);

    expect(result.error).toBeUndefined();
    expect(result.metadata).toEqual({
      pinned: true,
      hasChecklist: false,
      snippet: "Hello world",
    });
    // A NULL column (passwordHint) is omitted, not included as null.
    expect(result.metadata).not.toHaveProperty("passwordHint");
  });

  it("only selects columns that exist on this schema", () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const query = (args as string[])[2];
      if (query.includes("table_info")) return tableInfo(["Z_PK", "ZISPINNED"]);
      return JSON.stringify({ pinned: 1 });
    });

    const result = getNoteMetadata(NOTE_ID);

    expect(result.metadata).toEqual({ pinned: true });
    // The SELECT must not reference a column the schema lacks.
    const selectCall = mockExecFileSync.mock.calls.find((c) => queryOf(c).includes("json_object"));
    expect(selectCall).toBeDefined();
    expect(queryOf(selectCall as unknown[])).toContain("ZISPINNED");
    expect(queryOf(selectCall as unknown[])).not.toContain("ZSNIPPET");
  });

  it("returns not_found when no row matches the primary key", () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const query = (args as string[])[2];
      if (query.includes("table_info")) return tableInfo(["Z_PK", "ZISPINNED"]);
      return "";
    });

    const result = getNoteMetadata(NOTE_ID);

    expect(result.metadata).toBeNull();
    expect(result.error).toBe("not_found");
  });

  it("classifies a Full Disk Access denial", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("Error: authorization denied");
    });

    const result = getNoteMetadata(NOTE_ID);

    expect(result.metadata).toBeNull();
    expect(result.error).toBe("no_fda");
    expect(result.message).toContain("Full Disk Access");
  });

  it("returns no_fda when the database file is missing", () => {
    mockExistsSync.mockReturnValue(false);

    const result = getNoteMetadata(NOTE_ID);

    expect(result.metadata).toBeNull();
    expect(result.error).toBe("no_fda");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
