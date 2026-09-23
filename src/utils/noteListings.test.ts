/**
 * Tests for the database-backed special listings and tag inventory.
 *
 * Execution is not mocked: each suite builds a throwaway NoteStore-shaped
 * database in a temp directory and runs the generated SQL through the real
 * sqlite3 CLI, so a SQL error cannot hide behind a mock. Entity numbers differ
 * from a real store's, so the SQL must look them up in Z_PRIMARYKEY. All data
 * is synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  assembleInventory,
  buildSpecialNotesSql,
  buildTagInventorySql,
  kindSupported,
  listSpecialNotes,
  nativeTagInventory,
  referencedObjects,
} from "./noteListings.js";
import { NoteStoreError } from "./noteStoreSql.js";

// --- protobuf fixture encoding ------------------------------------------------

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
};
const vField = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const lField = (field: number, data: number[] | string) => {
  const bytes = typeof data === "string" ? [...Buffer.from(data, "utf8")] : data;
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
};

/** Gzipped note body whose text is `prefix` followed by one inline object per id. */
function bodyHex(prefix: string, objectIds: string[] = []): string {
  // One U+FFFC OBJECT REPLACEMENT CHARACTER per inline object.
  const text = prefix + String.fromCharCode(0xfffc).repeat(objectIds.length);
  const runs = [lField(5, vField(1, prefix.length))];
  for (const id of objectIds) {
    runs.push(
      lField(5, [
        ...vField(1, 1),
        ...lField(12, [
          ...lField(1, id),
          ...lField(2, "com.apple.notes.inlinetextattachment.hashtag"),
        ]),
      ])
    );
  }
  const note = [...lField(2, text), ...runs.flat()];
  return gzipSync(Buffer.from(lField(2, lField(3, note)))).toString("hex");
}

// --- fixture store ------------------------------------------------------------

const UUID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ENT = { note: 41, folder: 42, account: 43, hashtag: 44, inline: 45 };
const FULL = [
  "ZIDENTIFIER TEXT",
  "ZTITLE1 TEXT",
  "ZTITLE2 TEXT",
  "ZNAME TEXT",
  "ZFOLDER INTEGER",
  "ZPARENT INTEGER",
  "ZOWNER INTEGER",
  "ZFOLDERTYPE INTEGER",
  "ZMARKEDFORDELETION INTEGER",
  "ZISPINNED INTEGER",
  "ZISSYSTEMPAPER INTEGER",
  "ZISPASSWORDPROTECTED INTEGER",
  "ZPASSWORDHINT TEXT",
  "ZSNIPPET TEXT",
  "ZCREATIONDATE1 REAL",
  "ZCREATIONDATE3 REAL",
  "ZMODIFICATIONDATE1 REAL",
  "ZACCOUNT4 INTEGER",
  "ZACCOUNT7 INTEGER",
  "ZNOTE1 INTEGER",
  "ZTYPEUTI1 TEXT",
  "ZALTTEXT TEXT",
  "ZDISPLAYTEXT TEXT",
];
const HASHTAG = "com.apple.notes.inlinetextattachment.hashtag";

type Row = Record<string, string | number | null>;

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  return typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;
}

function buildStore(dir: string, name: string, columns: string[], rows: Row[], bodies: Row[]) {
  const file = join(dir, name);
  const available = new Set(columns.map((c) => c.split(" ")[0]));
  const statements = [
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT);",
    `INSERT INTO Z_PRIMARYKEY VALUES (${ENT.note},'ICNote'),(${ENT.folder},'ICFolder'),(${ENT.account},'ICAccount'),(${ENT.inline},'ICInlineAttachment')${
      available.has("ZDISPLAYTEXT") ? `,(${ENT.hashtag},'ICHashtag')` : ""
    };`,
    "CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID TEXT);",
    `INSERT INTO Z_METADATA VALUES (1, '${UUID}');`,
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ${columns.join(", ")});`,
    "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);",
  ];
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => k === "Z_PK" || k === "Z_ENT" || available.has(k));
    statements.push(
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (${keys.join(", ")}) VALUES (${keys.map((k) => sqlValue(row[k])).join(", ")});`
    );
  }
  for (const body of bodies) {
    statements.push(
      `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (${body.note}, X'${body.hex as string}');`
    );
  }
  execFileSync("sqlite3", [file], { input: statements.join("\n") });
  return file;
}

