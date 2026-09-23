/**
 * Read-only SQL plumbing, exercised through the real /usr/bin/sqlite3 against
 * a throwaway fixture database. The live NoteStore is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entity,
  NoteStoreError,
  notePrimaryKey,
  objectColumns,
  parseJsonLine,
  runStoreSql,
  schemaHelpers,
} from "./noteStoreSql.js";

let dir: string;
let db: string;
let empty: string;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof NoteStoreError ? error.code : String(error);
  }
  return "no error";
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-store-sql-"));
  db = join(dir, "NoteStore.sqlite");
  empty = join(dir, "Empty.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    db,
    "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZTITLE1 TEXT, ZACCOUNT7 INTEGER, ZACCOUNT INTEGER);" +
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);" +
      "INSERT INTO Z_PRIMARYKEY VALUES (3, 'ICNote');" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 3, 'one', NULL, 5), (2, 3, 'two', 6, NULL);",
  ]);
  execFileSync("/usr/bin/sqlite3", [empty, "CREATE TABLE other (x);"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("notePrimaryKey", () => {
  it("accepts canonical note ids only", () => {
    expect(notePrimaryKey("x-coredata://ABC-123/ICNote/p42")).toBe(42);
    expect(code(() => notePrimaryKey("x-coredata://ABC/ICNote/p1;DROP"))).toBe("invalid-id");
    expect(code(() => notePrimaryKey("x-coredata://ABC/ICFolder/p1"))).toBe("invalid-id");
  });
});

describe("runStoreSql", () => {
  it("binds integer parameters and returns one line per statement", () => {
    const lines = runStoreSql(
      db,
      "SELECT ZTITLE1 FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = @pk; SELECT @pk + @other;",
      { pk: 2, other: 40 }
    );
    expect(lines).toEqual(["two", "42"]);
  });

  it("rejects non-integer values and unsafe parameter names", () => {
    expect(code(() => runStoreSql(db, "SELECT 1;", { pk: 1.5 }))).toBe("invalid-argument");
    expect(code(() => runStoreSql(db, "SELECT 1;", { "pk 1": 1 }))).toBe("invalid-argument");
  });

  it("classifies unreadable databases and failing SQL", () => {
    expect(code(() => runStoreSql(join(dir, "missing", "x.sqlite"), "SELECT 1;"))).toBe(
      "no-full-disk-access"
    );
    expect(code(() => runStoreSql(db, "SELECT * FROM no_such_table;"))).toBe("query-failed");
  });

  it("opens the database read-only", () => {
    expect(code(() => runStoreSql(db, "DELETE FROM ZICCLOUDSYNCINGOBJECT;"))).toBe("query-failed");
    expect(runStoreSql(db, "SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT;")).toEqual(["2"]);
  });
});

describe("parseJsonLine", () => {
  it("parses JSON, falls back on empty input and rejects garbage", () => {
    expect(parseJsonLine('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJsonLine(undefined, [])).toEqual([]);
    expect(parseJsonLine("", 7)).toBe(7);
    expect(code(() => parseJsonLine("{nope", null))).toBe("query-failed");
  });
});

describe("objectColumns and schemaHelpers", () => {
  it("lists object-table columns and refuses a store without one", () => {
    const columns = objectColumns(db);
    expect(columns.has("ZTITLE1")).toBe(true);
    expect(code(() => objectColumns(empty))).toBe("unsupported-schema");
  });

  it("builds column, account and deletion expressions from the schema", () => {
    const { col, accountOf, notDeleted, has } = schemaHelpers(objectColumns(db));
    expect(col("n", "ZTITLE1")).toBe("n.ZTITLE1");
    expect(col("n", "ZMISSING")).toBe("NULL");
    expect(has("ZACCOUNT7")).toBe(true);
    expect(accountOf("n")).toBe("COALESCE(n.ZACCOUNT, n.ZACCOUNT7)");
    expect(notDeleted("n")).toBe("COALESCE(NULL, 0) = 0");
    const rows = runStoreSql(
      db,
      `SELECT group_concat(${accountOf("n")}) FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_ENT = ${entity("ICNote")} AND ${notDeleted("n")};`
    );
    expect(rows).toEqual(["5,6"]);
    expect(schemaHelpers(new Set(["Z_PK"])).accountOf("n")).toBe("NULL");
  });

  it("only builds entity lookups for Core Data class names", () => {
    expect(entity("ICNote")).toContain("Z_NAME = 'ICNote'");
    expect(code(() => entity("ICNote' OR 1=1 --"))).toBe("invalid-argument");
  });
});
