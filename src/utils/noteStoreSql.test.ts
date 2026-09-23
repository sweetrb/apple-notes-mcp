/**
 * Tests for the shared read-only NoteStore helpers. sqlite3 runs for real
 * against throwaway databases; nothing here touches the live store.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  accountRef,
  activeNoteSql,
  col,
  coreDataToIso,
  doubleToHex,
  entity,
  folderPaths,
  hexToDouble,
  noteIdFor,
  NoteStoreError,
  parseJsonLines,
  readColumns,
  readStoreContext,
  requireColumns,
  resolveAccountName,
  runReadOnlySql,
  trashFolderSql,
  type StoreFolder,
} from "./noteStoreSql.js";

let dir: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-store-sql-"));
  db = join(dir, "store.sqlite");
  execFileSync("sqlite3", [db], {
    input: [
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT);",
      "INSERT INTO Z_PRIMARYKEY VALUES (7, 'ICAccount'), (8, 'ICFolder');",
      "CREATE TABLE Z_METADATA (Z_UUID TEXT);",
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZNAME TEXT, ZACCOUNT3 INTEGER, ZTITLE2 TEXT, ZPARENT INTEGER, ZMODIFICATIONDATE1 REAL);",
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 7, NULL, NULL, NULL, NULL, NULL);",
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (2, 8, NULL, 1, 'Loose', NULL, 801234567.1234567);",
    ].join("\n"),
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("double bits", () => {
  it("round-trips exact doubles through 16 hex digits", () => {
    for (const value of [0, -0.5, 801234567.1234567, 1 / 3, Number.MIN_VALUE, -1e300]) {
      expect(Object.is(hexToDouble(doubleToHex(value)), value)).toBe(true);
    }
    expect(doubleToHex(1)).toBe("3ff0000000000000");
  });

  it("rejects non-finite values and malformed hex", () => {
    expect(() => doubleToHex(Infinity)).toThrow(NoteStoreError);
    expect(() => hexToDouble("3ff")).toThrow(/Invalid double bits/);
    expect(() => hexToDouble("7ff0000000000000")).toThrow(/Invalid double bits/);
  });
});

describe("runReadOnlySql", () => {
  it("binds integers, doubles, bit patterns and blobs as parameters", () => {
    const out = runReadOnlySql(
      db,
      "SELECT @i + 1, hex(ieee754_to_blob(@d)), hex(ieee754_to_blob(@b)), CAST(@t AS TEXT);",
      {
        i: { int: 41 },
        d: { double: 801234567.1234567 },
        b: { doubleBits: "3FF0000000000000" },
        t: { blob: Buffer.from("x'); DROP TABLE t; --") },
      }
    ).trim();
    expect(out).toBe(
      `42|${doubleToHex(801234567.1234567).toUpperCase()}|3FF0000000000000|x'); DROP TABLE t; --`
    );
  });

  it("compares a stored double exactly against bound bits", () => {
    const stored = runReadOnlySql(
      db,
      "SELECT hex(ieee754_to_blob(ZMODIFICATIONDATE1)) FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = 2;"
    ).trim();
    const count = (sql: string) => runReadOnlySql(db, sql, { c: { doubleBits: stored } }).trim();
    expect(count("SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZMODIFICATIONDATE1 = @c;")).toBe(
      "1"
    );
    expect(count("SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZMODIFICATIONDATE1 > @c;")).toBe(
      "0"
    );
  });

  it("refuses unsafe parameter names and integers", () => {
    expect(() => runReadOnlySql(db, "SELECT 1;", { "a b": { int: 1 } })).toThrow(/parameter name/);
    expect(() => runReadOnlySql(db, "SELECT 1;", { a: { int: 2 ** 60 } })).toThrow(/out of range/);
  });

  it("maps a missing or unopenable database to a Full Disk Access error", () => {
    expect(() => runReadOnlySql(join(dir, "missing.sqlite"), "SELECT 1;")).toThrow(
      /Full Disk Access/
    );
    try {
      runReadOnlySql(dir, "SELECT 1;");
      expect.unreachable();
    } catch (error) {
      expect((error as NoteStoreError).kind).toBe("no_fda");
    }
  });

  it("maps other failures to a query error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => runReadOnlySql(db, "SELECT * FROM no_such_table;")).toThrow(
      /Failed to query the Notes database/
    );
    spy.mockRestore();
  });
});

describe("parseJsonLines", () => {
  it("skips blank lines and rejects non-JSON", () => {
    expect(parseJsonLines('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonLines("oops")).toThrow(/Unexpected Notes database response/);
  });
});

describe("schema helpers", () => {
  it("reads columns and checks required ones", () => {
    const columns = readColumns(db);
    expect(columns.has("ZACCOUNT3")).toBe(true);
    expect(() => requireColumns(columns, ["ZNOPE"], "a tool")).toThrow(/a tool needs \(ZNOPE\)/);
    expect(() => requireColumns(columns, ["Z_PK"], "a tool")).not.toThrow();
  });

  it("builds column, entity, account and trash fragments", () => {
    const columns = new Set(["ZACCOUNT2", "ZACCOUNT", "ZFOLDERTYPE"]);
    expect(col(columns, "n", "ZACCOUNT")).toBe("n.ZACCOUNT");
    expect(col(columns, "n", "ZMISSING", "0")).toBe("0");
    expect(entity("ICNote")).toContain("Z_NAME='ICNote'");
    expect(accountRef(columns, "n")).toBe("COALESCE(n.ZACCOUNT, n.ZACCOUNT2)");
    expect(accountRef(new Set(["ZACCOUNT9"]), "n")).toBe("n.ZACCOUNT9");
    expect(accountRef(new Set(), "n")).toBe("NULL");
    expect(trashFolderSql(columns, "f")).toBe("(COALESCE(f.ZFOLDERTYPE, 0) = 1)");
    expect(trashFolderSql(new Set(), "f")).toBe("0");
    expect(activeNoteSql(new Set(), "n", "f")).toBe(
      "n.ZFOLDER IS NOT NULL AND f.Z_PK IS NOT NULL AND 1 AND 1 AND NOT 0"
    );
  });

  it("reads store context with fallbacks for missing columns", () => {
    execFileSync("sqlite3", [db, "INSERT INTO Z_METADATA VALUES ('STORE');"]);
    const context = readStoreContext(db, readColumns(db));
    expect(context.uuid).toBe("STORE");
    expect(context.accounts).toEqual([{ pk: 1, name: "", identifier: null }]);
    expect(context.folders).toEqual([
      {
        pk: 2,
        name: "Loose",
        identifier: null,
        parent: null,
        account: 1,
        folderType: null,
        trash: 0,
        tombstoned: 0,
      },
    ]);
  });

  it("fails without a store identifier", () => {
    const empty = join(dir, "empty.sqlite");
    execFileSync("sqlite3", [
      empty,
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT, Z_NAME); CREATE TABLE Z_METADATA (Z_UUID); CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT);",
    ]);
    expect(() => readStoreContext(empty, readColumns(empty))).toThrow(/no store identifier/);
  });
});

describe("formatting helpers", () => {
  it("converts Core Data seconds to ISO", () => {
    expect(coreDataToIso(0)).toBe("2001-01-01T00:00:00.000Z");
    expect(coreDataToIso(null)).toBeNull();
    expect(coreDataToIso(Number.NaN)).toBeNull();
    expect(coreDataToIso(1e20)).toBeNull();
  });

  it("formats note ids", () => {
    expect(noteIdFor("U", 5)).toBe("x-coredata://U/ICNote/p5");
  });

  it("builds escaped folder paths and survives cycles and missing parents", () => {
    const f = (pk: number, name: string | null, parent: number | null): StoreFolder => ({
      pk,
      name,
      parent,
      identifier: null,
      account: null,
      folderType: null,
      trash: 0,
      tombstoned: 0,
    });
    const paths = folderPaths([
      f(1, "Top", null),
      f(2, "a/b", 1),
      f(3, "Loop", 4),
      f(4, "Back", 3),
      f(5, null, 99),
    ]);
    expect(paths.get(2)).toBe("Top/a\\/b");
    expect(paths.get(3)).toBe("Back/Loop");
    expect(paths.get(5)).toBe("");
  });
});

describe("resolveAccountName", () => {
  const accounts = [
    { pk: 1, name: "iCloud", identifier: null },
    { pk: 2, name: "Work", identifier: null },
    { pk: 3, name: "Workshop", identifier: null },
  ];
  it("prefers exact case-insensitive matches, then unique prefixes", () => {
    expect(resolveAccountName(accounts, " work ").pk).toBe(2);
    expect(resolveAccountName(accounts, "ic").pk).toBe(1);
  });
  it("rejects ambiguous and unknown names", () => {
    expect(() => resolveAccountName(accounts, "wo")).toThrow(/ambiguous/);
    expect(() => resolveAccountName(accounts, "gmail")).toThrow(/No account named/);
    expect(() =>
      resolveAccountName([...accounts, { pk: 4, name: "WORK", identifier: null }], "work")
    ).toThrow(/ambiguous/);
  });
});
