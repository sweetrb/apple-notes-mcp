/**
 * readNoteBlocks against a real sqlite3 and a throwaway fixture database.
 *
 * Execution is not mocked here: the generated SQL and the sqlite3 parameter
 * binding run through the real /usr/bin/sqlite3 CLI against a temp store that
 * has only the NoteStore tables and columns the reader uses. The live
 * NoteStore is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { NoteBlocksError, readNoteBlocks } from "./noteBlocks.js";

const varint = (value: number): number[] => {
  const out: number[] = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
  return out;
};
const n = (field: number, value: number) => Buffer.from([...varint(field * 8), ...varint(value)]);
const b = (field: number, value: Buffer | string) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(bytes.length)]), bytes]);
};
const doc = (text: string, runs: Buffer[]) =>
  gzipSync(b(2, b(3, Buffer.concat([b(2, text), ...runs.map((r) => b(5, r))]))));

let dir: string;
let db: string;
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
  dir = mkdtempSync(join(tmpdir(), "note-blocks-"));
  db = join(dir, "NoteStore.sqlite");
  const heading = doc("Heading\nitem", [
    Buffer.concat([n(1, 8), b(2, n(1, 1))]),
    Buffer.concat([n(1, 4), b(2, n(1, 100)), n(5, 1)]),
  ]);
  execFileSync("/usr/bin/sqlite3", [
    db,
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR);" +
      "INSERT INTO Z_PRIMARYKEY VALUES (12,'ICNote'),(14,'ICFolder');" +
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER);" +
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1,12),(2,12),(3,12),(4,12),(5,14);" +
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (1, NULL, X'${heading.toString("hex")}');` +
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (2, X'00', X'0102');` +
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (3, NULL, NULL);`,
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readNoteBlocks (real sqlite3)", () => {
  it("reads and decodes one note by bound primary key", () => {
    const decoded = readNoteBlocks(id(1), { dbPath: db });
    expect(decoded.blocks.map((block) => [block.text, block.style])).toEqual([
      ["Heading", "heading"],
      ["item", "bulleted"],
    ]);
    expect(decoded.blocks[1].runs[0].bold).toBe(true);
  });

  it("classifies encrypted, empty, missing and malformed-id notes", () => {
    expect(code(() => readNoteBlocks(id(2), { dbPath: db }))).toBe("encrypted");
    expect(code(() => readNoteBlocks(id(3), { dbPath: db }))).toBe("no-body");
    expect(code(() => readNoteBlocks(id(4), { dbPath: db }))).toBe("no-body");
    expect(code(() => readNoteBlocks(id(99), { dbPath: db }))).toBe("not-found");
    // A folder's primary key is not a note, even though the row exists.
    expect(code(() => readNoteBlocks(id(5), { dbPath: db }))).toBe("not-found");
    expect(code(() => readNoteBlocks(id("1;DROP TABLE ZICNOTEDATA"), { dbPath: db }))).toBe(
      "invalid-id"
    );
    expect(code(() => readNoteBlocks("x-coredata://ABC/ICFolder/p1", { dbPath: db }))).toBe(
      "invalid-id"
    );
    expect(code(() => readNoteBlocks(id(1), { dbPath: join(dir, "missing.sqlite") }))).toBe(
      "no-full-disk-access"
    );
  });

  it("never modifies the fixture database", () => {
    const before = execFileSync("/usr/bin/sqlite3", [db, "SELECT count(*) FROM ZICNOTEDATA"], {
      encoding: "utf8",
    });
    readNoteBlocks(id(1), { dbPath: db });
    expect(
      execFileSync("/usr/bin/sqlite3", [db, "SELECT count(*) FROM ZICNOTEDATA"], {
        encoding: "utf8",
      })
    ).toBe(before);
  });
});
