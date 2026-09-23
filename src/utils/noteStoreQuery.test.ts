import { afterAll, describe, expect, it } from "vitest";
import { createNoteStoreFixture } from "./fixtures/noteStoreFixture.js";
import {
  assertNoteReadable,
  NOTE_STATE_SQL,
  NoteStoreReadError,
  parseNoteObjectId,
  queryNoteStore,
} from "./noteStoreQuery.js";

const fixture = createNoteStoreFixture([
  { pk: 10, ent: "ICNote" },
  { pk: 11, ent: "ICNote", locked: 1 },
  { pk: 12, ent: "ICAttachment", note: 10 },
]);
afterAll(() => fixture.cleanup());

const NOTE = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p10";

describe("parseNoteObjectId", () => {
  it("splits a note id into store and numeric key", () => {
    expect(parseNoteObjectId(NOTE)).toEqual({
      store: "ABCDEF01-2345-6789-ABCD-EF0123456789",
      pk: 10,
    });
  });

  it.each([
    "x-coredata://ABC/ICAttachment/p10",
    "x-coredata://ABC/ICNote/p10; DROP TABLE x",
    "x-coredata://ABC/ICNote/p",
    "p10",
  ])("rejects %s", (id) => {
    expect(() => parseNoteObjectId(id)).toThrow(NoteStoreReadError);
  });
});

describe("queryNoteStore (real sqlite3, fixture database)", () => {
  it("binds integer parameters instead of splicing them into SQL", () => {
    const [line] = queryNoteStore(NOTE_STATE_SQL, { pk: 10 }, fixture.dbPath);
    expect(JSON.parse(line)).toEqual({ found: 1, locked: 0 });
  });

  it("treats a non-note row with the same key as not found", () => {
    const [line] = queryNoteStore(NOTE_STATE_SQL, { pk: 12 }, fixture.dbPath);
    expect(JSON.parse(line).found).toBe(0);
  });

  it("reports a locked note", () => {
    const [line] = queryNoteStore(NOTE_STATE_SQL, { pk: 11 }, fixture.dbPath);
    expect(JSON.parse(line)).toEqual({ found: 1, locked: 1 });
  });

  it.each([
    [{ pk: -1 }],
    [{ pk: 1.5 }],
    [{ pk: Number.MAX_SAFE_INTEGER + 2 }],
    [{ "pk; .shell": 1 }],
  ])("refuses unsafe parameters %j", (params) => {
    expect(() => queryNoteStore(NOTE_STATE_SQL, params, fixture.dbPath)).toThrow(
      "Invalid query parameter"
    );
  });

  it("classifies an unopenable database as missing Full Disk Access", () => {
    let error: unknown;
    try {
      queryNoteStore("SELECT 1;", {}, "/nonexistent-dir/NoteStore.sqlite");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NoteStoreReadError);
    expect((error as NoteStoreReadError).kind).toBe("no_fda");
  });

  it("classifies other sqlite failures as query errors", () => {
    expect(() => queryNoteStore("SELECT * FROM no_such_table;", {}, fixture.dbPath)).toThrow(
      "Failed to read the Notes database."
    );
  });
});

describe("assertNoteReadable", () => {
  it("accepts a found, unlocked note", () => {
    expect(() => assertNoteReadable('{"found":1,"locked":0}', NOTE)).not.toThrow();
  });

  it("throws not_found, locked and query_error", () => {
    const kind = (line: string | undefined) => {
      try {
        assertNoteReadable(line, NOTE);
      } catch (e) {
        return (e as NoteStoreReadError).kind;
      }
      return "none";
    };
    expect(kind('{"found":0,"locked":null}')).toBe("not_found");
    expect(kind(undefined)).toBe("not_found");
    expect(kind('{"found":1,"locked":1}')).toBe("locked");
    expect(kind("not json")).toBe("query_error");
  });
});
