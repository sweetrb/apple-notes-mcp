/**
 * Note metadata for templated exports, against a real sqlite3 and a
 * throwaway fixture database. The generated SQL and the bound note key run
 * through the real /usr/bin/sqlite3 CLI; the live NoteStore is never touched.
 * All names are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteBlocksError } from "./noteBlocks.js";
import { coreDataDate, noteMetaQuery, readExportNoteMeta } from "./noteExportData.js";

let dir: string;
let db: string;
let bare: string;
const id = (pk: number | string) => `x-coredata://ABCDEF-1234/ICNote/p${pk}`;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof NoteBlocksError ? error.code : String(error);
  }
  return "no error";
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-export-meta-"));
  db = join(dir, "NoteStore.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    db,
    "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, " +
      "ZCREATIONDATE1 FLOAT, ZCREATIONDATE3 FLOAT, ZMODIFICATIONDATE1 FLOAT, ZFOLDER INTEGER, " +
      "ZTITLE2 TEXT, ZNAME TEXT, ZACCOUNT2 INTEGER, ZACCOUNT7 INTEGER);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZNAME) VALUES (1, 'Synthetic Account');" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZACCOUNT7) VALUES (2, 'Folder A', 1);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZCREATIONDATE1, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZFOLDER, ZACCOUNT7) " +
      "VALUES (10, 'NOTE-UUID', 5, 0, 86400.5, 2, 1), (11, 'NOTE-2', NULL, NULL, NULL, NULL, NULL);",
  ]);
  bare = join(dir, "Bare.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    bare,
    "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 'ONLY-ID');",
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readExportNoteMeta (real sqlite3)", () => {
  it("reads uuid, dates, folder and account by bound key", () => {
    expect(readExportNoteMeta(id(10), { dbPath: db })).toEqual({
      uuid: "NOTE-UUID",
      created: "2001-01-01T00:00:00Z",
      modified: "2001-01-02T00:00:00Z",
      folder: "Folder A",
      account: "Synthetic Account",
    });
    expect(readExportNoteMeta(id(11), { dbPath: db })).toEqual({ uuid: "NOTE-2" });
    expect(readExportNoteMeta(id(99), { dbPath: db })).toEqual({});
  });

  it("works on a schema without the optional columns", () => {
    expect(readExportNoteMeta(id(1), { dbPath: bare })).toEqual({ uuid: "ONLY-ID" });
  });

  it("classifies bad ids and unreadable databases", () => {
    expect(code(() => readExportNoteMeta("x-coredata://A/ICFolder/p1", { dbPath: db }))).toBe(
      "invalid-id"
    );
    expect(code(() => readExportNoteMeta(id("1;DROP"), { dbPath: db }))).toBe("invalid-id");
    expect(code(() => readExportNoteMeta(id(1), { dbPath: join(dir, "missing.sqlite") }))).toBe(
      "no-full-disk-access"
    );
  });
});

describe("noteMetaQuery", () => {
  it("coalesces present candidate columns, preferring higher-numbered account keys", () => {
    const sql = noteMetaQuery(
      new Set([
        "ZIDENTIFIER",
        "ZCREATIONDATE",
        "ZMODIFICATIONDATE",
        "ZACCOUNT",
        "ZACCOUNT7",
        "ZNAME",
      ])
    );
    expect(sql).toContain("'created', n.ZCREATIONDATE,");
    expect(sql).toContain("'modified', n.ZMODIFICATIONDATE,");
    expect(sql).toContain("a.Z_PK = COALESCE(n.ZACCOUNT7, n.ZACCOUNT)");
    expect(sql).toContain("'folder', NULL");
    expect(sql).toContain("n.Z_PK = @pk");
    expect(noteMetaQuery(new Set())).toContain("'uuid', NULL");
  });
});

describe("coreDataDate", () => {
  it("converts seconds since 2001 and rejects junk", () => {
    expect(coreDataDate(0)).toBe("2001-01-01T00:00:00Z");
    expect(coreDataDate("60")).toBe("2001-01-01T00:01:00Z");
    expect(coreDataDate(" ")).toBeUndefined();
    expect(coreDataDate(null)).toBeUndefined();
    expect(coreDataDate(1e19)).toBeUndefined();
    expect(coreDataDate("abc")).toBeUndefined();
  });
});
