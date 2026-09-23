/**
 * Runs the guard-store SQL through the real sqlite3 CLI against throwaway
 * fixture databases. The live NoteStore is never opened.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NoteGuardStoreError,
  QUICK_NOTE_SQL,
  readIsQuickNote,
  readTrashFolderPks,
} from "./noteGuardStore.js";

let dir: string;
let db: string;
let oldDb: string;

const sql = (path: string, statements: string) =>
  execFileSync("sqlite3", [path, statements], { encoding: "utf8" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-guard-store-"));
  db = join(dir, "store.sqlite");
  sql(
    db,
    `CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);
     INSERT INTO Z_PRIMARYKEY VALUES (12, 'ICNote'), (15, 'ICFolder');
     CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFOLDERTYPE INTEGER, ZISSYSTEMPAPER INTEGER);
     INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES
       (5, 15, 1, NULL), (6, 15, 0, NULL), (7, 15, 2, NULL), (9, 15, 1, NULL),
       (40, 12, NULL, 0), (41, 12, NULL, 1), (42, 12, NULL, NULL);`
  );
  oldDb = join(dir, "old.sqlite");
  sql(
    oldDb,
    `CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);
     INSERT INTO Z_PRIMARYKEY VALUES (12, 'ICNote');
     CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFOLDERTYPE INTEGER);
     INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (40, 12, NULL);`
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("noteGuardStore", () => {
  it("lists every Recently Deleted folder", () => {
    expect(readTrashFolderPks(db)).toEqual([5, 9]);
    expect(readTrashFolderPks(oldDb)).toEqual([]);
  });

  it("reads the Quick Note flag for a bound key", () => {
    expect(readIsQuickNote(40, db)).toBe(false);
    expect(readIsQuickNote(41, db)).toBe(true);
    expect(readIsQuickNote(42, db)).toBe(false);
    expect(readIsQuickNote(5, db)).toBeNull();
    expect(readIsQuickNote(999, db)).toBeNull();
    expect(QUICK_NOTE_SQL).toContain("@pk");
  });

  it("treats a store without the Quick Note column as having none", () => {
    expect(readIsQuickNote(40, oldDb)).toBe(false);
    expect(readIsQuickNote(41, oldDb)).toBeNull();
  });

  it("rejects invalid keys before running SQL", () => {
    expect(() => readIsQuickNote(0, db)).toThrow(/positive integer/);
    expect(() => readIsQuickNote(1.5, db)).toThrow(/positive integer/);
  });

  it("classifies unreadable stores and SQL failures", () => {
    try {
      readTrashFolderPks(join(dir, "absent", "x.sqlite"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NoteGuardStoreError);
      expect((error as NoteGuardStoreError).reason).toBe("no_fda");
    }
    const broken = join(dir, "broken.sqlite");
    sql(broken, "CREATE TABLE unrelated (x);");
    try {
      readTrashFolderPks(broken);
      expect.unreachable();
    } catch (error) {
      expect((error as NoteGuardStoreError).reason).toBe("query_error");
    }
  });
});
