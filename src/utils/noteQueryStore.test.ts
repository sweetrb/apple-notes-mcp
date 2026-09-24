/**
 * Tests for the query-notes database reader.
 *
 * Unlike most tests here, these do not mock execution: a mocked sqlite3 would
 * hide a SQL compile error until it met a real database. Instead each run
 * builds a throwaway fixture store in a temp directory with the NoteStore
 * tables and columns the reader uses, fills it with gzipped protobuf note
 * bodies built below, and runs the generated SQL through the real sqlite3 CLI
 * (present on every macOS, including the CI runners). The live NoteStore is
 * never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  buildNoteTextsSql,
  buildScanSql,
  countWords,
  decodeBodyHex,
  decodeNoteBody,
  facetsForAttachmentType,
  NOTE_TEXT_BATCH_MAX,
  NoteQueryStoreError,
  queryNotes,
  QUERY_SCAN,
  readNoteTexts,
  resolveFolders,
} from "./noteQueryStore.js";
import { NoteQueryError } from "./noteQuery.js";

// -----------------------------------------------------------------------------
// Protobuf fixture encoding (the inverse of the wire decoder in protobuf.ts)
// -----------------------------------------------------------------------------

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

interface Run {
  /** Length in UTF-16 code units, as Notes stores it. */
  length: number;
  link?: string;
  attachment?: { id: string; type: string };
  checklist?: { id: string; done: boolean };
}

/** Builds a gzipped Notes document: Document.2 → Version.3 → String{2: text, 5: runs}. */
function noteDocument(text: string, runs?: Run[]): Buffer {
  const allRuns = runs ?? [{ length: text.length }];
  const encodedRuns = allRuns.flatMap((run) => {
    const fields = [...vField(1, run.length)];
    if (run.checklist) {
      fields.push(
        ...lField(2, [
          ...vField(1, 103),
          ...lField(5, [
            ...lField(1, [...Buffer.from(run.checklist.id, "hex")]),
            ...vField(2, run.checklist.done ? 1 : 0),
          ]),
        ])
      );
    }
    if (run.link) fields.push(...lField(9, run.link));
    if (run.attachment)
      fields.push(
        ...lField(12, [...lField(1, run.attachment.id), ...lField(2, run.attachment.type)])
      );
    return lField(5, fields);
  });
  const body = [...lField(2, text), ...encodedRuns];
  return gzipSync(Buffer.from(lField(2, lField(3, body))));
}

/** Builds text and runs from segments, so run lengths always add up. */
function segments(parts: Array<string | ({ text: string } & Omit<Run, "length">)>) {
  let text = "";
  const runs: Run[] = [];
  for (const part of parts) {
    const segment = typeof part === "string" ? { text: part } : part;
    text += segment.text;
    const { text: t, ...rest } = segment;
    runs.push({ length: t.length, ...rest });
  }
  return { text, runs };
}

// -----------------------------------------------------------------------------
// Fixture store
// -----------------------------------------------------------------------------

const UUID = "11111111-2222-3333-4444-555555555555";
const OBJ = "\ufffc";
/** Core Data seconds for a local wall-clock time. */
const cd = (y: number, m: number, d: number, h = 12) =>
  (new Date(y, m - 1, d, h).getTime() - Date.UTC(2001, 0, 1)) / 1000;

// Entity numbers deliberately differ from a real store's, so the SQL must look
// them up in Z_PRIMARYKEY rather than hard-code them.
const ENT = { note: 41, folder: 42, account: 43, inline: 44 };

const FULL_COLUMNS = [
  "Z_PK INTEGER PRIMARY KEY",
  "Z_ENT INTEGER",
  "ZTITLE1 TEXT",
  "ZFOLDER INTEGER",
  "ZMODIFICATIONDATE1 REAL",
  "ZCREATIONDATE1 REAL",
  "ZCREATIONDATE3 REAL",
  "ZISPINNED INTEGER",
  "ZISPASSWORDPROTECTED INTEGER",
  "ZMARKEDFORDELETION INTEGER",
  "ZSERVERSHAREDATA BLOB",
  "ZSNIPPET TEXT",
  "ZFOLDERTYPE INTEGER",
  "ZTITLE2 TEXT",
  "ZPARENT INTEGER",
  "ZOWNER INTEGER",
  "ZNAME TEXT",
  "ZIDENTIFIER TEXT",
  "ZTYPEUTI1 TEXT",
  "ZALTTEXT TEXT",
  "ZNOTE1 INTEGER",
];
const MINIMAL_COLUMNS = FULL_COLUMNS.slice(0, 5);

