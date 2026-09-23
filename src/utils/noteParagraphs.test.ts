/**
 * Paragraph listing and direct paragraph links. Pure functions are tested on
 * synthetic protobuf bodies; the store reader runs through the real
 * /usr/bin/sqlite3 against a throwaway fixture database. The live NoteStore
 * is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { decodeNoteBlocks } from "./noteBlocks.js";
import { NoteStoreError } from "./noteStoreSql.js";
import {
  classifyParagraphIds,
  noteListSql,
  normalizeParagraphText,
  pageParagraphs,
  paragraphLink,
  ParagraphLinkError,
  paragraphsOf,
  paragraphUrl,
  readNoteParagraphs,
  resolveNote,
  runParagraphIds,
  selectParagraph,
  type NoteParagraph,
} from "./noteParagraphs.js";

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
const uuid = (fill: number) => Buffer.alloc(16, fill);
const U = (fill: number) => {
  const h = uuid(fill).toString("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** A run with an optional paragraph style type and paragraph UUID. */
type Seg = [text: string, style?: number | null, id?: number];
const raw = (segs: Seg[]) => {
  const text = segs.map(([t]) => t).join("");
  const runs = segs.map(([t, style, id]) => {
    const para =
      style === undefined && id === undefined
        ? []
        : [
            b(
              2,
              Buffer.concat([
                ...(style === null || style === undefined ? [] : [n(1, style)]),
                ...(id === undefined ? [] : [b(9, uuid(id))]),
              ])
            ),
          ];
    return b(5, Buffer.concat([n(1, t.length), ...para]));
  });
  return b(2, b(3, Buffer.concat([b(2, text), ...runs])));
};

const NOTE_UUID = "0A1B2C3D-0000-4000-8000-00000000000A";
const segs: Seg[] = [
  ["Title\n", 0, 0xa1],
  ["Intro one\nIntro two\n", null, 0xb2], // one run across two paragraphs: shared
  ["Head\n", 1, 0xc3],
  ["Mixed ", null, 0xd4],
  ["part\n", null, 0xe5], // first-run ID unique, runs mixed
  ["Later\n", null, 0xb2], // repeats B2 non-adjacently
  ["\n", null, 0xf6], // empty paragraph: not listed
  ["\ufffc\n", null, 0x17], // attachment-only paragraph: not listed
  ["No id"], // no paragraph style at all
];
const data = raw(segs);
const doc = decodeNoteBlocks(data);
const runs = runParagraphIds(data);

describe("helpers", () => {
  it("normalizes width, case, spacing and attachment characters", () => {
    expect(normalizeParagraphText("  Ｈｅｌｌｏ \tWORLD \ufffc ")).toBe("hello world");
    expect(normalizeParagraphText("\ufffc \n")).toBe("");
  });

  it("builds the Notes paragraph URL with uppercase UUIDs", () => {
    expect(paragraphUrl(NOTE_UUID.toLowerCase(), U(0xc3).toLowerCase())).toBe(
      `applenotes://showNote?identifier=${NOTE_UUID}&paragraphID=${U(0xc3)}`
    );
  });

  it("reads the paragraph UUID of every run", () => {
    expect(runs.map((r) => [r.start, r.length, r.paragraphId])).toEqual([
      [0, 6, U(0xa1)],
      [6, 20, U(0xb2)],
      [26, 5, U(0xc3)],
      [31, 6, U(0xd4)],
      [37, 5, U(0xe5)],
      [42, 6, U(0xb2)],
      [48, 1, U(0xf6)],
      [49, 2, U(0x17)],
      [51, 5, undefined],
    ]);
  });
});

describe("classifyParagraphIds and paragraphsOf", () => {
  it("marks IDs repeated anywhere in the note as shared", () => {
    const ids = classifyParagraphIds(doc, runs);
    expect(ids.map((i) => [i.status, i.sharedWith, i.mixed])).toEqual([
      ["unique", undefined, false],
      ["shared", 2, false],
      ["shared", 2, false],
      ["unique", undefined, false],
      ["unique", undefined, true],
      ["shared", 2, false],
      ["unique", undefined, false],
      ["unique", undefined, false],
      ["missing", undefined, false],
    ]);
  });

  it("lists non-empty paragraphs with a url only for unique IDs", () => {
    const paragraphs = paragraphsOf(doc, runs, NOTE_UUID);
    expect(paragraphs.map((p) => [p.blockIndex, p.text, p.style, p.paragraphIdStatus])).toEqual([
      [0, "Title", "title", "unique"],
      [1, "Intro one", "body", "shared"],
      [2, "Intro two", "body", "shared"],
      [3, "Head", "heading", "unique"],
      [4, "Mixed part", "body", "unique"],
      [5, "Later", "body", "shared"],
      [8, "No id", "body", "missing"],
    ]);
    expect(paragraphs[3].url).toBe(
      `applenotes://showNote?identifier=${NOTE_UUID}&paragraphID=${U(0xc3)}`
    );
    expect(paragraphs[4].mixedParagraphIds).toBe(true);
    expect(paragraphs[1].url).toBeUndefined();
    expect(paragraphs[1].sharedWith).toBe(2);
    expect(paragraphs[6].paragraphId).toBeNull();
    expect(paragraphsOf(doc, runs, null)[0].url).toBeUndefined();
  });
});