const account = (pk: number, name: string, extra: Row = {}): Row => ({
  Z_PK: pk,
  Z_ENT: ENT.account,
  ZNAME: name,
  ZIDENTIFIER: `ACC${pk}`,
  ...extra,
});
const folder = (pk: number, name: string, owner: number, extra: Row = {}): Row => ({
  Z_PK: pk,
  Z_ENT: ENT.folder,
  ZTITLE2: name,
  ZOWNER: owner,
  ZIDENTIFIER: `FOLDER${pk}`,
  ...extra,
});
const note = (pk: number, folderPk: number | null, extra: Row = {}): Row => ({
  Z_PK: pk,
  Z_ENT: ENT.note,
  ZTITLE1: `Synthetic ${pk}`,
  ZIDENTIFIER: `NOTE-${pk}`,
  ZFOLDER: folderPk,
  ZSNIPPET: `snippet ${pk}`,
  ZCREATIONDATE3: 1000,
  ...extra,
});
const inline = (pk: number, notePk: number, id: string, text: string, extra: Row = {}): Row => ({
  Z_PK: pk,
  Z_ENT: ENT.inline,
  ZNOTE1: notePk,
  ZIDENTIFIER: id,
  ZTYPEUTI1: HASHTAG,
  ZALTTEXT: text,
  ...extra,
});

const ROWS: Row[] = [
  account(1, "iCloud"),
  account(2, "Work Mail"),
  account(3, "Old", { ZMARKEDFORDELETION: 1 }),
  folder(10, "Notes", 1),
  folder(11, "Projects", 1),
  folder(12, "A/B", 1, { ZPARENT: 11 }),
  folder(13, "Recently Deleted", 1, { ZFOLDERTYPE: 1, ZIDENTIFIER: "TrashFolder-ACC1" }),
  folder(14, "Gone", 1, { ZMARKEDFORDELETION: 1 }),
  folder(20, "Inbox", 2),
  folder(21, "Recently Deleted", 2, { ZFOLDERTYPE: 1, ZIDENTIFIER: "TrashFolder-ACC2" }),
  note(100, 10, { ZISPINNED: 1, ZMODIFICATIONDATE1: 300 }),
  note(101, 12, { ZISPINNED: 1, ZMODIFICATIONDATE1: 400 }),
  note(102, 13, { ZISPINNED: 1, ZMODIFICATIONDATE1: 500 }),
  note(103, 10, { ZISSYSTEMPAPER: 1, ZMODIFICATIONDATE1: 200 }),
  note(104, null, { ZISSYSTEMPAPER: 1, ZTITLE1: null }),
  note(105, 13, { ZMARKEDFORDELETION: 1, ZMODIFICATIONDATE1: 600 }),
  note(106, 21, { ZMODIFICATIONDATE1: 250 }),
  note(107, 20, {
    ZISPASSWORDPROTECTED: 1,
    ZPASSWORDHINT: "synthetic hint",
    ZMODIFICATIONDATE1: 150,
  }),
  note(108, null, { ZISPASSWORDPROTECTED: 1, ZACCOUNT7: 1 }),
  note(109, 14, { ZISPINNED: 1, ZMODIFICATIONDATE1: 700 }),
  note(110, 20, { ZISPINNED: 1, ZMODIFICATIONDATE1: 100 }),
  note(111, 13, { ZISPASSWORDPROTECTED: 1, ZMODIFICATIONDATE1: 50 }),
  note(113, 10, { ZMODIFICATIONDATE1: 20 }),
  { Z_PK: 200, Z_ENT: ENT.hashtag, ZDISPLAYTEXT: "Work", ZACCOUNT4: 1 },
  { Z_PK: 201, Z_ENT: ENT.hashtag, ZDISPLAYTEXT: "Unused", ZACCOUNT4: 1 },
  { Z_PK: 202, Z_ENT: ENT.hashtag, ZDISPLAYTEXT: "Old", ZACCOUNT4: 1, ZMARKEDFORDELETION: 1 },
  inline(300, 100, "T1", "#Work"),
  inline(301, 101, "T2", "#work"),
  inline(302, 103, "T3", "#Work"),
  inline(303, 107, "T4", "#Secret"),
  inline(304, 102, "T5", "#Work"),
  inline(305, 100, "T9", "#Gone", { ZMARKEDFORDELETION: 1 }),
  inline(306, 110, "T6", "#Work"),
  inline(307, 113, "T7", "#Garbled"),
];
const BODIES: Row[] = [
  { note: 100, hex: bodyHex("one ", ["T1"]) },
  { note: 101, hex: bodyHex("two ", ["T2"]) },
  { note: 103, hex: bodyHex("three") },
  { note: 110, hex: bodyHex("ten ", ["T6"]) },
  { note: 113, hex: "00ff" },
];

