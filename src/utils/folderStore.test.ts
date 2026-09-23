/**
 * Tests for the read-only folder facts reader.
 *
 * These run the generated SQL through the real sqlite3 CLI against a throwaway
 * fixture database, so a SQL compile error or a wrong column cannot hide behind
 * a mock. The live NoteStore is never opened.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FolderStoreError,
  REQUIRED_FOLDER_COLUMNS,
  buildFolderFactsSql,
  readFolderStoreFacts,
} from "./folderStore.js";

let dir: string;
let db: string;
let noSmartDb: string;
let missingColumnDb: string;
let noPrimaryKeyDb: string;

const sql = (path: string, statements: string) =>
  execFileSync("sqlite3", [path, statements], { encoding: "utf8" });

const ALL_COLUMNS = [...REQUIRED_FOLDER_COLUMNS, "ZSMARTFOLDERQUERYJSON"];

function createStore(path: string, columns: string[], withPrimaryKey = true) {
  const defs = columns.map((c) => `${c} ${c === "ZIDENTIFIER" ? "TEXT" : "INTEGER"}`).join(", ");
  sql(
    path,
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ${defs});` +
      (withPrimaryKey
        ? `CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);
           INSERT INTO Z_PRIMARYKEY VALUES (12, 'ICNote'), (14, 'ICAccount'), (15, 'ICFolder');`
        : "")
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "folder-store-test-"));
  db = join(dir, "store.sqlite");
  createStore(db, ALL_COLUMNS);
  // Account 1; root folder 10 (ordinary, one live note, one tombstoned note,
  // one tombstoned child); child folder 11; Recently Deleted 20; default 21;
  // smart 22; shared root 30 with child 31; note 40 (not a folder).
  sql(
    db,
    `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFOLDERTYPE, ZMARKEDFORDELETION, ZPARENT, ZOWNER, ZFOLDER, ZSERVERSHAREDATA, ZSMARTFOLDERQUERYJSON) VALUES
     (1, 14, 'ACCOUNT-1', NULL, 0, NULL, NULL, NULL, NULL, NULL),
     (10, 15, 'F-10', 0, 0, NULL, 1, NULL, NULL, NULL),
     (11, 15, 'F-11', 0, 0, 10, 1, NULL, NULL, NULL),
     (12, 15, 'F-12', 0, 1, 10, 1, NULL, NULL, NULL),
     (20, 15, 'TrashFolder-CloudKit', 1, 0, NULL, 1, NULL, NULL, NULL),
     (21, 15, 'DefaultFolder-CloudKit', 0, NULL, NULL, 1, NULL, NULL, NULL),
     (22, 15, 'F-22', 2, 0, NULL, 1, NULL, NULL, '{"q":1}'),
     (30, 15, 'F-30', 0, 0, NULL, 1, NULL, x'00', NULL),
     (31, 15, NULL, 0, 0, 30, 1, NULL, NULL, NULL),
     (40, 12, 'N-40', NULL, 0, NULL, NULL, 10, NULL, NULL),
     (41, 12, 'N-41', NULL, 1, NULL, NULL, 10, NULL, NULL);`
  );
  noSmartDb = join(dir, "no-smart.sqlite");
  createStore(noSmartDb, [...REQUIRED_FOLDER_COLUMNS]);
  sql(
    noSmartDb,
    `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFOLDERTYPE, ZMARKEDFORDELETION, ZPARENT, ZOWNER, ZFOLDER, ZSERVERSHAREDATA)
     VALUES (5, 15, 'F-5', 0, 0, NULL, 1, NULL, NULL);`
  );
  missingColumnDb = join(dir, "missing.sqlite");
  createStore(
    missingColumnDb,
    REQUIRED_FOLDER_COLUMNS.filter((c) => c !== "ZFOLDERTYPE")
  );
  noPrimaryKeyDb = join(dir, "no-pk.sqlite");
  createStore(noPrimaryKeyDb, ALL_COLUMNS, false);
  sql(noPrimaryKeyDb, `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT) VALUES (7, 15);`);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readFolderStoreFacts", () => {
  it("reads an ordinary root folder with live child and note counts", () => {
    expect(readFolderStoreFacts(10, db)).toEqual({
      pk: 10,
      identifier: "F-10",
      folderType: 0,
      markedForDeletion: false,
      parentPk: null,
      accountPk: 1,
      hasSmartQuery: false,
      sharedRecord: false,
      sharedAncestor: false,
      childFolderCount: 1,
      noteCount: 1,
      noteKeys: [40],
    });
  });

  it("reads a nested empty folder and a tombstoned folder", () => {
    expect(readFolderStoreFacts(11, db)).toMatchObject({
      parentPk: 10,
      childFolderCount: 0,
      noteCount: 0,
      markedForDeletion: false,
    });
    expect(readFolderStoreFacts(12, db)).toMatchObject({ markedForDeletion: true });
  });

  it("reports Recently Deleted, default, and smart folder facts", () => {
    expect(readFolderStoreFacts(20, db)).toMatchObject({
      folderType: 1,
      identifier: "TrashFolder-CloudKit",
    });
    expect(readFolderStoreFacts(21, db)).toMatchObject({
      identifier: "DefaultFolder-CloudKit",
      markedForDeletion: false,
    });
    expect(readFolderStoreFacts(22, db)).toMatchObject({ folderType: 2, hasSmartQuery: true });
  });

  it("reports a shared folder and a child of a shared folder", () => {
    expect(readFolderStoreFacts(30, db)).toMatchObject({
      sharedRecord: true,
      sharedAncestor: false,
    });
    expect(readFolderStoreFacts(31, db)).toMatchObject({
      identifier: null,
      sharedRecord: false,
      sharedAncestor: true,
    });
  });

  it("returns null for a missing row and refuses a non-folder row", () => {
    expect(readFolderStoreFacts(999, db)).toBeNull();
    expect(() => readFolderStoreFacts(40, db)).toThrow(/does not name a folder/);
  });

  it("works on a schema without the smart-folder query column", () => {
    expect(buildFolderFactsSql(false)).not.toContain("ZSMARTFOLDERQUERYJSON");
    expect(readFolderStoreFacts(5, noSmartDb)).toMatchObject({
      hasSmartQuery: false,
      noteKeys: [],
    });
  });

  it("fails closed when a required column is missing", () => {
    expect(() => readFolderStoreFacts(5, missingColumnDb)).toThrow(/ZFOLDERTYPE/);
    try {
      readFolderStoreFacts(5, missingColumnDb);
    } catch (error) {
      expect((error as FolderStoreError).reason).toBe("schema");
    }
  });

  it("classifies an unreadable store as a Full Disk Access problem", () => {
    try {
      readFolderStoreFacts(5, join(dir, "absent", "store.sqlite"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FolderStoreError);
      expect((error as FolderStoreError).reason).toBe("no_fda");
    }
  });

  it("classifies other SQL failures as query errors", () => {
    try {
      readFolderStoreFacts(7, noPrimaryKeyDb);
      expect.unreachable();
    } catch (error) {
      expect((error as FolderStoreError).reason).toBe("query_error");
    }
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects the invalid key %s before running SQL", (pk) => {
    expect(() => readFolderStoreFacts(pk, db)).toThrow(/positive integer/);
  });

  it("binds the key as a parameter instead of splicing it into SQL", () => {
    const text = buildFolderFactsSql(true);
    expect(text).toContain("@pk");
    expect(text).not.toMatch(/Z_PK = \d/);
  });
});