const sqlString = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

function createStore(
  path: string,
  columns: string[],
  objects: Array<Record<string, unknown>>,
  bodies: Array<[number, Buffer]>
) {
  const names = columns.map((c) => c.split(" ")[0]);
  const sql = [
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
    `INSERT INTO Z_PRIMARYKEY VALUES (${ENT.note}, 'ICNote'), (${ENT.folder}, 'ICFolder'), (${ENT.account}, 'ICAccount'), (${ENT.inline}, 'ICInlineAttachment');`,
    "CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID TEXT);",
    `INSERT INTO Z_METADATA VALUES (1, '${UUID}');`,
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (${columns.join(", ")});`,
    "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);",
    ...objects.map((row) => {
      const keys = Object.keys(row).filter((k) => names.includes(k));
      return `INSERT INTO ZICCLOUDSYNCINGOBJECT (${keys.join(", ")}) VALUES (${keys.map((k) => sqlString(row[k])).join(", ")});`;
    }),
    ...bodies.map(
      ([note, data], i) => `INSERT INTO ZICNOTEDATA VALUES (${i + 1}, ${note}, ${sqlString(data)});`
    ),
  ].join("\n");
  execFileSync("sqlite3", [path], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
}

const meeting = segments([
  "Meeting notes\nAgenda: budget review and hiring\n",
  { text: "Open item\n", checklist: { id: "aa01", done: false } },
  { text: "Closed item\n", checklist: { id: "aa02", done: true } },
  { text: "spec", link: "https://example.com/spec" },
]);
const invoice = segments([
  "Invoice 42\nAmount due ",
  { text: OBJ, attachment: { id: "TAG1", type: "com.apple.notes.inlinetextattachment.hashtag" } },
  " ",
  { text: OBJ, attachment: { id: "IMG1", type: "public.jpeg" } },
  { text: OBJ, attachment: { id: "PDF1", type: "com.adobe.pdf" } },
]);
const trip = segments([
  "Trip\n",
  { text: OBJ, attachment: { id: "T1", type: "com.apple.notes.table" } },
  { text: OBJ, attachment: { id: "S1", type: "com.apple.paper.doc.scan" } },
  { text: OBJ, attachment: { id: "A1", type: "com.apple.m4a-audio" } },
  { text: OBJ, attachment: { id: "V1", type: "com.apple.quicktime-movie" } },
  { text: OBJ, attachment: { id: "D1", type: "com.apple.paper" } },
  "\n",
  { text: "Pack\n", checklist: { id: "bb01", done: true } },
]);
const essayWords = Array.from({ length: 300 }, (_, i) => (i === 150 ? "AND" : `word${i}`));
const essay = `Long essay\n${essayWords.join(" ")}`;

const OBJECTS: Array<Record<string, unknown>> = [
  { Z_PK: 1, Z_ENT: ENT.account, ZNAME: "iCloud" },
  { Z_PK: 10, Z_ENT: ENT.folder, ZTITLE2: "Work", ZOWNER: 1, ZFOLDERTYPE: 0 },
  { Z_PK: 11, Z_ENT: ENT.folder, ZTITLE2: "Clients", ZPARENT: 10, ZFOLDERTYPE: 0 },
  { Z_PK: 12, Z_ENT: ENT.folder, ZTITLE2: "Recently Deleted", ZOWNER: 1, ZFOLDERTYPE: 1 },
  {
    Z_PK: 13,
    Z_ENT: ENT.folder,
    ZTITLE2: "Spain/Portugal",
    ZOWNER: 1,
    ZFOLDERTYPE: 0,
    ZSERVERSHAREDATA: Buffer.from([1]),
  },
  { Z_PK: 14, Z_ENT: ENT.folder, ZTITLE2: "Work Projects", ZOWNER: 1, ZFOLDERTYPE: 0 },
  {
    Z_PK: 100,
    Z_ENT: ENT.note,
    ZTITLE1: "Meeting notes",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 9, 10),
    ZCREATIONDATE3: cd(2026, 7, 15),
    ZISPINNED: 1,
    ZSNIPPET: "column snippet",
  },
  {
    Z_PK: 101,
    Z_ENT: ENT.note,
    ZTITLE1: "Invoice 42",
    ZFOLDER: 11,
    ZMODIFICATIONDATE1: cd(2026, 8, 1),
    ZCREATIONDATE3: cd(2026, 7, 30),
  },
  {
    Z_PK: 200,
    Z_ENT: ENT.inline,
    ZNOTE1: 101,
    ZIDENTIFIER: "TAG1",
    ZALTTEXT: "#Finance",
    ZTYPEUTI1: "com.apple.notes.inlinetextattachment.hashtag",
  },
  // A tag row whose inline object is no longer in the body must not count.
  {
    Z_PK: 201,
    Z_ENT: ENT.inline,
    ZNOTE1: 101,
    ZIDENTIFIER: "TAG2",
    ZALTTEXT: "#old",
    ZTYPEUTI1: "com.apple.notes.inlinetextattachment.hashtag",
  },
  {
    Z_PK: 102,
    Z_ENT: ENT.note,
    ZTITLE1: "Trip",
    ZFOLDER: 13,
    ZMODIFICATIONDATE1: cd(2026, 6, 1),
    ZCREATIONDATE1: cd(2019, 5, 5),
  },
  {
    Z_PK: 103,
    Z_ENT: ENT.note,
    ZTITLE1: "Secret budget",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 9, 12),
    ZISPASSWORDPROTECTED: 1,
    ZSNIPPET: "should never be shown",
  },
  {
    Z_PK: 104,
    Z_ENT: ENT.note,
    ZTITLE1: "Old budget",
    ZFOLDER: 12,
    ZMODIFICATIONDATE1: cd(2026, 9, 14),
  },
  { Z_PK: 105, Z_ENT: ENT.note, ZTITLE1: null, ZFOLDER: null, ZMODIFICATIONDATE1: cd(2026, 9, 15) },
  {
    Z_PK: 106,
    Z_ENT: ENT.note,
    ZTITLE1: "Long essay",
    ZFOLDER: 14,
    ZMODIFICATIONDATE1: cd(2026, 9, 1, 9),
  },
  {
    Z_PK: 107,
    Z_ENT: ENT.note,
    ZTITLE1: "Broken",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 1, 1),
  },
  {
    Z_PK: 108,
    Z_ENT: ENT.note,
    ZTITLE1: "Pending purge budget",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 9, 13),
    ZMARKEDFORDELETION: 1,
  },
];

const BODIES: Array<[number, Buffer]> = [
  [100, noteDocument(meeting.text, meeting.runs)],
  [101, noteDocument(invoice.text, invoice.runs)],
  [102, noteDocument(trip.text, trip.runs)],
  [103, Buffer.from("encrypted-bytes-not-gzip")],
  [104, noteDocument("Old budget\nstale budget")],
  [105, noteDocument("\nghost budget")],
  [106, noteDocument(essay)],
  [107, Buffer.from("definitely not gzip")],
  [108, noteDocument("Pending purge budget\nx")],
  // A second document row for one note: the newest wins and the note is not duplicated.
  [106, noteDocument(essay)],
];

let dir: string;
let full: string;
let minimal: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "query-notes-test-"));
  full = join(dir, "full.sqlite");
  minimal = join(dir, "minimal.sqlite");
  createStore(full, FULL_COLUMNS, OBJECTS, BODIES);
  createStore(minimal, MINIMAL_COLUMNS, OBJECTS, BODIES);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pks = (query: string, options: Parameters<typeof queryNotes>[1] = {}) =>
  queryNotes(query, { dbPath: full, ...options }).notes.map((n) => Number(n.id.split("/p")[1]));

// -----------------------------------------------------------------------------
// End-to-end against the fixture store
// -----------------------------------------------------------------------------

describe("queryNotes against a fixture NoteStore", () => {
  it("returns canonical ids, newest first, excluding deleted and folderless notes", () => {
    const result = queryNotes("words:>=0 OR locked", { dbPath: full });
    expect(result.notes.map((n) => n.id)).toEqual(
      [103, 100, 106, 101, 102, 107]
        .filter((pk) => pk !== 107) // unreadable body: words: cannot match
        .map((pk) => `x-coredata://${UUID}/ICNote/p${pk}`)
    );
    expect(result.eligible).toBe(6);
    expect(result.scanned).toBe(6);
    expect(result.scanTruncated).toBe(false);
  });

  it("carries title, folder path, account, dates, and a snippet", () => {
    const [hit] = queryNotes("title:invoice", { dbPath: full }).notes;
    expect(hit).toMatchObject({
      id: `x-coredata://${UUID}/ICNote/p101`,
      title: "Invoice 42",
      folder: "Work/Clients",
      account: "iCloud",
      modified: new Date(2026, 7, 1, 12).toISOString(),
      created: new Date(2026, 6, 30, 12).toISOString(),
    });
    // Metadata-only query: bodies were not fetched, so the column snippet is used.
    expect(queryNotes("pinned", { dbPath: full }).notes[0].snippet).toBe("column snippet");
  });

  it("centres the snippet on the first matched phrase and hides locked snippets", () => {
    const [hit] = queryNotes("hiring", { dbPath: full }).notes;
    expect(hit.snippet).toContain("hiring");
    expect(hit.snippet).not.toContain(OBJ);
    const [locked] = queryNotes("locked", { dbPath: full }).notes;
    expect(locked).toMatchObject({ locked: true, snippet: "" });
  });

  it("matches bare words in title or body, and locked or undecodable notes by title only", () => {
    expect(pks("budget")).toEqual([103, 100]);
    expect(pks("body:budget")).toEqual([100]);
    expect(pks("title:budget")).toEqual([103]);
    // 103 is locked and 107 undecodable: their bodies are unknown, so a
    // negated body predicate does not match them either (#182).
    expect(pks("-body:budget folder:work")).toEqual([]);
    expect(pks("-body:budget folder:work OR title:budget")).toEqual([103]);
  });

  it("includes deleted and folderless notes only on request", () => {
    expect(pks("budget", { includeDeleted: true })).toEqual([105, 104, 108, 103, 100]);
  });

  it("matches folders by name, nested path, and escaped path", () => {
    expect(pks("folder:work")).toEqual([103, 100, 107]);
    expect(pks("folder:clients")).toEqual([101]);
    expect(pks('folder:"Work/Clients"')).toEqual([101]);
    expect(pks('folder:"Spain/Portugal"')).toEqual([102]);
    expect(pks('folder:"Spain\\\\/Portugal"')).toEqual([102]);
    expect(pks('folder:"work projects"')).toEqual([106]);
    expect(queryNotes("title:trip", { dbPath: full }).notes[0].folder).toBe("Spain\\/Portugal");
  });

  it("resolves the account through the folder, including inherited owners", () => {
    expect(pks("account:icloud")).toEqual([103, 100, 106, 101, 102, 107]);
    expect(pks("account:other")).toEqual([]);
  });

  it("reads native tags only when their inline object is still in the body", () => {
    expect(pks("tag:finance")).toEqual([101]);
    expect(pks("tag:#FINANCE")).toEqual([101]);
    expect(pks("tag:old")).toEqual([]);
    expect(pks("has:tag")).toEqual([101]);
  });

  it("derives facets from the body's attachment runs", () => {
    expect(pks("has:link")).toEqual([100]);
    expect(pks("has:image")).toEqual([101]);
    expect(pks("has:pdf")).toEqual([101]);
    expect(pks("has:attachment")).toEqual([101, 102]);
    expect(pks("has:table")).toEqual([102]);
    expect(pks("has:scan")).toEqual([102]);
    expect(pks("has:audio")).toEqual([102]);
    expect(pks("has:video")).toEqual([102]);
    expect(pks("has:drawing")).toEqual([102]);
    expect(pks("has:checklist")).toEqual([100, 102]);
  });

  it("reads checklist state", () => {
    expect(pks("checklist:open")).toEqual([100]);
    expect(pks("checklist:done")).toEqual([102]);
  });

  it("evaluates flags, including sharing inherited from a folder", () => {
    expect(pks("pinned")).toEqual([100]);
    expect(pks("locked")).toEqual([103]);
    expect(pks("shared")).toEqual([102]);
    expect(pks("-shared -locked -pinned")).toEqual([106, 101, 107]);
  });

  it("compares word counts and dates", () => {
    expect(pks("words:>250")).toEqual([106]);
    // "Trip\n<5 objects>\nPack": attachment placeholders are not words.
    expect(pks("words:<=2")).toEqual([102]);
    expect(pks("words:<2")).toEqual([]);
    expect(pks("created:<2020-01-01")).toEqual([102]);
    expect(pks("created:2026-07-15")).toEqual([100]);
    expect(pks("modified:>=2026-09-01")).toEqual([103, 100, 106]);
    expect(pks("modified:<2026-09-01 -locked")).toEqual([101, 102, 107]);
  });

  it("searches a quoted operator word literally", () => {
    expect(pks('"and"')).toEqual([100, 106]);
  });

  it("combines operators", () => {
    expect(pks("(title:invoice OR tag:finance) modified:>=2026-07-01")).toEqual([101]);
    expect(pks('folder:"Work Projects" OR (has:checklist -checklist:done)')).toEqual([100, 106]);
  });

  it("counts unreadable bodies only when a body predicate needed them", () => {
    expect(queryNotes("zzz", { dbPath: full }).unreadable).toBe(1);
    expect(queryNotes("pinned", { dbPath: full }).unreadable).toBe(0);
  });

  it("applies the result limit and reports the total match count", () => {
    const result = queryNotes("account:icloud", { dbPath: full, limit: 2 });
    expect(result).toMatchObject({ count: 2, matched: 6, limit: 2, truncated: true });
  });

  it("scans only the most recent scanLimit notes and says so", () => {
    const result = queryNotes("account:icloud", { dbPath: full, scanLimit: 2 });
    expect(result).toMatchObject({ scanned: 2, eligible: 6, scanTruncated: true, matched: 2 });
    expect(result.notes.map((n) => n.id.split("/p")[1])).toEqual(["103", "100"]);
  });

  it("clamps scanLimit to the hard ceiling", () => {
    expect(queryNotes("pinned", { dbPath: full, scanLimit: 10 ** 6 }).scanLimit).toBe(
      QUERY_SCAN.MAX
    );
  });

  it("degrades on a store that lacks every optional column", () => {
    const result = queryNotes("budget", { dbPath: minimal });
    // No ZMARKEDFORDELETION/ZFOLDERTYPE: only folderless notes are excluded,
    // and without ZISPASSWORDPROTECTED the encrypted body is simply unreadable.
    expect(result.notes.map((n) => Number(n.id.split("/p")[1]))).toEqual([104, 108, 103, 100]);
    expect(result.notes[0]).not.toHaveProperty("account");
    expect(queryNotes("pinned OR shared OR tag:finance", { dbPath: minimal }).count).toBe(0);
  });

  it("rejects a malformed query before touching the database", () => {
    expect(() => queryNotes("(", { dbPath: join(dir, "absent.sqlite") })).toThrow(NoteQueryError);
  });

  it("classifies a missing or unopenable database as a Full Disk Access problem", () => {
    const check = (dbPath: string, kind: string) => {
      try {
        queryNotes("x", { dbPath });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(NoteQueryStoreError);
        expect((error as NoteQueryStoreError).kind).toBe(kind);
      }
    };
    check(join(dir, "absent.sqlite"), "no_fda");
    const directory = join(dir, "a-directory");
    mkdirSync(directory);
    check(directory, "no_fda");
    const garbage = join(dir, "garbage.sqlite");
    writeFileSync(garbage, "this is not a sqlite database, just text padding ".repeat(20));
    check(garbage, "query_error");
  });

  it("never writes to the store", () => {
    const before = execFileSync(
      "sqlite3",
      [full, "SELECT count(*), total(Z_PK) FROM ZICCLOUDSYNCINGOBJECT; PRAGMA data_version;"],
      { encoding: "utf8" }
    );
    queryNotes("budget OR has:link OR tag:finance", { dbPath: full, includeDeleted: true });
    const after = execFileSync(
      "sqlite3",
      [full, "SELECT count(*), total(Z_PK) FROM ZICCLOUDSYNCINGOBJECT; PRAGMA data_version;"],
      { encoding: "utf8" }
    );
    expect(after).toBe(before);
  });
});