describe("selectParagraph and paragraphLink", () => {
  const paragraphs = paragraphsOf(doc, runs, NOTE_UUID);
  const note = {
    id: "x",
    identifier: NOTE_UUID,
    paragraphs,
    counts: { unique: 4, shared: 3, missing: 1 },
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof ParagraphLinkError || error instanceof NoteStoreError) return error.code;
      return String(error);
    }
    return "no error";
  };

  it("selects by snippet, whole text, block index and occurrence", () => {
    expect(selectParagraph(paragraphs, { contains: "HEAD" }).blockIndex).toBe(3);
    expect(selectParagraph(paragraphs, { match: "  mixed   PART " }).blockIndex).toBe(4);
    expect(selectParagraph(paragraphs, { blockIndex: 5 }).text).toBe("Later");
    expect(selectParagraph(paragraphs, { contains: "intro", occurrence: 2 }).blockIndex).toBe(2);
    expect(selectParagraph(paragraphs, { match: "later", occurrence: 1 }).blockIndex).toBe(5);
  });

  it("refuses ambiguous, missing and malformed selections", () => {
    expect(code(() => selectParagraph(paragraphs, { contains: "intro" }))).toBe(
      "ambiguous-paragraph"
    );
    expect(code(() => selectParagraph(paragraphs, { contains: "intro", occurrence: 3 }))).toBe(
      "occurrence-out-of-range"
    );
    expect(code(() => selectParagraph(paragraphs, { contains: "absent" }))).toBe("no-match");
    expect(code(() => selectParagraph(paragraphs, { match: "Intro" }))).toBe("no-match");
    expect(code(() => selectParagraph(paragraphs, { blockIndex: 6 }))).toBe("no-match");
    expect(code(() => selectParagraph(paragraphs, {}))).toBe("invalid-argument");
    expect(code(() => selectParagraph(paragraphs, { contains: "a", blockIndex: 1 }))).toBe(
      "invalid-argument"
    );
    expect(code(() => selectParagraph(paragraphs, { contains: " \ufffc " }))).toBe(
      "invalid-argument"
    );
  });

  it("returns a link only for a unique ID and says why otherwise", () => {
    expect(paragraphLink(note, { contains: "head" })).toEqual({
      url: `applenotes://showNote?identifier=${NOTE_UUID}&paragraphID=${U(0xc3)}`,
      paragraph: paragraphs[3],
    });
    expect(paragraphLink(note, { contains: "mixed" }).paragraph.blockIndex).toBe(4);
    expect(code(() => paragraphLink(note, { contains: "later" }))).toBe("paragraph-id-shared");
    expect(code(() => paragraphLink(note, { contains: "no id" }))).toBe("paragraph-id-missing");
    const anonymous = { ...note, paragraphs: paragraphsOf(doc, runs, null) };
    expect(code(() => paragraphLink(anonymous, { contains: "head" }))).toBe("paragraph-id-missing");
  });

  it("pages paragraphs and can keep only linkable ones", () => {
    expect(pageParagraphs(paragraphs, { offset: 2, limit: 2 }).page).toEqual({
      offset: 2,
      returned: 2,
      total: 7,
      hasMore: true,
      nextOffset: 4,
    });
    const linkable = pageParagraphs(paragraphs, { linkableOnly: true });
    expect(linkable.paragraphs.map((p) => p.blockIndex)).toEqual([0, 3, 4]);
    expect(linkable.page.hasMore).toBe(false);
    expect(pageParagraphs(paragraphs, { maxBytes: 1 }).page.returned).toBe(1);
    expect(pageParagraphs(paragraphs, { offset: 99 }).page).toEqual({
      offset: 7,
      returned: 0,
      total: 7,
      hasMore: false,
    });
    expect(pageParagraphs([] as NoteParagraph[]).paragraphs).toEqual([]);
  });
});

