/**
 * get-note-structure's reader, run through the real /usr/bin/sqlite3 against
 * synthetic fixture stores (one with the full column set, one missing the
 * optional columns). Bodies are built with a small protobuf encoder. The live
 * NoteStore is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AttachmentStoreError } from "./attachmentAssets.js";
import { NoteStoreError } from "./noteStoreSql.js";
import {
  charCount,
  describeNoteStructure,
  LAST_VIEWED_NEVER,
  lastViewedOf,
  noteStructureSql,
  readNoteStructure,
  wordCount,
  type NoteStructure,
} from "./noteStructure.js";

// --- protobuf fixture encoder ---
const varint = (value: number): number[] => {
  const out: number[] = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
};
const n = (field: number, value: number) => Buffer.from([...varint(field * 8), ...varint(value)]);
const b = (field: number, value: Buffer | string) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(bytes.length)]), bytes]);
};
type Seg = [text: string, ...parts: Buffer[]];
const body = (segs: Seg[]) => {
  const text = segs.map(([t]) => t).join("");
  const runs = segs.map(([t, ...parts]) => b(5, Buffer.concat([n(1, t.length), ...parts])));
  return gzipSync(b(2, b(3, Buffer.concat([b(2, text), ...runs]))));
};
const style = (type: number, ...extra: Buffer[]) => b(2, Buffer.concat([n(1, type), ...extra]));
const check = (done: number) =>
  style(103, b(5, Buffer.concat([b(1, Buffer.alloc(16, done + 1)), n(2, done)])));
const att = (id: string, uti: string) => b(12, Buffer.concat([b(1, id), b(2, uti)]));
const link = (url: string) => b(9, url);

const NOTE_UUID = "0A1B2C3D-0000-4000-8000-00000000000A";
const TARGET = "0A1B2C3D-0000-4000-8000-00000000000C";
const PARA = "0A1B2C3D-0000-4000-8000-00000000000D";
const LINK_UTI = "com.apple.notes.inlinetextattachment.link";
const TAG_UTI = "com.apple.notes.inlinetextattachment.hashtag";

const mainBody = body([
  ["Title\n", style(0)],
  ["Visit "],
  ["Exa", link("https://example.com")],
  ["mple\n", link("https://example.com")],
  ["\ufffc", att("GAL-1", "com.apple.notes.gallery")],
  ["\n"],
  ["\ufffc", att("CARD-1", "public.url")],
  ["\nGo "],
  ["\ufffc", att("CHIP-1", LINK_UTI)],
  [" "],
  ["\ufffc", att("CHIP-2", LINK_UTI)],
  [" "],
  ["\ufffc", att("TAG-4", TAG_UTI)],
  [" "],
  ["\ufffc", att("TAG-1", TAG_UTI)],
  [" "],
  ["\ufffc", att("TAG-5", TAG_UTI)],
  ["\n"],
  ["done item\n", check(1)],
  ["open item\n", check(0)],
  ["\ufffc", att("IMG-1", "public.jpeg")],
  ["\nbad", link("javascript:alert(1)")],
]);

let dir: string;
let db: string;
let bare: string;
const id = (pk: number) => `x-coredata://F1C7-5E0A/ICNote/p${pk}`;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof NoteStoreError) return error.kind;
    if (error instanceof AttachmentStoreError) return error.code;
    return String(error);
  }
  return "no error";
};
const hex = (buf: Buffer) => `X'${buf.toString("hex")}'`;
// Apple-epoch seconds for 2025-06-01T00:00:00Z.
const VIEWED = Date.UTC(2025, 5, 1) / 1000 - 978307200;

const OBJECT_COLUMNS = [
  "Z_PK INTEGER PRIMARY KEY",
  "Z_ENT INTEGER",
  "ZIDENTIFIER TEXT",
  "ZTITLE1 TEXT",
  "ZTITLE2 TEXT",
  "ZTITLE TEXT",
  "ZNAME TEXT",
  "ZFOLDER INTEGER",
  "ZFOLDERTYPE INTEGER",
  "ZPARENT INTEGER",
  "ZACCOUNT1 INTEGER",
  "ZACCOUNT7 INTEGER",
  "ZACCOUNT8 INTEGER",
  "ZISPASSWORDPROTECTED INTEGER",
  "ZISPINNED INTEGER",
  "ZSERVERSHAREDATA BLOB",
  "ZLASTVIEWEDMODIFICATIONDATE",
  "ZMARKEDFORDELETION INTEGER",
  "ZNOTE INTEGER",
  "ZNOTE1 INTEGER",
  "ZTYPEUTI TEXT",
  "ZTYPEUTI1 TEXT",
  "ZPARENTATTACHMENT INTEGER",
  "ZURLSTRING TEXT",
  "ZFILESIZE INTEGER",
  "ZMEDIA INTEGER",
  "ZFILENAME TEXT",
  "ZATTACHMENT INTEGER",
  "ZWIDTH REAL",
  "ZHEIGHT REAL",
  "ZSCALE REAL",
  "ZAPPEARANCETYPE INTEGER",
  "ZALTTEXT TEXT",
  "ZTOKENCONTENTIDENTIFIER TEXT",
];
// Entity numbers deliberately differ from a real store to prove they are looked up.
const ENTITIES =
  "INSERT INTO Z_PRIMARYKEY VALUES (3,'ICNote'),(4,'ICAttachment'),(5,'ICInlineAttachment')," +
  "(6,'ICAttachmentPreviewImage'),(7,'ICFolder'),(8,'ICAccount'),(9,'ICMedia');";

function insert(values: Record<string, unknown>): string {
  const cols = Object.keys(values);
  const vals = cols.map((c) => {
    const v = values[c];
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    if (Buffer.isBuffer(v)) return hex(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  return `INSERT INTO ZICCLOUDSYNCINGOBJECT (${cols.join(",")}) VALUES (${vals.join(",")});`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-structure-"));
  db = join(dir, "NoteStore.sqlite");
  const previews = join(dir, "Accounts", "ACCT-1", "Previews");
  mkdirSync(join(previews, "CARD-1-1-600x315-0", "1_X"), { recursive: true });
  writeFileSync(join(previews, "CARD-1-1-600x315-0", "1_X", "Preview.png"), "png");
  writeFileSync(join(previews, "IMG-1-1-384x288-0.png"), "png");
  writeFileSync(join(previews, "IMG-1-1-192x144-0.png"), "png");
  writeFileSync(join(previews, "IMG-1-dark.png"), "png");

  const sql = [
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (${OBJECT_COLUMNS.join(", ")});`,
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
    "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);",
    ENTITIES,
    insert({ Z_PK: 1, Z_ENT: 8, ZNAME: "Fixture", ZIDENTIFIER: "ACCT-1" }),
    insert({ Z_PK: 3, Z_ENT: 7, ZTITLE2: "Parent", ZSERVERSHAREDATA: Buffer.from([1]) }),
    insert({ Z_PK: 2, Z_ENT: 7, ZTITLE2: "Folder A", ZFOLDERTYPE: 0, ZPARENT: 3 }),
    insert({ Z_PK: 4, Z_ENT: 7, ZTITLE2: "Recently Deleted", ZFOLDERTYPE: 1 }),
    // A Recently Deleted folder known only by its identifier (no ZFOLDERTYPE value).
    insert({ Z_PK: 5, Z_ENT: 7, ZTITLE2: "Trash", ZIDENTIFIER: "TrashFolder-ACCT-1" }),
    // Note 10: the full-featured note.
    insert({
      Z_PK: 10,
      Z_ENT: 3,
      ZIDENTIFIER: NOTE_UUID,
      ZTITLE1: "Title",
      ZFOLDER: 2,
      ZACCOUNT7: 1,
      ZISPASSWORDPROTECTED: 0,
      ZISPINNED: 1,
      ZLASTVIEWEDMODIFICATIONDATE: VIEWED,
    }),
    // Note 11: locked, in Recently Deleted, never viewed.
    insert({
      Z_PK: 11,
      Z_ENT: 3,
      ZIDENTIFIER: "LOCKED",
      ZFOLDER: 4,
      ZACCOUNT7: 1,
      ZISPASSWORDPROTECTED: 1,
      ZLASTVIEWEDMODIFICATIONDATE: LAST_VIEWED_NEVER,
    }),
    // Note 12: no body row, no view date, shared directly.
    insert({ Z_PK: 12, Z_ENT: 3, ZFOLDER: 4, ZSERVERSHAREDATA: Buffer.from([1]) }),
    // Note 15: in the identifier-only Recently Deleted folder.
    insert({ Z_PK: 15, Z_ENT: 3, ZFOLDER: 5 }),
    // Note 14: a body that is not gzip, and a malformed view date.
    insert({ Z_PK: 14, Z_ENT: 3, ZLASTVIEWEDMODIFICATIONDATE: "abc" }),
    // Attachments of note 10.
    insert({
      Z_PK: 20,
      Z_ENT: 4,
      ZIDENTIFIER: "IMG-1",
      ZTYPEUTI: "public.jpeg",
      ZNOTE: 10,
      ZMEDIA: 30,
      ZFILESIZE: 1234,
      ZACCOUNT1: 1,
    }),
    insert({
      Z_PK: 21,
      Z_ENT: 4,
      ZIDENTIFIER: "GAL-1",
      ZTYPEUTI: "com.apple.notes.gallery",
      ZNOTE: 10,
    }),
    insert({
      Z_PK: 22,
      Z_ENT: 4,
      ZIDENTIFIER: "GAL-A",
      ZTYPEUTI: "public.png",
      ZNOTE: 10,
      ZPARENTATTACHMENT: 21,
    }),
    insert({
      Z_PK: 23,
      Z_ENT: 4,
      ZIDENTIFIER: "GAL-B",
      ZTYPEUTI: "public.heic",
      ZNOTE: 10,
      ZPARENTATTACHMENT: 21,
    }),
    insert({
      Z_PK: 24,
      Z_ENT: 4,
      ZIDENTIFIER: "DEEP",
      ZTYPEUTI: "public.data",
      ZNOTE: 10,
      ZPARENTATTACHMENT: 22,
    }),
    insert({
      Z_PK: 25,
      Z_ENT: 4,
      ZIDENTIFIER: "CARD-1",
      ZTYPEUTI: "public.url",
      ZNOTE: 10,
      ZURLSTRING: "https://example.com/a",
      ZTITLE: "Example card",
      ZACCOUNT1: 1,
    }),
    insert({ Z_PK: 26, Z_ENT: 4, ZIDENTIFIER: "PAPER-1", ZTYPEUTI: "com.apple.paper", ZNOTE: 10 }),
    insert({
      Z_PK: 27,
      Z_ENT: 4,
      ZIDENTIFIER: "GONE",
      ZTYPEUTI: "public.jpeg",
      ZNOTE: 10,
      ZMARKEDFORDELETION: 1,
    }),
    insert({ Z_PK: 28, Z_ENT: 4, ZIDENTIFIER: "CARD-EMPTY", ZTYPEUTI: "public.url", ZNOTE: 10 }),
    insert({ Z_PK: 30, Z_ENT: 9, ZFILENAME: "photo.jpg" }),
    // Inline attachments of note 10.
    insert({
      Z_PK: 50,
      Z_ENT: 5,
      ZIDENTIFIER: "CHIP-1",
      ZTYPEUTI1: LINK_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "Plans",
      ZTOKENCONTENTIDENTIFIER: `applenotes://showNote?identifier=${TARGET}&paragraphID=${PARA}`,
    }),
    insert({
      Z_PK: 51,
      Z_ENT: 5,
      ZIDENTIFIER: "CHIP-2",
      ZTYPEUTI1: LINK_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "Other",
      ZTOKENCONTENTIDENTIFIER: `applenotes://showNote?identifier=${TARGET}`,
    }),
    insert({
      Z_PK: 52,
      Z_ENT: 5,
      ZIDENTIFIER: "TAG-1",
      ZTYPEUTI1: TAG_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "#Alpha",
    }),
    insert({
      Z_PK: 53,
      Z_ENT: 5,
      ZIDENTIFIER: "TAG-2",
      ZTYPEUTI1: TAG_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "#Ghost",
    }),
    insert({ Z_PK: 54, Z_ENT: 5, ZIDENTIFIER: "CHIP-3", ZTYPEUTI1: LINK_UTI, ZNOTE1: 10 }),
    insert({
      Z_PK: 55,
      Z_ENT: 5,
      ZIDENTIFIER: "DIV-1",
      ZTYPEUTI1: "com.apple.notes.inlinetextattachment.dividerline",
      ZNOTE1: 10,
    }),
    insert({
      Z_PK: 56,
      Z_ENT: 5,
      ZIDENTIFIER: null,
      ZTYPEUTI1: TAG_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "#NoId",
    }),
    insert({ Z_PK: 57, Z_ENT: 5, ZIDENTIFIER: "TAG-3", ZTYPEUTI1: TAG_UTI, ZNOTE1: 10 }),
    insert({
      Z_PK: 58,
      Z_ENT: 5,
      ZIDENTIFIER: "TAG-4",
      ZTYPEUTI1: TAG_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "#Beta",
    }),
    insert({
      Z_PK: 59,
      Z_ENT: 5,
      ZIDENTIFIER: "TAG-5",
      ZTYPEUTI1: TAG_UTI,
      ZNOTE1: 10,
      ZALTTEXT: "#Beta",
    }),
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (10, ${hex(mainBody)});`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (11, X'00', X'0102');`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (14, X'0102');`,
  ].join("\n");
  execFileSync("/usr/bin/sqlite3", [db, sql]);

  // A store from an OS release without the optional columns.
  bare = join(dir, "Bare.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    bare,
    [
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZNOTE INTEGER, ZTYPEUTI TEXT);",
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);",
      ENTITIES,
      "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (10, 3, 'BARE-NOTE', NULL, NULL), (20, 4, 'IMG-9', 10, 'public.png');",
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (10, ${hex(body([["Hi there\n"], ["\ufffc", att("IMG-9", "public.png")]]))});`,
    ].join("\n"),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lastViewedOf", () => {
  const now = Date.UTC(2026, 0, 1);
  it("returns a date for a real view and a status for everything else", () => {
    expect(lastViewedOf(VIEWED, true, now)).toEqual({
      lastViewed: "2025-06-01T00:00:00.000Z",
      lastViewedStatus: "viewed",
    });
    expect(lastViewedOf(LAST_VIEWED_NEVER, true, now)).toEqual({
      lastViewed: null,
      lastViewedStatus: "never-viewed",
    });
    expect(lastViewedOf(null, true, now).lastViewedStatus).toBe("not-recorded");
    expect(lastViewedOf(undefined).lastViewedStatus).toBe("not-recorded");
    expect(lastViewedOf("abc", true, now).lastViewedStatus).toBe("malformed");
    expect(lastViewedOf(-900000000, true, now).lastViewedStatus).toBe("malformed");
    expect(lastViewedOf(now / 1000, true, now).lastViewedStatus).toBe("malformed");
    expect(lastViewedOf(VIEWED, false, now).lastViewedStatus).toBe("unsupported");
  });
});

describe("wordCount and charCount", () => {
  it("count visible text and ignore attachment characters", () => {
    expect(wordCount("Title\nTwo  words \ufffc\n")).toBe(3);
    expect(wordCount("\ufffc")).toBe(0);
    expect(charCount("a\ufffcb\n😀")).toBe(4);
  });
});

describe("readNoteStructure (real sqlite3)", () => {
  let s: NoteStructure;
  beforeAll(() => {
    s = readNoteStructure(id(10), { dbPath: db });
  });

  it("reads note metadata, sharing through a parent folder, and the view date", () => {
    expect(s).toMatchObject({
      id: id(10),
      identifier: NOTE_UUID,
      deepLink: `notes://showNote?identifier=${NOTE_UUID}`,
      title: "Title",
      folder: "Folder A",
      account: "Fixture",
      inRecentlyDeleted: false,
      isShared: true,
      isLocked: false,
      isPinned: true,
      lastViewed: "2025-06-01T00:00:00.000Z",
      lastViewedStatus: "viewed",
      bodyDecoded: true,
      checklistTotal: 2,
      checklistDone: 1,
      hasDrawing: true,
      linksComplete: true,
      tags: ["Beta", "Alpha"],
    });
    expect(s.text!.startsWith("Title\nVisit Example")).toBe(true);
    expect(s.wordCount).toBe(9);
    expect(s.textLength).toBe(s.text!.length);
    expect(s.blockSummary!.blocks).toBe(9);
    expect(s.undecodedFields).toEqual({ attributeRun: {}, paragraphStyle: {} });
  });

  it("classifies every link kind in body order", () => {
    expect(s.linkCounts).toEqual({ inline: 2, card: 1, note: 1, section: 1 });
    expect(s.links.map((l) => [l.kind, l.url, l.text])).toEqual([
      ["inline", "https://example.com", "Example"],
      ["card", "https://example.com/a", "Example card"],
      ["section", `applenotes://showNote?identifier=${TARGET}&paragraphID=${PARA}`, "Plans"],
      ["note", `applenotes://showNote?identifier=${TARGET}`, "Other"],
      ["inline", "javascript:alert(1)", "bad"],
    ]);
    const section = s.links[2];
    expect(section).toMatchObject({
      targetNote: TARGET,
      paragraphId: PARA,
      section: "Plans",
      inBody: true,
    });
    expect(s.links[1].previewPath).toMatch(/CARD-1-1-600x315-0\/1_X\/Preview\.png$/);
    expect(s.links[1].attachmentId).toBe("x-coredata://F1C7-5E0A/ICAttachment/p25");
    expect(s.links[4].linkSafe).toBe(false);
  });

  it("lists attachments as list-attachments does: kinds, body order, nesting", () => {
    // Same classifier as list-attachments: a gallery is a scan. A child of a
    // child (DEEP) is left out and a tombstoned row (GONE) is skipped.
    const kinds = s.attachments.map((a) => [a.identifier, a.kind, a.inBody]);
    expect(kinds).toEqual([
      ["GAL-1", "scan", true],
      ["CARD-1", "url", true],
      ["IMG-1", "image", true],
      ["PAPER-1", "drawing", false],
      ["CARD-EMPTY", "url", false],
    ]);
    expect(s.attachmentCount).toBe(5);
    const gallery = s.attachments[0];
    expect(gallery.children!.map((c) => [c.identifier, c.kind, c.parentId])).toEqual([
      ["GAL-A", "image", "x-coredata://F1C7-5E0A/ICAttachment/p21"],
      ["GAL-B", "image", "x-coredata://F1C7-5E0A/ICAttachment/p21"],
    ]);
    expect(gallery.children![0].previewPath).toBeNull();
    const image = s.attachments[2];
    expect(image).toMatchObject({ filename: "photo.jpg", fileSize: 1234 });
    expect(image.previewPath).toMatch(/IMG-1-1-384x288-0\.png$/);
    expect(s.attachments[1]).toMatchObject({ title: "Example card", url: "https://example.com/a" });
    expect(s.firstImage).toMatchObject({
      id: "x-coredata://F1C7-5E0A/ICAttachment/p22",
      pk: 22,
      identifier: "GAL-A",
      kind: "image",
      path: null,
      previewPath: null,
      parentIdentifier: "GAL-1",
      galleryIndex: 0,
      orderSource: "body",
    });
  });

  it("omits text on request or when it exceeds the byte cap", () => {
    expect(readNoteStructure(id(10), { dbPath: db, includeText: false }).text).toBeUndefined();
    const capped = readNoteStructure(id(10), { dbPath: db, maxTextBytes: 4 });
    expect(capped.text).toBeUndefined();
    expect(capped.textOmitted).toBe(true);
    expect(capped.wordCount).toBe(9);
  });

  it("returns metadata without a body for locked, empty and undecodable notes", () => {
    const locked = readNoteStructure(id(11), { dbPath: db });
    expect(locked).toMatchObject({
      isLocked: true,
      bodyDecoded: false,
      bodyError: "encrypted",
      inRecentlyDeleted: true,
      lastViewed: null,
      lastViewedStatus: "never-viewed",
      wordCount: null,
      charCount: null,
      checklistTotal: null,
      linksComplete: false,
      blockSummary: null,
      attachments: [],
      firstImage: null,
    });
    expect(locked.undecodedFields).toBeUndefined();
    const empty = readNoteStructure(id(12), { dbPath: db });
    expect(empty).toMatchObject({
      bodyError: "no-body",
      isShared: true,
      lastViewedStatus: "not-recorded",
      folder: "Recently Deleted",
    });
    const broken = readNoteStructure(id(14), { dbPath: db });
    expect(broken).toMatchObject({ bodyError: "decompress-failed", lastViewedStatus: "malformed" });
    expect(broken.isShared).toBe(false);
    expect(broken.deepLink).toBeNull();
    expect(broken.inRecentlyDeleted).toBe(false);
  });

  it("treats a TrashFolder identifier as Recently Deleted without ZFOLDERTYPE", () => {
    expect(readNoteStructure(id(15), { dbPath: db })).toMatchObject({
      folder: "Trash",
      inRecentlyDeleted: true,
    });
  });

  it("reads a store without the optional columns", () => {
    const result = readNoteStructure(id(10), { dbPath: bare });
    expect(result).toMatchObject({
      identifier: "BARE-NOTE",
      title: null,
      isShared: null,
      isPinned: null,
      isLocked: false,
      lastViewedStatus: "unsupported",
      wordCount: 2,
      attachmentCount: 1,
    });
    expect(result.firstImage).toMatchObject({ identifier: "IMG-9", kind: "image" });
  });

  it("refuses bad ids, non-notes, missing notes and unreadable stores", () => {
    expect(code(() => readNoteStructure(id(3), { dbPath: db }))).toBe("invalid_input");
    expect(code(() => readNoteStructure(id(999), { dbPath: db }))).toBe("invalid_input");
    // Only the canonical x-coredata form reaches the reader; the tool schema
    // resolves a UUID or numeric key first.
    expect(code(() => readNoteStructure("x-coredata://X/ICNote/p1 OR 1", { dbPath: db }))).toBe(
      "invalid_id"
    );
    expect(code(() => readNoteStructure(NOTE_UUID, { dbPath: db }))).toBe("invalid_id");
    expect(code(() => readNoteStructure(id(10), { dbPath: join(dir, "none.sqlite") }))).toBe(
      "no_fda"
    );
  });

  it("binds only the primary key into the generated SQL", () => {
    const sql = noteStructureSql(new Set(["Z_PK", "Z_ENT", "ZIDENTIFIER"]));
    expect(sql).toContain("@pk");
    expect(sql).not.toMatch(/Z_PK = \d/);
    expect(sql).toContain("'shared', NULL");
  });
});

describe("describeNoteStructure", () => {
  it("summarizes decoded and undecoded notes", () => {
    const decoded = readNoteStructure(id(10), { dbPath: db });
    expect(describeNoteStructure(decoded)).toBe(
      "Note structure: 9 blocks, 9 words; 5 links (inline 2, card 1, note 1, section 1); 5 attachments; 2 tags; checklist 1/2 done; has a drawing; shared."
    );
    expect(describeNoteStructure(readNoteStructure(id(11), { dbPath: db }))).toBe(
      "Note structure: body not decoded (encrypted); 0 links (inline 0, card 0, note 0, section 0); 0 attachments; 0 tags; locked."
    );
  });
});