// -----------------------------------------------------------------------------
// Generated SQL
// -----------------------------------------------------------------------------

describe("queryNotes match details against a fixture NoteStore", () => {
  const hit = (query: string, pk: number, options: Parameters<typeof queryNotes>[1] = {}) => {
    const found = queryNotes(query, { dbPath: full, ...options }).notes.find(
      (n) => n.id === `x-coredata://${UUID}/ICNote/p${pk}`
    );
    if (!found) throw new Error(`note ${pk} did not match ${query}`);
    return found;
  };

  it("reports where a bare word occurs: title, body, or both", () => {
    expect(hit("budget", 100).matchedIn).toEqual(["body"]);
    expect(hit("invoice", 101).matchedIn).toEqual(["title"]);
    expect(hit("meeting budget", 100).matchedIn).toEqual(["title", "body"]);
    expect(hit("budget", 104, { includeDeleted: true }).matchedIn).toEqual(["title", "body"]);
  });

  it("answers a title:-only query from the title without reading bodies", () => {
    const result = queryNotes("title:invoice", { dbPath: full });
    expect(result.notes[0].matchedIn).toEqual(["title"]);
    // The body was not fetched: the column snippet, not a decoded one, is shown.
    expect(queryNotes("title:meeting", { dbPath: full }).notes[0].snippet).toBe("column snippet");
  });

  it("omits matchedIn for a locked note and for a query without text terms", () => {
    const locked = hit("budget", 103);
    expect(locked.locked).toBe(true);
    expect(locked).not.toHaveProperty("matchedIn");
    expect(hit("pinned", 100)).not.toHaveProperty("matchedIn");
  });

  it("reports an empty list for a note that matched through a metadata branch", () => {
    expect(hit("pinned OR zzz", 100).matchedIn).toEqual([]);
  });

  it("adds no wordCount unless asked", () => {
    expect(hit("budget", 100)).not.toHaveProperty("wordCount");
  });

  it("counts words from bodies the query already decoded, null for locked notes", () => {
    const result = queryNotes("budget", { dbPath: full, includeWordCount: true });
    expect(result.notes.map((n) => n.wordCount)).toEqual([null, 12]);
    // The same count the words: filter uses.
    expect(hit("words:>250", 106, { includeWordCount: true }).wordCount).toBe(302);
  });

  it("reads bodies for the returned notes only when a metadata-only query asks for counts", () => {
    const result = queryNotes("account:icloud", { dbPath: full, includeWordCount: true });
    expect(result.notes.map((n) => [Number(n.id.split("/p")[1]), n.wordCount])).toEqual([
      [103, null],
      [100, 12],
      [106, 302],
      [101, 4],
      [102, 2],
      [107, null],
    ]);
    expect(result.unreadable).toBe(0);
    const limited = queryNotes("account:icloud", {
      dbPath: full,
      includeWordCount: true,
      limit: 1,
    });
    expect(limited.notes.map((n) => n.wordCount)).toEqual([null]);
  });
});

