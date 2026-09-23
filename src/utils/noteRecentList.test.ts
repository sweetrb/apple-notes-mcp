/**
 * Tests for list-recent-notes and list-folder-tree.
 *
 * Execution is not mocked: each run builds a NoteStore-shaped fixture database
 * in a temp directory and sends the generated SQL through the real sqlite3
 * CLI, including its ieee754 functions. Two notes are modified one unit in the
 * last place apart, so the checkpoint tests prove the stored double
 * round-trips exactly. All data is synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  assembleFolderTree,
  buildFolderCountsSql,
  buildRecentNotesSql,
  CHECKPOINT_PREFIX,
  checkpointFromBits,
  folderTree,
  listRecentNotes,
  parseSince,
  previewText,
  resolveFolderPath,
  textStats,
} from "./noteRecentList.js";
import { doubleToHex, folderPaths, NoteStoreError, type StoreFolder } from "./noteStoreSql.js";

const OBJ = String.fromCharCode(0xfffc);

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
/** Gzipped note body holding `text` in one attribute run. */
const bodyHex = (text: string) => {
  const runs = text.length ? lField(5, vField(1, text.length)) : [];
  return gzipSync(Buffer.from(lField(2, lField(3, [...lField(2, text), ...runs])))).toString("hex");
};

// --- fixture store ------------------------------------------------------------

const UUID = "11111111-2222-3333-4444-555555555555";
const ENT = { note: 51, folder: 52, account: 53 };
const COLUMNS = [
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
  "ZISPASSWORDPROTECTED INTEGER",
  "ZNEEDSTOBEFETCHEDFROMCLOUD INTEGER",
  "ZSNIPPET TEXT",
  "ZCREATIONDATE3 REAL",
  "ZMODIFICATIONDATE1 REAL",
  "ZACCOUNT7 INTEGER",
];

/** Two stored timestamps one ulp apart; decimal rendering cannot tell them apart. */
const T = 801234567.1234567;
const T_NEXT = (() => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(T);
  b.writeBigUInt64BE(b.readBigUInt64BE() + 1n);
  return b.readDoubleBE();
})();

type Row = Record<string, string | number | null>;
const sqlValue = (v: string | number | null) =>
  v === null
    ? "NULL"
    : typeof v === "number"
      ? `ieee754_from_blob(x'${doubleToHex(v)}')`
      : `'${v.replace(/'/g, "''")}'`;

const account = (pk: number, name: string, extra: Row = {}): Row => ({
  Z_PK: pk,
  Z_ENT: ENT.account,
  ZNAME: name,
  ZIDENTIFIER: `ACC${pk}`,
  ...extra,
});
const folder = (pk: number, name: string, owner: number | null, extra: Row = {}): Row => ({
  Z_PK: pk,
  Z_ENT: ENT.folder,
  ZTITLE2: name,
  ZOWNER: owner,
  ZIDENTIFIER: `F${pk}`,
  ...extra,
});
const note = (pk: number, folderPk: number | null, modified: number | null, extra: Row = {}) => ({
  Z_PK: pk,
  Z_ENT: ENT.note,
  ZTITLE1: `Synthetic ${pk}`,
  ZIDENTIFIER: `N${pk}`,
  ZFOLDER: folderPk,
  ZMODIFICATIONDATE1: modified,
  ZCREATIONDATE3: 0,
  ZSNIPPET: `stored snippet ${pk}`,
  ...extra,
});

const ROWS: Row[] = [
  account(1, "iCloud"),
  account(2, "On My Mac"),
  folder(10, "Notes", 1),
  folder(11, "Work", 1),
  folder(12, "Clients/Europe", 1, { ZPARENT: 11 }),
  folder(13, "Recently Deleted", 1, { ZFOLDERTYPE: 1, ZIDENTIFIER: "TrashFolder-1" }),
  folder(14, "Smart", 1, { ZFOLDERTYPE: 2 }),
  folder(15, "Gone", 1, { ZMARKEDFORDELETION: 1 }),
  folder(16, "Loop A", 1, { ZPARENT: 17 }),
  folder(17, "Loop B", 1, { ZPARENT: 16 }),
  folder(18, "Orphan", 99),
  folder(20, "Notes", 2),
  note(100, 10, 100, { ZISPINNED: 1 }),
  note(101, 12, T),
  note(102, 12, T_NEXT),
  note(103, 11, 50, { ZISPASSWORDPROTECTED: 1, ZSNIPPET: "hidden" }),
  note(104, 10, 40, { ZNEEDSTOBEFETCHEDFROMCLOUD: 1 }),
  note(105, 10, 30),
  note(106, 20, 20),
  note(107, 13, 900),
  note(108, 10, 800, { ZMARKEDFORDELETION: 1 }),
  note(109, null, 700),
  note(110, 15, 600),
  note(111, 10, 10, { ZSNIPPET: null }),
  note(112, 10, 100),
];
const BODIES: Row[] = [
  { note: 100, hex: bodyHex(`Hello  world ${OBJ} — 42\nsecond line`) },
  { note: 101, hex: bodyHex("one") },
  { note: 102, hex: bodyHex("two words") },
  { note: 104, hex: bodyHex("not downloaded") },
  { note: 105, hex: bodyHex("") },
  { note: 106, hex: "00ff" },
];

