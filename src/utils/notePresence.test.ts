/**
 * readNotePresence against the real sqlite3 and a throwaway NoteStore-shaped
 * database (#316). The live NoteStore is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNotePresence } from "./notePresence.js";

const STORE = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const id = (pk: number, store = STORE) => `x-coredata://${store}/ICNote/p${pk}`;

let dir: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-presence-"));
  db = join(dir, "NoteStore.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    db,
    [
      "CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);",
      `INSERT INTO Z_METADATA VALUES (1, '${STORE}', NULL);`,
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR);",
      "INSERT INTO Z_PRIMARYKEY VALUES (12,'ICNote'),(15,'ICFolder');",
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZTITLE1 VARCHAR, " +
        "ZTITLE2 VARCHAR, ZFOLDER INTEGER, ZFOLDERTYPE INTEGER, ZIDENTIFIER VARCHAR, " +
        "ZISPASSWORDPROTECTED INTEGER, ZMARKEDFORDELETION INTEGER);",
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);",
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES " +
        "(1, 15, NULL, 'Notes', NULL, 0, 'DefaultFolder', NULL, 0)," +
        "(2, 15, NULL, 'Recently Deleted', NULL, 1, 'TrashFolder-x', NULL, 0)," +
        "(10, 12, 'Plain note', NULL, 1, NULL, 'N10', 0, 0)," +
        "(11, 12, 'Locked note', NULL, 1, NULL, 'N11', 1, 0)," +
        "(12, 12, 'Encrypted body', NULL, 1, NULL, 'N12', 0, 0)," +
        "(13, 12, 'Deleted note', NULL, 2, NULL, 'N13', 0, 0)," +
        "(14, 12, 'Tombstone', NULL, 1, NULL, 'N14', 0, 1)," +
        "(15, 12, NULL, NULL, 1, NULL, 'N15', 0, 0);",
      "INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES " +
        "(10, NULL, X'00'), (12, X'01', X'00');",
    ].join(""),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readNotePresence (real sqlite3)", () => {
  it("reports a live, unlocked note the database holds", () => {
    expect(readNotePresence(id(10), db)).toEqual({
      title: "Plain note",
      locked: false,
      inRecentlyDeleted: false,
    });
  });

  it("reports the password flag and an encrypted body as locked", () => {
    expect(readNotePresence(id(11), db)?.locked).toBe(true);
    expect(readNotePresence(id(12), db)?.locked).toBe(true);
  });

  it("reports a note in Recently Deleted, which AppleScript still resolves", () => {
    expect(readNotePresence(id(13), db)).toMatchObject({ inRecentlyDeleted: true });
  });

  it("returns a null title rather than guessing one", () => {
    expect(readNotePresence(id(15), db)).toMatchObject({ title: null });
  });

  it.each([
    ["a tombstoned note", id(14)],
    ["a folder row", id(1)],
    ["a missing primary key", id(999)],
    ["another store's id", id(10, "00000000-0000-0000-0000-000000000000")],
    ["a malformed id", "not-a-note-id"],
    ["a folder id", `x-coredata://${STORE}/ICFolder/p1`],
  ])("does not vouch for %s", (_name, noteId) => {
    expect(readNotePresence(noteId, db)).toBeNull();
  });

  it("returns null instead of throwing when the database is unreadable", () => {
    expect(readNotePresence(id(10), join(dir, "missing.sqlite"))).toBeNull();
  });

  it("matches the store UUID case-insensitively", () => {
    expect(readNotePresence(id(10, STORE.toLowerCase()), db)).not.toBeNull();
  });
});
