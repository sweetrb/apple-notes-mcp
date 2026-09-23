/**
 * Tests for list-recent-notes and list-folder-tree.
 *
 * Execution is not mocked: each run builds a NoteStore-shaped fixture database
 * in a temp directory and sends the generated SQL through the real sqlite3
 * CLI, including its ieee754 functions. Two notes are modified one unit in the
 * last place apart, so the cursor tests prove the stored double round-trips
 * exactly; two others share one timestamp, so paging must split them by key.
 * A second fixture holds more notes than the maximum limit for a full sync.
 * All data is synthetic.
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
  formatCursor,
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

/** Many active notes in one folder, with heavily shared timestamps out of key order. */
const BIG = { count: 2345, distinctTimes: 300 };

const baseStatements = () => [
  "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT);",
  `INSERT INTO Z_PRIMARYKEY VALUES (${ENT.note},'ICNote'),(${ENT.folder},'ICFolder'),(${ENT.account},'ICAccount');`,
  "CREATE TABLE Z_METADATA (Z_UUID TEXT);",
  `INSERT INTO Z_METADATA VALUES ('${UUID}');`,
  `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ${COLUMNS.join(", ")});`,
  "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);",
];

let dir: string;
let db: string;
let bigDb: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-recent-"));
  db = join(dir, "store.sqlite");
  bigDb = join(dir, "big.sqlite");
  execFileSync("sqlite3", [bigDb], {
    input: [
      ...baseStatements(),
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZNAME) VALUES (1, ${ENT.account}, 'iCloud');`,
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZOWNER) VALUES (10, ${ENT.folder}, 'Notes', 1);`,
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE2, ZOWNER, ZFOLDERTYPE) VALUES (11, ${ENT.folder}, 'Recently Deleted', 1, 1);`,
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${BIG.count}) ` +
        `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE1, ZFOLDER, ZMODIFICATIONDATE1) ` +
        `SELECT 1000 + i, ${ENT.note}, 'Synthetic', 10, ((i * 37) % ${BIG.distinctTimes}) + 0.5 FROM s;`,
      // A trashed note inside the range must stay out of an active sync.
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZTITLE1, ZFOLDER, ZMODIFICATIONDATE1) VALUES (999, ${ENT.note}, 'Synthetic', 11, 5.5);`,
    ].join("\n"),
  });
  const statements = [
    ...baseStatements(),
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

/** Pages a since query until a call is not saturated; returns every call's result. */
const syncAll = (since: string, limit: number, dbPath: string) => {
  const calls: ReturnType<typeof listRecentNotes>[] = [];
  let cursor = since;
  for (let guard = 0; guard < 100; guard++) {
    const page = listRecentNotes({ since: cursor, limit, dbPath });
    calls.push(page);
    expect(page.nextSince).not.toBeNull();
    cursor = page.nextSince!;
    if (!page.saturated) return calls;
  }
  throw new Error("sync did not finish");
};

// --- list-recent-notes ----------------------------------------------------------

describe("listRecentNotes", () => {
  it("lists active notes newest first, ties broken by key", () => {
    const result = listRecentNotes({ dbPath: db });
    expect(pks(result.notes)).toEqual([102, 101, 112, 100, 103, 104, 105, 106, 111]);
    expect(result).toMatchObject({
      count: 9,
      limit: 50,
      order: "newest-first",
      saturated: false,
    });
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
    expect(older.modifiedCheckpoint).toBe(`${CHECKPOINT_PREFIX}${doubleToHex(T)}:101`);
    expect(newer.modifiedCheckpoint).toBe(`${CHECKPOINT_PREFIX}${doubleToHex(T_NEXT)}:102`);
    // The ISO strings are identical; only the cursor separates the two.
    expect(older.modified).toBe(newer.modified);

    const after = listRecentNotes({ since: older.modifiedCheckpoint!, dbPath: db });
    expect(pks(after.notes)).toEqual([102]);
    expect(after.order).toBe("oldest-first");
    // Without the key, a cursor is a strict timestamp boundary.
    const timeOnly = listRecentNotes({ since: CHECKPOINT_PREFIX + doubleToHex(T), dbPath: db });
    expect(pks(timeOnly.notes)).toEqual([102]);
    const none = listRecentNotes({ since: newer.modifiedCheckpoint!, dbPath: db });
    expect(none.notes).toEqual([]);
    expect(none).toMatchObject({ saturated: false, nextSince: newer.modifiedCheckpoint });
  });

  it("returns since queries oldest first and advances even when saturated", () => {
    const since = CHECKPOINT_PREFIX + doubleToHex(25);
    const first = listRecentNotes({ since, limit: 3, dbPath: db });
    expect(pks(first.notes)).toEqual([105, 104, 103]);
    expect(first).toMatchObject({ count: 3, saturated: true, order: "oldest-first" });
    expect(first.nextSince).toBe(first.notes[2].modifiedCheckpoint);
    const second = listRecentNotes({ since: first.nextSince!, limit: 3, dbPath: db });
    expect(pks(second.notes)).toEqual([100, 112, 101]);
  });

  it("reaches more changes than the limit exactly once by repeated calls", () => {
    const since = CHECKPOINT_PREFIX + doubleToHex(25);
    const calls = syncAll(since, 2, db);
    expect(calls.map((c) => pks(c.notes))).toEqual([[105, 104], [103, 100], [112, 101], [102]]);
    expect(calls.map((c) => c.saturated)).toEqual([true, true, true, false]);
    // A limit that divides the change count ends with an empty, caught-up
    // call that keeps the cursor in place.
    const even = syncAll(since, 7, db);
    expect(even.map((c) => c.count)).toEqual([7, 0]);
    expect(even[1].nextSince).toBe(even[0].nextSince);
  });

  it("splits notes sharing one timestamp across a page boundary without skips or repeats", () => {
    // Notes 100 and 112 are both stored at 100; the page ends between them.
    const first = listRecentNotes({
      since: CHECKPOINT_PREFIX + doubleToHex(40),
      limit: 2,
      dbPath: db,
    });
    expect(pks(first.notes)).toEqual([103, 100]);
    expect(first.nextSince).toBe(`${CHECKPOINT_PREFIX}${doubleToHex(100)}:100`);
    const rest = listRecentNotes({ since: first.nextSince!, dbPath: db });
    expect(pks(rest.notes)).toEqual([112, 101, 102]);
    expect(rest.notes[0].modified).toBe(first.notes[1].modified);
  });

  it("pages a first full sync of a library larger than the maximum limit", () => {
    const calls = syncAll("1970-01-01", 1000, bigDb);
    expect(calls.map((c) => c.count)).toEqual([1000, 1000, 345]);
    const seen = calls.flatMap((c) => pks(c.notes));
    expect(seen).toHaveLength(BIG.count);
    expect(new Set(seen).size).toBe(BIG.count);
    expect(seen).not.toContain(999);
    // Rows arrive in strictly increasing (modified, key) order across pages.
    const keys = calls.flatMap((c) => c.notes.map((n) => parseSince(n.modifiedCheckpoint!)));
    for (let i = 1; i < keys.length; i++) {
      const [a, b] = [keys[i - 1], keys[i]];
      expect(b.modified > a.modified || (b.modified === a.modified && b.pk! > a.pk!)).toBe(true);
    }
  });

  it("treats an ISO since as strictly after and hands back a cursor", () => {
    const iso = new Date(Date.UTC(2001, 0, 1) + 100_000).toISOString();
    expect(pks(listRecentNotes({ since: iso, dbPath: db }).notes)).toEqual([101, 102]);
    const empty = listRecentNotes({ since: "2100-01-01T00:00:00Z", dbPath: db });
    expect(empty.nextSince).toMatch(/^cdts1:[0-9a-f]{16}$/);
  });

  it("gives no cursor when a newest-first listing was cut off", () => {
    const browse = listRecentNotes({ limit: 3, dbPath: db });
    expect(browse).toMatchObject({ order: "newest-first", saturated: true, nextSince: null });
    const empty = listRecentNotes({ account: "On My Mac", folder: "Notes", limit: 5, dbPath: db });
    expect(empty).toMatchObject({ saturated: false, nextSince: empty.notes[0].modifiedCheckpoint });
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
    expect(sql).toContain("ORDER BY n.ZMODIFICATIONDATE1 DESC, n.Z_PK DESC");
    const sync = buildRecentNotesSql(
      new Set(["Z_PK", "Z_ENT", "ZFOLDER", "ZTITLE1", "ZMODIFICATIONDATE1"]),
      {
        includeDeleted: false,
        scoped: false,
        inFolder: false,
        since: true,
        sinceKey: true,
        withBodies: false,
      }
    );
    expect(sync).toContain("n.Z_PK > @sincePk");
    expect(sync).toContain("ORDER BY n.ZMODIFICATIONDATE1 ASC, n.Z_PK ASC");
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
  it("reads cursor tokens exactly, with or without a key", () => {
    const bits = doubleToHex(T_NEXT);
    expect(parseSince(CHECKPOINT_PREFIX + bits)).toEqual({ modified: T_NEXT });
    expect(parseSince(`${CHECKPOINT_PREFIX}${bits}:42`)).toEqual({ modified: T_NEXT, pk: 42 });
    expect(formatCursor({ modified: T_NEXT, pk: 42 })).toBe(`${CHECKPOINT_PREFIX}${bits}:42`);
    expect(formatCursor({ modified: T_NEXT })).toBe(CHECKPOINT_PREFIX + bits);
    for (const bad of ["xyz", `${bits}:`, `${bits}:x`, `${bits}:01`, `${bits}:9999999999999999`]) {
      expect(() => parseSince(CHECKPOINT_PREFIX + bad)).toThrow(/Invalid checkpoint/);
    }
  });
  it("treats a bare date as local midnight and a naive date-time as local", () => {
    const local = (new Date(2026, 7, 1).getTime() - Date.UTC(2001, 0, 1)) / 1000;
    expect(parseSince("2026-08-01")).toEqual({ modified: local });
    expect(parseSince("2026-08-01T00:00")).toEqual({ modified: local });
  });
  it("honors offsets and truncates sub-millisecond digits", () => {
    const utc = (Date.UTC(2026, 7, 1, 7, 30) - Date.UTC(2001, 0, 1)) / 1000;
    expect(parseSince("2026-08-01T09:30:00+02:00")).toEqual({ modified: utc });
    expect(parseSince("2026-08-01T07:30:00.0009999Z")).toEqual({ modified: utc });
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
    expect(checkpointFromBits(null, 1)).toBeNull();
    expect(checkpointFromBits("7ff0000000000000", 1)).toBeNull();
    expect(checkpointFromBits("3FF0000000000000", 7)).toBe("cdts1:3ff0000000000000:7");
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