let dir: string;
let db: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-recent-"));
  db = join(dir, "store.sqlite");
  const statements = [
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT);",
    `INSERT INTO Z_PRIMARYKEY VALUES (${ENT.note},'ICNote'),(${ENT.folder},'ICFolder'),(${ENT.account},'ICAccount');`,
    "CREATE TABLE Z_METADATA (Z_UUID TEXT);",
    `INSERT INTO Z_METADATA VALUES ('${UUID}');`,
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ${COLUMNS.join(", ")});`,
    "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);",
    ...ROWS.map((row) => {
      const keys = Object.keys(row);
      return `INSERT INTO ZICCLOUDSYNCINGOBJECT (${keys.join(", ")}) VALUES (${keys
        .map((k) => sqlValue(row[k]))
        .join(", ")});`;
    }),
    ...BODIES.map((b) => `INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (${b.note}, X'${b.hex}');`),
  ];
  execFileSync("sqlite3", [db], { input: statements.join("\n") });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pks = (rows: Array<{ id: string }>) => rows.map((r) => Number(/p(\d+)$/.exec(r.id)![1]));

// --- list-recent-notes ----------------------------------------------------------

describe("listRecentNotes", () => {
  it("lists active notes newest first, ties broken by key", () => {
    const result = listRecentNotes({ dbPath: db });
    expect(pks(result.notes)).toEqual([102, 101, 112, 100, 103, 104, 105, 106, 111]);
    expect(result).toMatchObject({ count: 9, limit: 50, saturated: false });
    expect(result.nextSince).toBe(result.notes[0].modifiedCheckpoint);
    expect(result.notes[0]).toMatchObject({
      id: `x-coredata://${UUID}/ICNote/p102`,
      identifier: "N102",
      folder: "Work/Clients\\/Europe",
      account: "iCloud",
      created: "2001-01-01T00:00:00.000Z",
      pinned: false,
      locked: false,
      inRecentlyDeleted: false,
      markedForDeletion: false,
    });
    expect(result.notes[0]).not.toHaveProperty("wordCount");
    expect(result.notes[0]).not.toHaveProperty("bodyPreview");
  });

  it("round-trips the exact stored double through modifiedCheckpoint", () => {
    const all = listRecentNotes({ dbPath: db }).notes;
    const older = all.find((n) => n.id.endsWith("p101"))!;
    const newer = all.find((n) => n.id.endsWith("p102"))!;
    expect(older.modifiedCheckpoint).toBe(CHECKPOINT_PREFIX + doubleToHex(T));
    expect(newer.modifiedCheckpoint).toBe(CHECKPOINT_PREFIX + doubleToHex(T_NEXT));
    // The ISO strings are identical; only the checkpoint separates the two.
    expect(older.modified).toBe(newer.modified);

    const after = listRecentNotes({ since: older.modifiedCheckpoint!, dbPath: db });
    expect(pks(after.notes)).toEqual([102]);
    const none = listRecentNotes({ since: newer.modifiedCheckpoint!, dbPath: db });
    expect(none.notes).toEqual([]);
    expect(none.nextSince).toBe(newer.modifiedCheckpoint);
  });

  it("follows the saturated-limit rule", () => {
    const first = listRecentNotes({ since: "cdts1:" + doubleToHex(25), limit: 3, dbPath: db });
    expect(first.count).toBe(3);
    expect(first.saturated).toBe(true);
    expect(first.nextSince).toBeNull();
    const retry = listRecentNotes({ since: "cdts1:" + doubleToHex(25), limit: 10, dbPath: db });
    expect(retry.saturated).toBe(false);
    expect(pks(retry.notes)).toEqual([102, 101, 112, 100, 103, 104, 105]);
    expect(retry.nextSince).toBe(retry.notes[0].modifiedCheckpoint);
  });

  it("treats an ISO since as strictly after and hands back a checkpoint", () => {
    const iso = new Date(Date.UTC(2001, 0, 1) + 100_000).toISOString();
    expect(pks(listRecentNotes({ since: iso, dbPath: db }).notes)).toEqual([102, 101]);
    const empty = listRecentNotes({ since: "2100-01-01T00:00:00Z", dbPath: db });
    expect(empty.nextSince).toMatch(/^cdts1:[0-9a-f]{16}$/);
  });

  it("includes Recently Deleted, tombstoned and folderless notes on request", () => {
    const result = listRecentNotes({ includeDeleted: true, limit: 6, dbPath: db });
    expect(pks(result.notes)).toEqual([102, 101, 107, 108, 109, 110]);
    expect(result.notes[2]).toMatchObject({ inRecentlyDeleted: true, folder: "Recently Deleted" });
    expect(result.notes[3].markedForDeletion).toBe(true);
    expect(result.notes[4]).toMatchObject({ folder: null, account: null });
    expect(result.notes[5].folder).toBe("Gone");
  });

  it("computes word and character counts with explicit nulls", () => {
    const rows = listRecentNotes({ wordCounts: true, dbPath: db }).notes;
    const by = (pk: number) => rows.find((r) => r.id.endsWith(`p${pk}`))!;
    // "Hello  world <obj> — 42\nsecond line": 5 words (the dash is not one) and
    // 30 code points once the attachment marker is dropped.
    expect(by(100)).toMatchObject({ wordCount: 5, charCount: 30 });
    expect(by(102)).toMatchObject({ wordCount: 2, charCount: 9 });
    expect(by(105)).toMatchObject({ wordCount: 0, charCount: 0 }); // known empty
    expect(by(103)).toMatchObject({ wordCount: null, charCount: null }); // locked
    expect(by(104)).toMatchObject({ wordCount: null, charCount: null }); // not downloaded
    expect(by(106)).toMatchObject({ wordCount: null, charCount: null }); // undecodable
    expect(by(111)).toMatchObject({ wordCount: null, charCount: null }); // no body row
  });

  it("previews the decoded body, else the stored snippet", () => {
    const decoded = listRecentNotes({ wordCounts: true, bodyPreview: true, dbPath: db }).notes;
    const by = (rows: typeof decoded, pk: number) => rows.find((r) => r.id.endsWith(`p${pk}`))!;
    expect(by(decoded, 100)).toMatchObject({
      textDecoded: true,
      bodyPreview: "Hello world — 42 second line",
    });
    expect(by(decoded, 103)).toMatchObject({ textDecoded: false, bodyPreview: null });
    const snippets = listRecentNotes({ bodyPreview: true, dbPath: db }).notes;
    expect(by(snippets, 100)).toMatchObject({
      textDecoded: false,
      bodyPreview: "stored snippet 100",
    });
    expect(by(snippets, 111).bodyPreview).toBeNull();
    expect(by(snippets, 100)).not.toHaveProperty("wordCount");
  });

  it("scopes by account and by folder path or unique name", () => {
    const mac = listRecentNotes({ account: "on my", dbPath: db });
    expect(pks(mac.notes)).toEqual([106]);
    expect(mac.account).toBe("On My Mac");
    const europe = listRecentNotes({ folder: "Work/Clients\\/Europe", dbPath: db });
    expect(pks(europe.notes)).toEqual([102, 101]);
    expect(europe.folder).toBe("Work/Clients\\/Europe");
    expect(pks(listRecentNotes({ folder: "clients/europe", dbPath: db }).notes)).toEqual([
      102, 101,
    ]);
    expect(pks(listRecentNotes({ folder: "Notes", account: "iCloud", dbPath: db }).notes)).toEqual([
      112, 100, 104, 105, 111,
    ]);
    expect(() => listRecentNotes({ folder: "Notes", dbPath: db })).toThrow(/ambiguous/);
    expect(() => listRecentNotes({ folder: "Nope", dbPath: db })).toThrow(/No folder "Nope"/);
  });

  it("clamps the limit and rejects bad since values", () => {
    expect(listRecentNotes({ limit: 0, dbPath: db }).limit).toBe(1);
    expect(listRecentNotes({ limit: 5000, dbPath: db }).limit).toBe(1000);
    expect(() => listRecentNotes({ since: "yesterday", dbPath: db })).toThrow(NoteStoreError);
  });

  it("builds SQL that tolerates missing optional columns", () => {
    const sql = buildRecentNotesSql(
      new Set(["Z_PK", "Z_ENT", "ZFOLDER", "ZTITLE1", "ZMODIFICATIONDATE1"]),
      {
        includeDeleted: true,
        scoped: false,
        inFolder: false,
        since: false,
        withBodies: true,
      }
    );
    expect(sql).toContain("'cloud', 0");
    expect(sql).toContain("'created', NULL");
    expect(() =>
      buildRecentNotesSql(new Set(["Z_PK"]), {
        includeDeleted: false,
        scoped: false,
        inFolder: false,
        since: false,
        withBodies: false,
      })
    ).toThrow(/list-recent-notes needs/);
  });
});

