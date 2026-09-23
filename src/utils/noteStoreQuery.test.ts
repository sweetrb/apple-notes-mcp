import { afterAll, describe, expect, it } from "vitest";
import { CodedError } from "./errorCodes.js";
import { createNoteStoreFixture } from "./fixtures/noteStoreFixture.js";
import {
  assertNoteReadable,
  NOTE_STATE_SQL,
  parseNoteObjectId,
  queryNoteScoped,
} from "./noteStoreQuery.js";
import { NoteStoreError } from "./noteStoreSql.js";

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
    expect(() => parseNoteObjectId(id)).toThrow(NoteStoreError);
  });
});

describe("queryNoteScoped (real sqlite3, fixture database)", () => {
  it("binds the note key instead of splicing it into SQL", () => {
    expect(NOTE_STATE_SQL).toContain("@pk");
    const [line] = queryNoteScoped(NOTE_STATE_SQL, 10, fixture.dbPath);
    expect(JSON.parse(line)).toEqual({ found: 1, locked: 0 });
  });

  it("treats a non-note row with the same key as not found", () => {
    const [line] = queryNoteScoped(NOTE_STATE_SQL, 12, fixture.dbPath);
    expect(JSON.parse(line).found).toBe(0);
  });

  it("reports a locked note", () => {
    const [line] = queryNoteScoped(NOTE_STATE_SQL, 11, fixture.dbPath);
    expect(JSON.parse(line)).toEqual({ found: 1, locked: 1 });
  });

  it("refuses a key that is not an integer", () => {
    expect(() => queryNoteScoped(NOTE_STATE_SQL, 1.5, fixture.dbPath)).toThrow(NoteStoreError);
  });

  it("classifies a missing database as missing Full Disk Access", () => {
    let error: unknown;
    try {
      queryNoteScoped("SELECT 1;", 1, "/nonexistent-dir/NoteStore.sqlite");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NoteStoreError);
    expect((error as NoteStoreError).kind).toBe("no_fda");
  });
});

describe("assertNoteReadable", () => {
  it("accepts a found, unlocked note", () => {
    expect(() => assertNoteReadable('{"found":1,"locked":0}', NOTE)).not.toThrow();
  });

  it("throws coded not_found and unsupported errors, and a query error for bad output", () => {
    const outcome = (line: string | undefined) => {
      try {
        assertNoteReadable(line, NOTE);
      } catch (e) {
        if (e instanceof CodedError) return e.envelope.code;
        if (e instanceof NoteStoreError) return e.kind;
        return "other";
      }
      return "none";
    };
    expect(outcome('{"found":0,"locked":null}')).toBe("not_found");
    expect(outcome(undefined)).toBe("not_found");
    expect(outcome('{"found":1,"locked":1}')).toBe("unsupported");
    expect(outcome("not json")).toBe("query_error");
  });
});