let dir: string;
let full: string;
let reduced: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-listings-"));
  full = buildStore(dir, "full.sqlite", FULL, ROWS, BODIES);
  // An older schema: no Quick Note flag, no folder type, no folder owner.
  const reducedColumns = FULL.filter(
    (c) => !/^(ZISSYSTEMPAPER|ZFOLDERTYPE|ZOWNER|ZDISPLAYTEXT) /.test(c)
  );
  reduced = buildStore(dir, "reduced.sqlite", reducedColumns, ROWS, BODIES);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pks = (ids: string[]) => ids.map((id) => Number(/p(\d+)$/.exec(id)![1]));

// --- listings -----------------------------------------------------------------

describe("listSpecialNotes", () => {
  it("lists active pinned notes newest first with ids, paths and accounts", () => {
    const result = listSpecialNotes({ kind: "pinned", dbPath: full });
    expect(result.supported).toBe(true);
    expect(pks(result.notes.map((n) => n.id))).toEqual([101, 100, 110]);
    expect(result.total).toBe(3);
    expect(result.notes[0]).toMatchObject({
      id: `x-coredata://${UUID}/ICNote/p101`,
      identifier: "NOTE-101",
      folder: "Projects/A\\/B",
      account: "iCloud",
      pinned: true,
      locked: false,
      quickNote: false,
      inRecentlyDeleted: false,
      markedForDeletion: false,
      snippet: "snippet 101",
      created: "2001-01-01T00:16:40.000Z",
      modified: "2001-01-01T00:06:40.000Z",
    });
    expect(result.notes[2].account).toBe("Work Mail");
  });

  it("applies limit after counting the total", () => {
    const result = listSpecialNotes({ kind: "pinned", limit: 1, dbPath: full });
    expect(result.count).toBe(1);
    expect(result.total).toBe(3);
    expect(result.limit).toBe(1);
  });

  it("scopes to one account by exact name or unique prefix", () => {
    const icloud = listSpecialNotes({ kind: "pinned", account: "icloud", dbPath: full });
    expect(pks(icloud.notes.map((n) => n.id))).toEqual([101, 100]);
    expect(icloud.account).toBe("iCloud");
    const work = listSpecialNotes({ kind: "pinned", account: "work", dbPath: full });
    expect(pks(work.notes.map((n) => n.id))).toEqual([110]);
    expect(work.account).toBe("Work Mail");
  });

  it("rejects an unknown account", () => {
    expect(() => listSpecialNotes({ kind: "pinned", account: "Nope", dbPath: full })).toThrow(
      /No account named "Nope"/
    );
  });

  it("lists Quick Notes in folders only", () => {
    const result = listSpecialNotes({ kind: "quick-notes", dbPath: full });
    expect(pks(result.notes.map((n) => n.id))).toEqual([103]);
    expect(result.notes[0].quickNote).toBe(true);
  });

  it("lists Recently Deleted without tombstones", () => {
    const result = listSpecialNotes({ kind: "recently-deleted", dbPath: full });
    expect(pks(result.notes.map((n) => n.id))).toEqual([102, 106, 111]);
    expect(result.notes.every((n) => n.inRecentlyDeleted)).toBe(true);
    expect(result.notes[0].folder).toBe("Recently Deleted");
  });

  it("lists every locked note, metadata only, with hints", () => {
    const result = listSpecialNotes({ kind: "locked", dbPath: full });
    expect(pks(result.notes.map((n) => n.id))).toEqual([107, 111, 108]);
    for (const row of result.notes) {
      expect(row.locked).toBe(true);
      expect(row).not.toHaveProperty("snippet");
    }
    expect(result.notes[0].passwordHint).toBe("synthetic hint");
    expect(result.notes[1]).not.toHaveProperty("passwordHint");
    expect(result.notes[1].inRecentlyDeleted).toBe(true);
    expect(result.notes[2]).toMatchObject({ folder: null, account: "iCloud", modified: null });
  });

  it("clamps the limit and defaults it", () => {
    expect(listSpecialNotes({ kind: "pinned", limit: 0, dbPath: full }).limit).toBe(1);
    expect(listSpecialNotes({ kind: "pinned", limit: 99999, dbPath: full }).limit).toBe(1000);
    expect(listSpecialNotes({ kind: "pinned", dbPath: full }).limit).toBe(100);
  });

  describe("older schema", () => {
    it("reports Quick Notes unsupported without querying", () => {
      const result = listSpecialNotes({ kind: "quick-notes", dbPath: reduced });
      expect(result).toMatchObject({ supported: false, notes: [], count: 0, total: 0 });
    });

    it("finds Recently Deleted by folder identifier and accounts by note reference", () => {
      const result = listSpecialNotes({ kind: "recently-deleted", dbPath: reduced });
      expect(pks(result.notes.map((n) => n.id))).toEqual([102, 106, 111]);
      const locked = listSpecialNotes({ kind: "locked", dbPath: reduced });
      expect(locked.notes.find((n) => n.id.endsWith("p108"))?.account).toBe("iCloud");
    });
  });

  it("reports a missing required column as a schema error", () => {
    expect(() => buildSpecialNotesSql(new Set(["Z_PK", "Z_ENT"]), "pinned", false)).toThrow(
      NoteStoreError
    );
  });

  it("kindSupported follows the defining columns", () => {
    expect(kindSupported(new Set(["ZIDENTIFIER"]), "recently-deleted")).toBe(true);
    expect(kindSupported(new Set(), "locked")).toBe(false);
  });

  it("generates SQL that falls back when optional columns are absent", () => {
    const sql = buildSpecialNotesSql(
      new Set(["Z_PK", "Z_ENT", "ZFOLDER", "ZTITLE1"]),
      "locked",
      true
    );
    expect(sql).toContain("a.Z_PK = @account");
    expect(sql).toContain("'created', NULL");
    expect(sql).not.toContain("ZISPINNED");
  });
});