// --- helpers --------------------------------------------------------------------

describe("parseSince", () => {
  it("reads checkpoint tokens exactly", () => {
    expect(parseSince(CHECKPOINT_PREFIX + doubleToHex(T_NEXT))).toBe(T_NEXT);
    expect(() => parseSince("cdts1:xyz")).toThrow(/Invalid checkpoint/);
  });
  it("treats a bare date as local midnight and a naive date-time as local", () => {
    const local = (new Date(2026, 7, 1).getTime() - Date.UTC(2001, 0, 1)) / 1000;
    expect(parseSince("2026-08-01")).toBe(local);
    expect(parseSince("2026-08-01T00:00")).toBe(local);
  });
  it("honors offsets and truncates sub-millisecond digits", () => {
    const utc = (Date.UTC(2026, 7, 1, 7, 30) - Date.UTC(2001, 0, 1)) / 1000;
    expect(parseSince("2026-08-01T09:30:00+02:00")).toBe(utc);
    expect(parseSince("2026-08-01T07:30:00.0009999Z")).toBe(utc);
  });
  it("rejects impossible dates and other formats", () => {
    expect(() => parseSince("2026-02-30")).toThrow(/Invalid since/);
    expect(() => parseSince("08/01/2026")).toThrow(/Invalid since/);
  });
});