describe("readNoteTexts and buildNoteTextsSql", () => {
  const all = new Set(FULL_COLUMNS.map((c) => c.split(" ")[0]));

  it("decodes text for the requested notes; locked and unreadable bodies are null", () => {
    const { uuid, texts } = readNoteTexts([100, 103, 107, 999, 100], { dbPath: full });
    expect(uuid).toBe(UUID);
    expect(texts.get(100)).toContain("Agenda: budget review and hiring");
    expect(texts.get(103)).toBeNull();
    expect(texts.get(107)).toBeNull();
    expect(texts.has(999)).toBe(false);
    // Folder and account rows are not notes.
    expect(readNoteTexts([10, 1], { dbPath: full }).texts.size).toBe(0);
  });

  it("still returns null for a locked body on a store without the lock column", () => {
    expect(readNoteTexts([103], { dbPath: minimal }).texts.get(103)).toBeNull();
  });

  it("classifies a missing database as a Full Disk Access problem", () => {
    expect(() => readNoteTexts([1], { dbPath: join(dir, "absent.sqlite") })).toThrow(
      expect.objectContaining({ kind: "no_fda" })
    );
  });

  it("compiles on real sqlite3, read-only, with and without optional columns", () => {
    const minimalSet = new Set(MINIMAL_COLUMNS.map((c) => c.split(" ")[0]));
    for (const [columns, path] of [
      [all, full],
      [minimalSet, minimal],
    ] as const) {
      for (const keys of [[], [100], [100, 101, 106]]) {
        const sql = buildNoteTextsSql(columns, keys);
        expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ATTACH|PRAGMA)\b/i);
        expect(() =>
          execFileSync("sqlite3", ["-readonly", path, sql], { stdio: ["pipe", "pipe", "pipe"] })
        ).not.toThrow();
      }
    }
    expect(buildNoteTextsSql(minimalSet, [1])).toContain("'locked', 0");
    expect(buildNoteTextsSql(all, [])).toContain("IN (NULL)");
  });

  it("refuses keys that are not positive safe integers, too many keys, or a bare schema", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => buildNoteTextsSql(all, [bad])).toThrow(NoteQueryStoreError);
    }
    const tooMany = Array.from({ length: NOTE_TEXT_BATCH_MAX + 1 }, (_, i) => i + 1);
    expect(() => buildNoteTextsSql(all, tooMany)).toThrow(/At most/);
    expect(() => buildNoteTextsSql(new Set(["Z_PK"]), [1])).toThrow(/Z_ENT/);
  });

  it("decodeBodyHex returns null for bytes that are not a gzipped document", () => {
    expect(decodeBodyHex(Buffer.from("not gzip").toString("hex"))).toBeNull();
    expect(decodeBodyHex(noteDocument("A\nb").toString("hex"))?.text).toBe("A\nb");
  });
});

