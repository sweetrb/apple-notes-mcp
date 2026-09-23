/**
 * list-note-links' reader, run through the real /usr/bin/sqlite3 against a
 * synthetic fixture store with two accounts, nested and duplicate folders,
 * Recently Deleted, folderless and locked notes, link cards and native link
 * chips. The live NoteStore is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { NoteStoreError } from "./noteStoreSql.js";
import {
  describeLinkInventory,
  folderPaths,
  inventorySql,
  listNoteLinks,
  matchAccount,
  matchFolder,
  splitFolderPath,
} from "./noteLinkInventory.js";

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
const att = (id: string, uti: string) => b(12, Buffer.concat([b(1, id), b(2, uti)]));
const link = (url: string) => b(9, url);
const hex = (buf: Buffer) => `X'${buf.toString("hex")}'`;

const STORE = "5A0E-1234";
const TARGET = "0A1B2C3D-0000-4000-8000-00000000000C";
const PARA = "0A1B2C3D-0000-4000-8000-00000000000D";
const LINK_UTI = "com.apple.notes.inlinetextattachment.link";
const id = (pk: number) => `x-coredata://${STORE}/ICNote/p${pk}`;
// Apple-epoch seconds; larger is newer.
const T1 = 700000000;
const T2 = 710000000;
const T3 = 720000000;

let dir: string;
let db: string;
let noMeta: string;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof NoteStoreError ? error.code : String(error);
  }
  return "no error";
};
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
const SCHEMA = [
  "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE2 TEXT, ZTITLE TEXT, ZNAME TEXT, ZFOLDER INTEGER, ZFOLDERTYPE INTEGER, ZPARENT INTEGER, ZACCOUNT1 INTEGER, ZACCOUNT4 INTEGER, ZACCOUNT7 INTEGER, ZACCOUNT8 INTEGER, ZMODIFICATIONDATE1 REAL, ZMARKEDFORDELETION INTEGER, ZNOTE INTEGER, ZNOTE1 INTEGER, ZTYPEUTI TEXT, ZTYPEUTI1 TEXT, ZURLSTRING TEXT, ZATTACHMENT INTEGER, ZWIDTH REAL, ZHEIGHT REAL, ZSCALE REAL, ZAPPEARANCETYPE INTEGER, ZALTTEXT TEXT, ZTOKENCONTENTIDENTIFIER TEXT);",
  "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
  "CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID TEXT);",
  "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZDATA BLOB);",
  "INSERT INTO Z_PRIMARYKEY VALUES (3,'ICNote'),(4,'ICAttachment'),(5,'ICInlineAttachment'),(6,'ICAttachmentPreviewImage'),(7,'ICFolder'),(8,'ICAccount');",
].join("\n");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-link-inventory-"));
  db = join(dir, "NoteStore.sqlite");
  const previews = join(dir, "Accounts", "ACCT-A", "Previews");
  mkdirSync(previews, { recursive: true });
  writeFileSync(join(previews, "CARD-A-1-600x315-0.png"), "png");

  const rows: string[] = [
    SCHEMA,
    `INSERT INTO Z_METADATA VALUES (1, '${STORE}');`,
    insert({ Z_PK: 1, Z_ENT: 8, ZNAME: "iCloud", ZIDENTIFIER: "ACCT-A" }),
    insert({ Z_PK: 2, Z_ENT: 8, ZNAME: "Work", ZIDENTIFIER: "ACCT-B" }),
    insert({ Z_PK: 10, Z_ENT: 7, ZTITLE2: "Projects", ZACCOUNT8: 1 }),
    insert({ Z_PK: 11, Z_ENT: 7, ZTITLE2: "Clients", ZPARENT: 10, ZACCOUNT8: 1 }),
    insert({ Z_PK: 12, Z_ENT: 7, ZTITLE2: "Clients", ZACCOUNT8: 2 }),
    insert({ Z_PK: 13, Z_ENT: 7, ZTITLE2: "A/B", ZACCOUNT8: 1 }),
    insert({ Z_PK: 14, Z_ENT: 7, ZTITLE2: "Recently Deleted", ZFOLDERTYPE: 1, ZACCOUNT8: 1 }),
    insert({ Z_PK: 15, Z_ENT: 7, ZTITLE2: "Gone", ZMARKEDFORDELETION: 1, ZACCOUNT8: 1 }),
    // Notes: 20 (Projects/Clients, newest), 21 (A/B), 22 (Work/Clients), 23 (trash),
    // 24 (folderless), 25 (locked, Projects), 26 (no body row, Projects).
    insert({
      Z_PK: 20,
      Z_ENT: 3,
      ZIDENTIFIER: "N20",
      ZTITLE1: "Client plan",
      ZFOLDER: 11,
      ZACCOUNT7: 1,
      ZMODIFICATIONDATE1: T3,
    }),
    insert({
      Z_PK: 21,
      Z_ENT: 3,
      ZIDENTIFIER: "N21",
      ZTITLE1: "Slash",
      ZFOLDER: 13,
      ZACCOUNT7: 1,
      ZMODIFICATIONDATE1: T2,
    }),
    insert({
      Z_PK: 22,
      Z_ENT: 3,
      ZIDENTIFIER: "N22",
      ZTITLE1: "Work note",
      ZFOLDER: 12,
      ZACCOUNT7: 2,
      ZMODIFICATIONDATE1: T1,
    }),
    insert({
      Z_PK: 23,
      Z_ENT: 3,
      ZIDENTIFIER: "N23",
      ZTITLE1: "Trashed",
      ZFOLDER: 14,
      ZACCOUNT7: 1,
      ZMODIFICATIONDATE1: T1,
    }),
    insert({ Z_PK: 24, Z_ENT: 3, ZIDENTIFIER: "N24", ZACCOUNT7: 1 }),
    insert({
      Z_PK: 25,
      Z_ENT: 3,
      ZIDENTIFIER: "N25",
      ZTITLE1: "Locked",
      ZFOLDER: 10,
      ZACCOUNT7: 1,
    }),
    insert({ Z_PK: 26, Z_ENT: 3, ZIDENTIFIER: "N26", ZTITLE1: "Empty", ZFOLDER: 10, ZACCOUNT7: 1 }),
    // A card in note 20 (in body), one in note 22 (not in body), one in the trashed note.
    insert({
      Z_PK: 40,
      Z_ENT: 4,
      ZIDENTIFIER: "CARD-A",
      ZTYPEUTI: "public.url",
      ZNOTE: 20,
      ZURLSTRING: "https://example.com/card",
      ZTITLE: "Card",
      ZACCOUNT1: 1,
    }),
    insert({
      Z_PK: 41,
      Z_ENT: 4,
      ZIDENTIFIER: "CARD-B",
      ZTYPEUTI: "public.url",
      ZNOTE: 22,
      ZURLSTRING: "https://example.org/b",
      ZACCOUNT1: 2,
    }),
    insert({
      Z_PK: 42,
      Z_ENT: 4,
      ZIDENTIFIER: "CARD-T",
      ZTYPEUTI: "public.url",
      ZNOTE: 23,
      ZURLSTRING: "https://example.net/t",
    }),
    insert({
      Z_PK: 43,
      Z_ENT: 4,
      ZIDENTIFIER: "CARD-X",
      ZTYPEUTI: "public.url",
      ZNOTE: 20,
      ZURLSTRING: "https://example.com/x",
      ZMARKEDFORDELETION: 1,
    }),
    insert({
      Z_PK: 50,
      Z_ENT: 6,
      ZATTACHMENT: 40,
      ZIDENTIFIER: "CARD-A-1-600x315-0",
      ZWIDTH: 600,
      ZHEIGHT: 315,
    }),
    // Native chips in note 21: a section link and a note link; one chip without a URL.
    insert({
      Z_PK: 60,
      Z_ENT: 5,
      ZIDENTIFIER: "CHIP-S",
      ZTYPEUTI1: LINK_UTI,
      ZNOTE1: 21,
      ZALTTEXT: "Goals",
      ZTOKENCONTENTIDENTIFIER: `applenotes://showNote?identifier=${TARGET}&paragraphID=${PARA}`,
      ZACCOUNT4: 1,
    }),
    insert({
      Z_PK: 61,
      Z_ENT: 5,
      ZIDENTIFIER: "CHIP-N",
      ZTYPEUTI1: LINK_UTI,
      ZNOTE1: 21,
      ZALTTEXT: "Other",
      ZTOKENCONTENTIDENTIFIER: `applenotes://showNote?identifier=${TARGET}`,
    }),
    insert({ Z_PK: 62, Z_ENT: 5, ZIDENTIFIER: "CHIP-0", ZTYPEUTI1: LINK_UTI, ZNOTE1: 21 }),
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (20, ${hex(
      body([
        ["Plan "],
        ["site", link("https://example.com")],
        ["\n"],
        ["\ufffc", att("CARD-A", "public.url")],
      ])
    )});`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (21, ${hex(
      body([
        ["See \ufffc", att("CHIP-S", LINK_UTI)],
        [" and \ufffc", att("CHIP-N", LINK_UTI)],
      ])
    )});`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (22, ${hex(body([["mail", link("mailto:a@example.com")]]))});`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (23, ${hex(body([["old", link("https://example.net/old")]]))});`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (24, ${hex(body([["x", link("https://example.net/x")]]))});`,
    `INSERT INTO ZICNOTEDATA (ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZDATA) VALUES (25, X'00', X'0102');`,
  ];
  // 105 more notes in Projects, each with one inline link, so body decoding spans two batches.
  for (let i = 0; i < 105; i++) {
    const pk = 100 + i;
    rows.push(
      insert({
        Z_PK: pk,
        Z_ENT: 3,
        ZIDENTIFIER: `B${pk}`,
        ZFOLDER: 10,
        ZACCOUNT7: 1,
        ZMODIFICATIONDATE1: T1 - pk,
      })
    );
    rows.push(
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (${pk}, ${hex(body([["l", link(`https://example.com/${pk}`)]]))});`
    );
  }
  // One note whose body is not gzip.
  rows.push(insert({ Z_PK: 300, Z_ENT: 3, ZIDENTIFIER: "BAD", ZFOLDER: 10, ZACCOUNT7: 1 }));
  rows.push("INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (300, X'0102');");
  execFileSync("/usr/bin/sqlite3", [db, rows.join("\n")]);

  noMeta = join(dir, "NoMeta.sqlite");
  execFileSync("/usr/bin/sqlite3", [
    noMeta,
    [
      SCHEMA,
      insert({ Z_PK: 10, Z_ENT: 7, ZTITLE2: "F" }),
      insert({ Z_PK: 20, Z_ENT: 3, ZFOLDER: 10 }),
      insert({
        Z_PK: 40,
        Z_ENT: 4,
        ZIDENTIFIER: "C",
        ZNOTE: 20,
        ZURLSTRING: "https://example.com",
      }),
    ].join("\n"),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("folder and account matching", () => {
  const folders = [
    { pk: 1, title: "Projects", parent: null, account: 1, type: 0 },
    { pk: 2, title: "Clients", parent: 1, account: 1, type: 0 },
    { pk: 3, title: "Clients", parent: null, account: 2, type: 0 },
    { pk: 4, title: "A/B", parent: null, account: 1, type: 0 },
    { pk: 5, title: null, parent: 6, account: 1, type: 0 },
    { pk: 6, title: "Loop", parent: 5, account: 1, type: 0 },
  ];

  it("splits paths on unescaped slashes", () => {
    expect(splitFolderPath("Work/Clients")).toEqual(["Work", "Clients"]);
    expect(splitFolderPath("Travel/Spain\\/Portugal/")).toEqual(["Travel", "Spain/Portugal"]);
  });

  it("builds escaped full paths and survives parent cycles", () => {
    const paths = folderPaths(folders);
    expect(paths.get(2)).toBe("Projects/Clients");
    expect(paths.get(4)).toBe("A\\/B");
    expect(paths.get(5)).toBe("Loop/");
  });

  it("matches by path, by unique name, and within one account", () => {
    expect(matchFolder(folders, "Projects/Clients")).toEqual({ pk: 2, path: "Projects/Clients" });
    expect(matchFolder(folders, "A\\/B").pk).toBe(4);
    expect(matchFolder(folders, "A/B").pk).toBe(4);
    expect(matchFolder(folders, "Clients", 2).pk).toBe(3);
    expect(code(() => matchFolder(folders, "Clients"))).toBe("invalid-argument");
    expect(code(() => matchFolder(folders, "Nope"))).toBe("not-found");
  });

  it("matches accounts by identifier or case-insensitive name", () => {
    const accounts = [
      { pk: 1, name: "iCloud", identifier: "A" },
      { pk: 2, name: "Work", identifier: "B" },
      { pk: 3, name: "work", identifier: "C" },
      { pk: 4, name: null, identifier: "D" },
    ];
    expect(matchAccount(accounts, "ICLOUD").pk).toBe(1);
    expect(matchAccount(accounts, "C").pk).toBe(3);
    expect(code(() => matchAccount(accounts, "Work"))).toBe("invalid-argument");
    expect(code(() => matchAccount(accounts, "Other"))).toBe("not-found");
  });
});

describe("listNoteLinks (real sqlite3)", () => {
  it("lists cards and chips across the library without decoding bodies", () => {
    const r = listNoteLinks({ dbPath: db, limit: 2000 });
    expect(r.inlineIncluded).toBe(false);
    expect(r.notesInScope).toBe(111);
    expect(r.notesWithoutBody).toBe(0);
    expect(r.counts).toEqual({ inline: 0, card: 2, note: 1, section: 1 });
    expect(r.links.map((l) => [l.kind, l.noteId, l.folderPath, l.account])).toEqual([
      ["card", id(20), "Projects/Clients", "iCloud"],
      // Without decoded bodies there are no positions: kinds order within a note.
      ["note", id(21), "A\\/B", "iCloud"],
      ["section", id(21), "A\\/B", "iCloud"],
      ["card", id(22), "Clients", "Work"],
    ]);
    const card = r.links[0];
    expect(card).toMatchObject({
      url: "https://example.com/card",
      text: "Card",
      noteTitle: "Client plan",
      noteIdentifier: "N20",
      noteModified: new Date((T3 + 978307200) * 1000).toISOString(),
      accountIdentifier: "ACCT-A",
      attachmentId: `x-coredata://${STORE}/ICAttachment/p40`,
    });
    expect(card.previewPath).toMatch(/CARD-A-1-600x315-0\.png$/);
    expect(card.inBody).toBeUndefined();
    expect(r.links[3].previewPath).toBeNull();
    expect(r.links[2]).toMatchObject({ targetNote: TARGET, paragraphId: PARA, section: "Goals" });
  });

  it("decodes bodies in batches for inline links on request", () => {
    const r = listNoteLinks({ dbPath: db, includeInline: true, limit: 2000 });
    expect(r.inlineIncluded).toBe(true);
    // 105 batch notes + note 20 + note 22; the trashed and folderless notes are out of scope.
    expect(r.counts).toEqual({ inline: 107, card: 2, note: 1, section: 1 });
    expect(r.notesWithoutBody).toBe(3);
    const first = r.links.slice(0, 2).map((l) => [l.kind, l.url, l.inBody, l.start]);
    expect(first).toEqual([
      ["inline", "https://example.com", undefined, 5],
      ["card", "https://example.com/card", true, 10],
    ]);
    expect(r.links.find((l) => l.kind === "section")!.inBody).toBe(true);
    expect(r.links.find((l) => l.url === "https://example.org/b")!.inBody).toBe(false);
  });

  it("scopes by account and by folder", () => {
    const work = listNoteLinks({ dbPath: db, account: "work", includeInline: true });
    expect(work.scope).toEqual({ account: "Work", accountIdentifier: "ACCT-B" });
    expect(work.links.map((l) => l.url)).toEqual(["mailto:a@example.com", "https://example.org/b"]);
    const clients = listNoteLinks({ dbPath: db, account: "ACCT-A", folder: "Clients" });
    expect(clients.scope).toMatchObject({ folder: "Clients", folderPath: "Projects/Clients" });
    expect(clients.links.map((l) => l.kind)).toEqual(["card"]);
    const slash = listNoteLinks({ dbPath: db, folder: "A\\/B", kinds: ["section"] });
    expect(slash.links.map((l) => l.kind)).toEqual(["section"]);
    expect(slash.counts).toEqual({ inline: 0, card: 0, note: 0, section: 1 });
  });

  it("reads one note by id, including one in Recently Deleted", () => {
    const one = listNoteLinks({ dbPath: db, id: id(23) });
    expect(one.inlineIncluded).toBe(true);
    expect(one.scope).toEqual({ note: id(23) });
    expect(one.links.map((l) => [l.kind, l.url, l.folder])).toEqual([
      ["inline", "https://example.net/old", "Recently Deleted"],
      ["card", "https://example.net/t", "Recently Deleted"],
    ]);
    const locked = listNoteLinks({ dbPath: db, id: id(25) });
    expect(locked.notesWithoutBody).toBe(1);
    expect(locked.links).toEqual([]);
    const cardsOnly = listNoteLinks({ dbPath: db, id: id(20), includeInline: false });
    expect(cardsOnly.links.map((l) => l.kind)).toEqual(["card"]);
  });

  it("pages by offset, limit and byte cap", () => {
    const p = listNoteLinks({ dbPath: db, includeInline: true, offset: 3, limit: 5 });
    expect(p.page).toEqual({ offset: 3, returned: 5, total: 111, hasMore: true, nextOffset: 8 });
    const capped = listNoteLinks({ dbPath: db, includeInline: true, maxBytes: 10 });
    expect(capped.page.returned).toBe(1);
    const past = listNoteLinks({ dbPath: db, offset: 500 });
    expect(past.page).toEqual({ offset: 4, returned: 0, total: 4, hasMore: false });
  });

  it("returns null note ids when the store UUID is unknown", () => {
    const r = listNoteLinks({ dbPath: noMeta });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ noteId: null, folder: "F", account: null });
    expect(r.links[0].attachmentId).toBeUndefined();
  });

  it("refuses conflicting or unknown selectors and unreadable stores", () => {
    expect(code(() => listNoteLinks({ dbPath: db, id: id(20), folder: "Projects" }))).toBe(
      "invalid-argument"
    );
    expect(code(() => listNoteLinks({ dbPath: db, id: id(999) }))).toBe("not-found");
    expect(code(() => listNoteLinks({ dbPath: db, id: "x-coredata://X/ICNote/p1 OR 1" }))).toBe(
      "invalid-id"
    );
    expect(code(() => listNoteLinks({ dbPath: db, folder: "Clients" }))).toBe("invalid-argument");
    expect(code(() => listNoteLinks({ dbPath: db, account: "Nobody" }))).toBe("not-found");
    expect(code(() => listNoteLinks({ dbPath: join(dir, "none.sqlite") }))).toBe(
      "no-full-disk-access"
    );
  });

  it("binds only integers into the generated SQL", () => {
    const sql = inventorySql(new Set(["Z_PK", "Z_ENT"]));
    expect(sql.rows).toContain("@note");
    expect(sql.bodies).toContain("@after");
    expect(sql.folders).not.toMatch(/'Clients'|'Work'/);
  });
});

describe("describeLinkInventory", () => {
  it("summarizes a page and says when inline links were not scanned", () => {
    expect(describeLinkInventory(listNoteLinks({ dbPath: db, limit: 2 }))).toBe(
      "Found 4 links in 111 notes (inline 0 not scanned, card 2, note 1, section 1); returned 2 from offset 0; more at offset 2."
    );
    expect(describeLinkInventory(listNoteLinks({ dbPath: db, id: id(22) }))).toBe(
      "Found 2 links in 1 notes (inline 1, card 1, note 0, section 0); returned 2 from offset 0."
    );
  });
});