describe("text helpers", () => {
  it("counts words and code points without attachment markers", () => {
    expect(textStats(`a ${OBJ} b 😀`)).toEqual({ wordCount: 2, charCount: 6 });
    expect(textStats("   ")).toEqual({ wordCount: 0, charCount: 3 });
  });
  it("builds a flat 180-character preview", () => {
    expect(previewText(`x${OBJ}\n\ny`)).toBe("x y");
    expect([...previewText("é".repeat(300))]).toHaveLength(180);
  });
  it("rejects malformed checkpoint bits", () => {
    expect(checkpointFromBits(null)).toBeNull();
    expect(checkpointFromBits("7ff0000000000000")).toBeNull();
    expect(checkpointFromBits("3FF0000000000000")).toBe("cdts1:3ff0000000000000");
  });
  it("resolves folder paths within an account", () => {
    const f = (pk: number, name: string, account: number, tombstoned = 0): StoreFolder => ({
      pk,
      name,
      identifier: null,
      parent: null,
      account,
      folderType: null,
      trash: 0,
      tombstoned,
    });
    const folders = [f(1, "A", 1), f(2, "A", 2), f(3, "B", 1, 1)];
    const paths = folderPaths(folders);
    expect(resolveFolderPath(folders, paths, "/a/", 2).pk).toBe(2);
    expect(() => resolveFolderPath(folders, paths, "B")).toThrow(/No folder/);
  });
});

// --- list-folder-tree -----------------------------------------------------------

describe("folderTree", () => {
  it("nests folders per account with direct and cumulative counts", () => {
    const result = folderTree({ dbPath: db });
    const icloud = result.accounts[0];
    expect(icloud.account).toBe("iCloud");
    expect(icloud.folders.map((n) => [n.name, n.kind, n.noteCount, n.totalNoteCount])).toEqual([
      ["Loop A", "folder", 0, 0],
      ["Loop B", "folder", 0, 0],
      ["Notes", "folder", 5, 5],
      ["Work", "folder", 1, 3],
      ["Smart", "smart", 0, 0],
      ["Recently Deleted", "trash", 1, 1],
    ]);
    const work = icloud.folders[3];
    expect(work.children[0]).toMatchObject({
      id: `x-coredata://${UUID}/ICFolder/p12`,
      identifier: "F12",
      path: "Work/Clients\\/Europe",
      noteCount: 2,
    });
    expect(work).not.toHaveProperty("markedForDeletion");
    expect(icloud.noteCount).toBe(8);
    expect(result.accounts[1]).toMatchObject({ account: "On My Mac", noteCount: 1 });
    expect(result.folderCount).toBe(8); // the orphan folder is hidden
  });

  it("adds deleted folders and orphans on request, and scopes to one account", () => {
    const all = folderTree({ includeDeleted: true, dbPath: db });
    const gone = all.accounts[0].folders.find((n) => n.name === "Gone")!;
    expect(gone).toMatchObject({ markedForDeletion: true, noteCount: 1 });
    expect(all.accounts.at(-1)).toMatchObject({ account: "unknown", identifier: null });
    const mac = folderTree({ account: "On My Mac", dbPath: db });
    expect(mac.accounts.map((a) => a.account)).toEqual(["On My Mac"]);
    expect(mac.folderCount).toBe(1);
  });

  it("assembles an empty store and requires the folder column", () => {
    expect(assembleFolderTree({ uuid: "U", accounts: [], folders: [] }, new Map(), false)).toEqual({
      accounts: [],
      folderCount: 0,
    });
    expect(() => buildFolderCountsSql(new Set(["Z_PK"]))).toThrow(/list-folder-tree/);
  });
});