describe("buildScanSql", () => {
  const all = new Set(FULL_COLUMNS.map((c) => c.split(" ")[0]));
  const base = { scanLimit: 500, includeDeleted: false, withBodies: false, withTags: false };

  it("runs inside one read transaction and looks entities up by name", () => {
    const sql = buildScanSql(all, base);
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.endsWith("COMMIT;")).toBe(true);
    for (const name of ["ICNote", "ICFolder", "ICAccount"]) {
      expect(sql).toContain(`Z_NAME='${name}'`);
    }
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ATTACH|PRAGMA)\b/i);
  });

  it("orders by modification date and applies the scan bound", () => {
    expect(buildScanSql(all, { ...base, scanLimit: 42 })).toContain(
      "ORDER BY n.ZMODIFICATIONDATE1 DESC, n.Z_PK DESC LIMIT 42;"
    );
  });

  it("fetches bodies and tag rows only when the query needs them", () => {
    const lean = buildScanSql(all, base);
    expect(lean).toContain("'data', NULL");
    expect(lean).not.toContain("hex(d.ZDATA)");
    expect(lean).not.toContain("inlinetextattachment.hashtag");
    const rich = buildScanSql(all, { ...base, withBodies: true, withTags: true });
    expect(rich).toContain(
      "'data', (SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK"
    );
    expect(lean).not.toContain("ZICNOTEDATA");
    expect(rich).toContain("t.ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.hashtag'");
  });

  it("excludes Recently Deleted, pending deletion, and folderless notes by default", () => {
    const sql = buildScanSql(all, base);
    expect(sql).toContain("n.ZFOLDER IS NOT NULL");
    expect(sql).toContain("COALESCE(n.ZMARKEDFORDELETION, 0) = 0");
    expect(sql).toContain("ZFOLDERTYPE = 1");
    const inclusive = buildScanSql(all, { ...base, includeDeleted: true });
    expect(inclusive).not.toContain("n.ZFOLDER IS NOT NULL");
    expect(inclusive).not.toContain("ZMARKEDFORDELETION");
  });

  it("coalesces whichever creation-date columns exist, newest schema first", () => {
    expect(buildScanSql(all, base)).toContain("COALESCE(n.ZCREATIONDATE3, n.ZCREATIONDATE1)");
    const minimalSet = new Set(MINIMAL_COLUMNS.map((c) => c.split(" ")[0]));
    const sql = buildScanSql(minimalSet, base);
    expect(sql).toContain("'created', NULL");
    expect(sql).toContain("'pinned', 0");
  });

  it("refuses a schema without the required columns", () => {
    const missing = new Set(["Z_PK", "Z_ENT", "ZTITLE1"]);
    expect(() => buildScanSql(missing, base)).toThrow(/ZFOLDER, ZMODIFICATIONDATE1/);
  });

  it("refuses a scan bound outside 1..MAX", () => {
    expect(() => buildScanSql(all, { ...base, scanLimit: 0 })).toThrow(NoteQueryStoreError);
    expect(() => buildScanSql(all, { ...base, scanLimit: QUERY_SCAN.MAX + 1 })).toThrow(
      NoteQueryStoreError
    );
  });

  it("compiles on real sqlite3 for every option combination", () => {
    for (const withBodies of [false, true])
      for (const withTags of [false, true])
        for (const includeDeleted of [false, true]) {
          const sql = buildScanSql(all, { scanLimit: 5, includeDeleted, withBodies, withTags });
          expect(() =>
            execFileSync("sqlite3", ["-readonly", full, sql], { stdio: ["pipe", "pipe", "pipe"] })
          ).not.toThrow();
        }
  });
});

