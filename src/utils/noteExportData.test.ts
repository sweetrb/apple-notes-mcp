/**
 * Export loading against a real sqlite3 and a throwaway fixture database.
 * The generated attachment SQL and parameter binding run through the real
 * /usr/bin/sqlite3 CLI; the live NoteStore is never touched. All note text
 * and identifiers are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { NoteBlocksError } from "./noteBlocks.js";
import {
  attachmentQuery,
  buildAttachments,
  classifyUti,
  objectColumns,
  readExportNote,
} from "./noteExportData.js";

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
const attachmentRun = (id: string, uti: string) =>
  Buffer.concat([n(1, 1), b(12, Buffer.concat([b(1, id), b(2, uti)]))]);

const FULL_COLUMNS =
  "Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTYPEUTI TEXT, ZTYPEUTI1 TEXT, ZNOTE INTEGER, " +
  "ZNOTE1 INTEGER, ZPARENTATTACHMENT INTEGER, ZTITLE TEXT, ZTITLE1 TEXT, ZUSERTITLE TEXT, " +
  "ZURLSTRING TEXT, ZALTTEXT TEXT, ZTOKENCONTENTIDENTIFIER TEXT, ZFALLBACKIMAGEGENERATION TEXT, " +
  "ZFALLBACKPDFGENERATION TEXT, ZFILENAME TEXT, ZGENERATION1 TEXT, ZMEDIA INTEGER, " +
  "ZMARKEDFORDELETION INTEGER, ZMERGEABLEDATA BLOB, ZMERGEABLEDATA1 BLOB";

// readNoteBlocks confirms the key belongs to an ICNote row via Z_PRIMARYKEY.
const NOTE_ENTITY =
  "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR);" +
  "INSERT INTO Z_PRIMARYKEY VALUES (12, 'ICNote');";

let dir: string;
let db: string;
let minimalDb: string;
const id = (pk: number | string) => `x-coredata://ABCDEF-1234/ICNote/p${pk}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-export-data-"));
  db = join(dir, "NoteStore.sqlite");
  const body = doc("Title\n\ufffc\ufffc\ufffc\n", [
    n(1, 6),
    attachmentRun("IMG-1", "public.jpeg"),
    attachmentRun("TBL-1", "com.apple.notes.table"),
    attachmentRun("TAG-1", "com.apple.notes.inlinetextattachment.hashtag"),
    n(1, 1),
  ]);
  const table = Buffer.from("1f8b0800", "hex");
  execFileSync("/usr/bin/sqlite3", [
    db,
    NOTE_ENTITY +
      `CREATE TABLE ZICCLOUDSYNCINGOBJECT (${FULL_COLUMNS});` +
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1) VALUES (1, 12, 'NOTE-1', 'Stored title'), (2, 12, 'NOTE-2', NULL);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZFILENAME, ZGENERATION1) VALUES (10, 'MEDIA-1', 'photo.jpg', '1_GEN');" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZMEDIA, ZTITLE) VALUES (11, 'IMG-1', 'public.jpeg', 1, 10, NULL);" +
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZMERGEABLEDATA1) VALUES (12, 'TBL-1', 'com.apple.notes.table', 1, X'${table.toString("hex")}');` +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZTYPEUTI1, ZNOTE1, ZALTTEXT, ZTOKENCONTENTIDENTIFIER) VALUES (13, 'TAG-1', 'com.apple.notes.inlinetextattachment.hashtag', 1, '#tag', NULL);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZMARKEDFORDELETION) VALUES (14, 'GONE-1', 'public.png', 1, 1);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZURLSTRING, ZTITLE) VALUES (15, 'URL-1', 'public.url', 1, 'https://example.com/x', 'Example');" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZPARENTATTACHMENT, ZFALLBACKIMAGEGENERATION, ZFALLBACKPDFGENERATION) VALUES (16, 'CHILD-1', 'com.apple.paper.doc.scan', 1, 17, '3_G', '1_G'), (17, 'GAL-1', 'com.apple.notes.gallery', 1, NULL, NULL, NULL);" +
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (1, NULL, X'${body.toString("hex")}'), (2, NULL, X'${doc("Only line", [n(1, 9)]).toString("hex")}');`,
  ]);
  minimalDb = join(dir, "Minimal.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    minimalDb,
    NOTE_ENTITY +
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT);" +
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);" +
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 12, 'NOTE-1');" +
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (1, X'${doc("First line\nmore", [n(1, 15)]).toString("hex")}');`,
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("classifyUti", () => {
  it("maps every known type family", () => {
    const cases: Array<[string, string]> = [
      ["com.apple.notes.table", "table"],
      ["com.apple.notes.inlinetextattachment.dividerline", "divider"],
      ["com.apple.notes.inlinetextattachment.hashtag", "inline"],
      ["com.apple.notes.gallery", "gallery"],
      ["com.apple.drawing.2", "drawing"],
      ["com.apple.drawing", "drawing"],
      ["com.apple.paper.doc.scan", "scan"],
      ["com.apple.paper", "paper"],
      ["public.url", "link"],
      ["com.adobe.pdf", "pdf"],
      ["public.heic", "image"],
      ["com.apple.m4a-audio", "audio"],
      ["com.apple.quicktime-movie", "video"],
      ["public.data", "file"],
    ];
    for (const [uti, kind] of cases) expect(classifyUti(uti)).toBe(kind);
  });
});

describe("attachmentQuery", () => {
  it("selects only present columns and binds the note key", () => {
    const sql = attachmentQuery(new Set(["ZNOTE", "ZTYPEUTI", "ZMERGEABLEDATA"]));
    expect(sql).toContain("a.ZNOTE = @pk");
    expect(sql).not.toContain("ZNOTE1");
    expect(sql).toContain("'uti1', NULL");
    expect(sql).toContain("hex(a.ZMERGEABLEDATA)");
    expect(sql).toContain("ON 0");
    expect(sql).not.toContain("ZMARKEDFORDELETION");
    expect(attachmentQuery(new Set(["ZMERGEABLEDATA1"]))).toContain("hex(a.ZMERGEABLEDATA1)");
    expect(attachmentQuery(new Set())).toContain("WHERE 0 AND");
  });
});

describe("buildAttachments", () => {
  it("nests children, orders by key and drops malformed rows", () => {
    const { byId, ordered } = buildAttachments([
      { pk: 5, id: "C", uti0: "public.png", parent: 4 },
      { pk: 4, id: "G", uti0: null, uti1: "com.apple.notes.gallery" },
      { pk: 3, id: null },
      { pk: 2, id: "T", uti0: "com.apple.notes.table", table: "zz" },
      { pk: 1, id: "U", title: null, userTitle: "User", fbImageGen: 7 },
    ]);
    expect(ordered.map((a) => a.id)).toEqual(["U", "T", "G"]);
    expect(byId.get("G")!.children.map((c) => c.id)).toEqual(["C"]);
    expect(byId.get("C")!.parentPk).toBe(4);
    expect(byId.get("T")!.tableData).toBeUndefined();
    expect(byId.get("U")).toMatchObject({ uti: "unknown", kind: "file", title: "User" });
    expect(byId.get("U")!.fallbackImageGeneration).toBe("7");
  });
});

describe("readExportNote (real sqlite3)", () => {
  it("loads blocks, title and attachment rows for one bound note", () => {
    const note = readExportNote(id(1), { dbPath: db });
    expect(note.title).toBe("Stored title");
    expect(note.doc.attachments.map((m) => m.id)).toEqual(["IMG-1", "TBL-1", "TAG-1"]);
    expect(note.ordered.map((a) => a.id)).toEqual(["IMG-1", "TBL-1", "TAG-1", "URL-1", "GAL-1"]);
    expect(note.attachments.get("IMG-1")).toMatchObject({
      kind: "image",
      mediaId: "MEDIA-1",
      mediaFilename: "photo.jpg",
      mediaGeneration: "1_GEN",
      title: "photo.jpg",
    });
    expect(note.attachments.get("TBL-1")!.tableData).toBe("1F8B0800");
    expect(note.attachments.get("TAG-1")).toMatchObject({ kind: "inline", altText: "#tag" });
    expect(note.attachments.get("URL-1")).toMatchObject({ url: "https://example.com/x" });
    expect(note.attachments.get("GAL-1")!.children[0]).toMatchObject({
      id: "CHILD-1",
      fallbackImageGeneration: "3_G",
      fallbackPdfGeneration: "1_G",
    });
    expect(note.attachments.has("GONE-1")).toBe(false);
  });

  it("falls back to the first line when no title is stored", () => {
    expect(readExportNote(id(2), { dbPath: db }).title).toBe("Only line");
    const minimal = readExportNote(id(1), { dbPath: minimalDb });
    expect(minimal.title).toBe("First line");
    expect(minimal.ordered).toEqual([]);
  });

  it("classifies database failures with stable codes", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof NoteBlocksError ? error.code : String(error);
      }
      return "no error";
    };
    expect(code(() => readExportNote(id(99), { dbPath: db }))).toBe("not-found");
    const notDb = join(dir, "not-a-db.sqlite");
    writeFileSync(notDb, "plain text, not sqlite");
    expect(code(() => objectColumns(notDb))).toBe("query-failed");
    expect(code(() => objectColumns(join(dir, "missing", "x.sqlite")))).toBe("no-full-disk-access");
  });
});
