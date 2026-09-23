import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTrashFolderCache,
  readTrashFolderIds,
  RECENTLY_DELETED_FOLDER_NAME,
} from "./trashFolders.js";

let dir: string;

function makeDb(name: string, sql: string): string {
  const db = join(dir, name);
  execFileSync("sqlite3", [db, sql]);
  return db;
}

const HEADER = `
  CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID VARCHAR, Z_PLIST BLOB);
  CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
  INSERT INTO Z_PRIMARYKEY VALUES (14, 'ICAccount', 0, 0), (15, 'ICFolder', 0, 0), (12, 'ICNote', 0, 0);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trash-folders-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => clearTrashFolderCache());

describe("readTrashFolderIds", () => {
  it("returns the Core Data id of every Recently Deleted folder", () => {
    const db = makeDb(
      "typed.sqlite",
      `${HEADER}
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR, ZFOLDERTYPE INTEGER);
      INSERT INTO Z_METADATA VALUES (1, 'AAAA-1111', NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES
        (2, 15, 'FOLDER-A', 0),
        (3, 15, 'TrashFolder-ACCT-1', 1),
        (4, 15, 'TrashFolder-ACCT-2', NULL),
        (5, 12, 'NOTE-IN-TRASH', 1),
        (6, 15, 'OTHER', 1);`
    );
    expect(readTrashFolderIds(db)).toEqual([
      "x-coredata://AAAA-1111/ICFolder/p3",
      "x-coredata://AAAA-1111/ICFolder/p4",
      "x-coredata://AAAA-1111/ICFolder/p6",
    ]);
  });

  it("falls back to the TrashFolder identifier prefix without ZFOLDERTYPE", () => {
    const db = makeDb(
      "untyped.sqlite",
      `${HEADER}
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR);
      INSERT INTO Z_METADATA VALUES (1, 'BBBB-2222', NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (2, 15, 'FOLDER-A'), (7, 15, 'TrashFolder-X');`
    );
    expect(readTrashFolderIds(db)).toEqual(["x-coredata://BBBB-2222/ICFolder/p7"]);
  });

  it("returns nothing when no column can identify the folder", () => {
    const db = makeDb(
      "bare.sqlite",
      `${HEADER}
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER);
      INSERT INTO Z_METADATA VALUES (1, 'CCCC-3333', NULL);`
    );
    expect(readTrashFolderIds(db)).toEqual([]);
  });

  it("returns nothing for a malformed store id", () => {
    const db = makeDb(
      "baduuid.sqlite",
      `${HEADER}
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFOLDERTYPE INTEGER);
      INSERT INTO Z_METADATA VALUES (1, 'not a uuid"', NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (3, 15, 1);`
    );
    expect(readTrashFolderIds(db)).toEqual([]);
  });

  it("returns nothing when the database is missing or unreadable", () => {
    expect(readTrashFolderIds(join(dir, "missing.sqlite"))).toEqual([]);
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, "not a database");
    expect(readTrashFolderIds(junk)).toEqual([]);
  });

  it("reuses a successful read until the cache is cleared", () => {
    const db = makeDb(
      "cached.sqlite",
      `${HEADER}
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFOLDERTYPE INTEGER);
      INSERT INTO Z_METADATA VALUES (1, 'DDDD-4444', NULL);
      INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (3, 15, 1);`
    );
    expect(readTrashFolderIds(db)).toEqual(["x-coredata://DDDD-4444/ICFolder/p3"]);
    execFileSync("sqlite3", [db, "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (8, 15, 1);"]);
    expect(readTrashFolderIds(db)).toHaveLength(1);
    clearTrashFolderCache();
    expect(readTrashFolderIds(db)).toHaveLength(2);
  });

  it("names the English fallback folder", () => {
    expect(RECENTLY_DELETED_FOLDER_NAME).toBe("Recently Deleted");
  });
});