// -----------------------------------------------------------------------------
// Body decoding and helpers
// -----------------------------------------------------------------------------

describe("decodeNoteBody", () => {
  const decode = (buffer: Buffer) =>
    decodeNoteBody(new Uint8Array(execFileSync("gunzip", ["-c"], { input: buffer })));

  it("reads text, links, attachment facets, and inline object ids", () => {
    const body = decode(noteDocument(invoice.text, invoice.runs))!;
    expect(body.text).toBe(invoice.text);
    expect([...body.facets].sort()).toEqual(["attachment", "image", "pdf"]);
    expect([...body.objectIds].sort()).toEqual(["IMG1", "PDF1", "TAG1"]);
  });

  it("counts a checklist item once even when several runs style it", () => {
    const doc = segments([
      "List\n",
      { text: "Buy ", checklist: { id: "cc01", done: false } },
      { text: "milk\n", checklist: { id: "cc01", done: false }, link: "https://x.test" },
      { text: "Done\n", checklist: { id: "cc02", done: true } },
    ]);
    const body = decode(noteDocument(doc.text, doc.runs))!;
    expect(body.checklist).toEqual({ total: 2, open: 1 });
    expect(body.facets.has("checklist")).toBe(true);
    expect(body.facets.has("link")).toBe(true);
  });

  it("tolerates link schemes the strict rich-text reader rejects", () => {
    const doc = segments(["Call ", { text: "me", link: "tel:+15555550100" }]);
    expect(decode(noteDocument(doc.text, doc.runs))?.facets.has("link")).toBe(true);
  });

  it("returns null for a document without a text body", () => {
    expect(decodeNoteBody(new Uint8Array([]))).toBeNull();
  });
});