// --- tag inventory ------------------------------------------------------------

describe("nativeTagInventory", () => {
  it("counts notes per tag across accounts, confirming against bodies", () => {
    const result = nativeTagInventory({ dbPath: full });
    expect(result.inventory).toEqual([
      {
        tag: "Work",
        noteCount: 3,
        accounts: { iCloud: 2, "Work Mail": 1 },
        spellings: ["work"],
      },
      { tag: "Garbled", noteCount: 1, accounts: { iCloud: 1 } },
      { tag: "Secret", noteCount: 1, accounts: { "Work Mail": 1 } },
      { tag: "Unused", noteCount: 0, accounts: {} },
    ]);
    expect(result.tagCount).toBe(4);
    expect(result.complete).toBe(false);
    expect(result.unverifiedNotes).toBe(2);
  });

  it("scopes to one account", () => {
    const result = nativeTagInventory({ account: "Work Mail", dbPath: full });
    expect(result.account).toBe("Work Mail");
    expect(result.inventory.map((t) => [t.tag, t.noteCount])).toEqual([
      ["Secret", 1],
      ["Work", 1],
    ]);
  });

  it("works without a hashtag entity or display column", () => {
    const result = nativeTagInventory({ dbPath: reduced });
    expect(result.inventory.map((t) => t.tag)).toEqual(["Work", "Garbled", "Secret"]);
  });

  it("requires the inline attachment columns", () => {
    expect(() => buildTagInventorySql(new Set(["Z_PK"]), false)).toThrow(/list-native-tags/);
  });

  it("assembles an inventory from rows and labels unknown accounts", () => {
    const result = assembleInventory(
      [
        { k: "use", note: 1, object: "x", text: "#Tag", account: null, locked: 0 },
        { k: "use", note: 2, object: null, text: "#", account: 9, locked: 0 },
        { k: "tag", text: null, account: null },
      ],
      []
    );
    expect(result.inventory).toEqual([{ tag: "Tag", noteCount: 1, accounts: { unknown: 1 } }]);
    expect(result.unverifiedNotes).toBe(1);
  });

  it("drops a tag object its note no longer references", () => {
    const result = assembleInventory(
      [
        { k: "body", note: 1, data: bodyHex("x", ["kept"]) },
        { k: "use", note: 1, object: "gone", text: "#Stale", account: null, locked: 0 },
        { k: "use", note: 1, object: null, text: "#NoId", account: null, locked: 0 },
      ],
      []
    );
    expect(result.inventory).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

describe("referencedObjects", () => {
  it("returns inline object ids, or null for unreadable bodies", () => {
    expect(referencedObjects(bodyHex("a", ["one", "two"]))).toEqual(new Set(["one", "two"]));
    expect(referencedObjects(null)).toBeNull();
    expect(referencedObjects("zz")).toBeNull();
    expect(referencedObjects(gzipSync(Buffer.from([0x08, 0x01])).toString("hex"))).toBeNull();
    expect(referencedObjects("1f8b")).toBeNull();
  });
});