describe("readNoteParagraphs (real sqlite3)", () => {
  let dir: string;
  let db: string;
  const STORE = "5A0E-9999";
  const id = (pk: number) => `x-coredata://${STORE}/ICNote/p${pk}`;
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof ParagraphLinkError || error instanceof NoteStoreError) return error.code;
      return String(error);
    }
    return "no error";
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "note-paragraphs-"));
    db = join(dir, "NoteStore.sqlite");
    const hex = (buf: Buffer) => `X'${buf.toString("hex")}'`;
    execFileSync("/usr/bin/sqlite3", [
      db,
      [
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE2 TEXT, ZFOLDER INTEGER, ZPARENT INTEGER, ZFOLDERTYPE INTEGER, ZISPASSWORDPROTECTED INTEGER, ZMARKEDFORDELETION INTEGER);",
        "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
        "CREATE TABLE Z_METADATA (Z_UUID TEXT);",
        "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);",
        "INSERT INTO Z_PRIMARYKEY VALUES (3, 'ICNote'), (7, 'ICFolder');",
        `INSERT INTO Z_METADATA VALUES ('${STORE}');`,
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZPARENT, ZFOLDERTYPE) VALUES (1, 7, 'Work', NULL, 0), (2, 7, 'Clients', 1, 0), (3, 7, 'Home', NULL, 0), (4, 7, 'Recently Deleted', NULL, 1);",
        `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER) VALUES (10, 3, '${NOTE_UUID}', 'Plan', 2), (11, 3, 'N11', 'Plan', 3), (12, 3, 'N12', 'Plan', 4), (13, 3, 'N13', 'Locked', 3), (14, 3, 'N14', 'Empty', 3), (15, 3, 'N15', 'Broken', 3);`,
        "UPDATE ZICCLOUDSYNCINGOBJECT SET ZISPASSWORDPROTECTED = 1 WHERE Z_PK = 13;",
        `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (10, ${hex(gzipSync(data))});`,
        `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (11, ${hex(gzipSync(raw([["Other\n", 1, 0x99]])))});`,
        "INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (13, X'00', X'0102');",
        "INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (15, X'0102');",
      ].join("\n"),
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads paragraphs by id with counts", () => {
    const r = readNoteParagraphs({ id: id(10) }, { dbPath: db });
    expect(r.id).toBe(id(10));
    expect(r.identifier).toBe(NOTE_UUID);
    expect(r.counts).toEqual({ unique: 3, shared: 3, missing: 1 });
    expect(r.paragraphs.find((p) => p.text === "Head")!.url).toBe(
      `applenotes://showNote?identifier=${NOTE_UUID}&paragraphID=${U(0xc3)}`
    );
  });

  it("selects a note by identifier or by title narrowed with a folder name or path", () => {
    expect(readNoteParagraphs({ identifier: NOTE_UUID.toLowerCase() }, { dbPath: db }).id).toBe(
      id(10)
    );
    expect(readNoteParagraphs({ title: "Plan", folder: "Work/Clients" }, { dbPath: db }).id).toBe(
      id(10)
    );
    expect(
      readNoteParagraphs({ title: "Plan", folder: "Home" }, { dbPath: db }).paragraphs
    ).toHaveLength(1);
    // The copy in Recently Deleted is ignored for title lookups.
    expect(code(() => readNoteParagraphs({ title: "Plan" }, { dbPath: db }))).toBe(
      "ambiguous-note"
    );
    expect(code(() => readNoteParagraphs({ title: "Nope" }, { dbPath: db }))).toBe("not-found");
    expect(code(() => readNoteParagraphs({ title: "Plan", folder: "Nope" }, { dbPath: db }))).toBe(
      "not-found"
    );
  });

  it("refuses locked, empty, undecodable and missing notes", () => {
    expect(code(() => readNoteParagraphs({ id: id(13) }, { dbPath: db }))).toBe("encrypted");
    expect(code(() => readNoteParagraphs({ id: id(14) }, { dbPath: db }))).toBe("no-body");
    expect(code(() => readNoteParagraphs({ id: id(15) }, { dbPath: db }))).toBe("no-body");
    expect(code(() => readNoteParagraphs({ id: id(1) }, { dbPath: db }))).toBe("not-found");
    expect(code(() => readNoteParagraphs({ id: id(99) }, { dbPath: db }))).toBe("not-found");
    expect(code(() => readNoteParagraphs({ id: id(10) }, { dbPath: join(dir, "x.sqlite") }))).toBe(
      "no-full-disk-access"
    );
  });

  it("validates the note selector", () => {
    const columns = new Set(["Z_PK", "Z_ENT"]);
    expect(code(() => resolveNote(db, columns, {}))).toBe("invalid-argument");
    expect(code(() => resolveNote(db, columns, { id: id(10), title: "Plan" }))).toBe(
      "invalid-argument"
    );
    expect(code(() => resolveNote(db, columns, { id: id(10), folder: "Work" }))).toBe(
      "invalid-argument"
    );
    expect(code(() => resolveNote(db, columns, { id: "x-coredata://X/ICNote/p1 OR 1" }))).toBe(
      "invalid-id"
    );
  });

  it("returns a null id when the store UUID is unknown", () => {
    execFileSync("/usr/bin/sqlite3", [db, "DELETE FROM Z_METADATA;"]);
    expect(readNoteParagraphs({ identifier: NOTE_UUID }, { dbPath: db }).id).toBeNull();
  });

  it("generates SQL without user text", () => {
    const sql = noteListSql(new Set(["Z_PK", "Z_ENT", "ZTITLE1"]));
    expect(sql).toContain("n.ZTITLE1");
    expect(sql).not.toContain("Plan");
  });
});