describe("facetsForAttachmentType", () => {
  it.each([
    ["public.jpeg", ["attachment", "image"]],
    ["public.heic", ["attachment", "image"]],
    ["com.adobe.raw-image", ["attachment", "image"]],
    ["public.url", ["attachment", "link"]],
    ["com.adobe.pdf", ["attachment", "pdf"]],
    ["com.apple.paper.doc.pdf", ["attachment", "pdf"]],
    ["com.apple.paper.doc.scan", ["attachment", "scan"]],
    ["com.apple.notes.gallery", ["attachment", "scan"]],
    ["com.apple.paper", ["attachment", "drawing"]],
    ["com.apple.drawing.2", ["attachment", "drawing"]],
    ["com.apple.m4a-audio", ["attachment", "audio"]],
    ["public.mpeg-4-audio", ["attachment", "audio"]],
    ["com.apple.quicktime-movie", ["attachment", "video"]],
    ["public.mpeg-4", ["attachment", "video"]],
    ["public.data", ["attachment"]],
    ["com.apple.notes.table", ["table"]],
    ["com.apple.notes.inlinetextattachment.hashtag", []],
    ["com.apple.notes.inlinetextattachment.mention", []],
    ["com.apple.notes.inlinetextattachment.link", ["link"]],
  ])("%s → %j", (uti, facets) => {
    expect(facetsForAttachmentType(uti)).toEqual(facets);
  });
});

describe("countWords", () => {
  it("counts whitespace-delimited words containing a letter or digit", () => {
    expect(countWords("Hello, world — 42 !! ok")).toBe(4);
    expect(countWords(`a${OBJ}b`)).toBe(2);
    expect(countWords("   ")).toBe(0);
    expect(countWords("naïve café")).toBe(2);
  });
});

describe("resolveFolders", () => {
  it("builds escaped paths, inherits owner and sharing, and survives cycles", () => {
    const folders = resolveFolders([
      { pk: 1, name: "A/B", parent: null, type: 0, owner: 7, shared: 1 },
      { pk: 2, name: "C", parent: 1, type: 0, owner: null, shared: 0 },
      { pk: 3, name: "X", parent: 4, type: 0, owner: 7, shared: 0 },
      { pk: 4, name: "Y", parent: 3, type: 0, owner: 7, shared: 0 },
    ]);
    expect(folders.get(2)).toMatchObject({
      path: "A\\/B/C",
      accountPk: 7,
      shared: true,
      keys: ["c", "a/b/c", "a\\/b/c"],
    });
    expect(folders.get(3)?.path).toBeDefined();
    expect(folders.get(4)?.path).toBeDefined();
  });
});
