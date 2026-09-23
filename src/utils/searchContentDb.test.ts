/**
 * Tests for search-notes' database-backed body search (#100).
 *
 * Like noteQueryStore.test.ts, these run the generated SQL through the real
 * sqlite3 CLI against a throwaway fixture store; the live NoteStore is never
 * touched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import {
  buildSearchContentQuery,
  contentSearchFailureHint,
  describeContentScan,
  searchContentViaDatabase,
} from "./searchContentDb.js";
import { NoteQueryStoreError } from "./noteQueryStore.js";

// Minimal protobuf encoding of a Notes document: Document.2 → Version.3 → String{2: text}.
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
};
const lField = (field: number, data: number[] | string) => {
  const bytes = typeof data === "string" ? [...Buffer.from(data, "utf8")] : data;
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
};
const vField = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const doc = (text: string) =>
  gzipSync(
    Buffer.from(lField(2, lField(3, [...lField(2, text), ...lField(5, vField(1, text.length))])))
  );

const UUID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ENT = { note: 7, folder: 8, account: 9 };
const cd = (y: number, m: number, d: number) =>
  (Date.UTC(y, m - 1, d, 12) - Date.UTC(2001, 0, 1)) / 1000;

const sql = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

const COLUMNS = [
  "Z_PK INTEGER PRIMARY KEY",
  "Z_ENT INTEGER",
  "ZTITLE1 TEXT",
  "ZFOLDER INTEGER",
  "ZMODIFICATIONDATE1 REAL",
  "ZCREATIONDATE3 REAL",
  "ZISPASSWORDPROTECTED INTEGER",
  "ZMARKEDFORDELETION INTEGER",
  "ZFOLDERTYPE INTEGER",
  "ZTITLE2 TEXT",
  "ZPARENT INTEGER",
  "ZOWNER INTEGER",
  "ZNAME TEXT",
];

const OBJECTS: Array<Record<string, unknown>> = [
  { Z_PK: 1, Z_ENT: ENT.account, ZNAME: "iCloud" },
  { Z_PK: 2, Z_ENT: ENT.account, ZNAME: "On My Mac" },
  { Z_PK: 10, Z_ENT: ENT.folder, ZTITLE2: "Notes", ZOWNER: 1, ZFOLDERTYPE: 0 },
  { Z_PK: 11, Z_ENT: ENT.folder, ZTITLE2: "Work", ZOWNER: 1, ZFOLDERTYPE: 0 },
  { Z_PK: 12, Z_ENT: ENT.folder, ZTITLE2: "Clients", ZPARENT: 11, ZFOLDERTYPE: 0 },
  { Z_PK: 13, Z_ENT: ENT.folder, ZTITLE2: "Recently Deleted", ZOWNER: 1, ZFOLDERTYPE: 1 },
  { Z_PK: 14, Z_ENT: ENT.folder, ZTITLE2: "Notes", ZOWNER: 2, ZFOLDERTYPE: 0 },
  // 100: body match only
  {
    Z_PK: 100,
    Z_ENT: ENT.note,
    ZTITLE1: "Groceries",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 9, 1),
    ZCREATIONDATE3: cd(2026, 1, 1),
  },
  // 101: title-line match only (AppleScript's body includes the title line)
  {
    Z_PK: 101,
    Z_ENT: ENT.note,
    ZTITLE1: "The Plan",
    ZFOLDER: 11,
    ZMODIFICATIONDATE1: cd(2026, 8, 1),
  },
  // 102: nested folder, older
  { Z_PK: 102, Z_ENT: ENT.note, ZTITLE1: "Acme", ZFOLDER: 12, ZMODIFICATIONDATE1: cd(2025, 3, 1) },
  // 103: Recently Deleted — excluded
  { Z_PK: 103, Z_ENT: ENT.note, ZTITLE1: "Trash", ZFOLDER: 13, ZMODIFICATIONDATE1: cd(2026, 9, 2) },
  // 104: other account
  { Z_PK: 104, Z_ENT: ENT.note, ZTITLE1: "Local", ZFOLDER: 14, ZMODIFICATIONDATE1: cd(2026, 9, 3) },
  // 105: no match
  {
    Z_PK: 105,
    Z_ENT: ENT.note,
    ZTITLE1: "Unrelated",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 9, 4),
  },
  // 106: locked — body never searched, title does not match
  {
    Z_PK: 106,
    Z_ENT: ENT.note,
    ZTITLE1: "Locked",
    ZFOLDER: 10,
    ZMODIFICATIONDATE1: cd(2026, 9, 5),
    ZISPASSWORDPROTECTED: 1,
  },
];

const BODIES: Array<[number, Buffer]> = [
  [100, doc("Groceries\nmilk, eggs, and THE bread")],
  [101, doc("The Plan\nstep one")],
  [102, doc("Acme\nthe contract renewal")],
  [103, doc("Trash\nthe old stuff")],
  [104, doc("Local\nthe local copy")],
  [105, doc("Unrelated\nnothing here")],
  [106, doc("Locked\nthe secret")],
];

let dir: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "search-content-db-test-"));
  db = join(dir, "store.sqlite");
  const names = COLUMNS.map((c) => c.split(" ")[0]);
  const script = [
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
    `INSERT INTO Z_PRIMARYKEY VALUES (${ENT.note}, 'ICNote'), (${ENT.folder}, 'ICFolder'), (${ENT.account}, 'ICAccount');`,
    "CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID TEXT);",
    `INSERT INTO Z_METADATA VALUES (1, '${UUID}');`,
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (${COLUMNS.join(", ")});`,
    "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);",
    ...OBJECTS.map((row) => {
      const keys = Object.keys(row).filter((k) => names.includes(k));
      return `INSERT INTO ZICCLOUDSYNCINGOBJECT (${keys.join(", ")}) VALUES (${keys.map((k) => sql(row[k])).join(", ")});`;
    }),
    ...BODIES.map(
      ([note, data], i) => `INSERT INTO ZICNOTEDATA VALUES (${i + 1}, ${note}, ${sql(data)});`
    ),
  ].join("\n");
  execFileSync("sqlite3", [db], { input: script, stdio: ["pipe", "pipe", "pipe"] });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const search = (options: Partial<Parameters<typeof searchContentViaDatabase>[0]> = {}) =>
  searchContentViaDatabase({ query: "the", limit: 50, dbPath: db, ...options });
const pks = (options: Partial<Parameters<typeof searchContentViaDatabase>[0]> = {}) =>
  search(options).notes.map((n) => Number(n.id.split("/p")[1]));

describe("buildSearchContentQuery", () => {
  it("keeps the caller's text as one literal term, never parsed as query syntax", () => {
    expect(buildSearchContentQuery({ query: 'title:x OR -y "z' })).toEqual({
      type: "text",
      field: "any",
      value: 'title:x OR -y "z',
    });
  });

  it("adds folder, account, and modifiedSince constraints", () => {
    const node = buildSearchContentQuery({
      query: "q",
      folder: " Work ",
      account: "iCloud",
      modifiedSince: "2026-01-01",
    });
    expect(node.type).toBe("and");
    if (node.type !== "and") return;
    expect(node.children).toEqual([
      { type: "text", field: "any", value: "q" },
      { type: "folder", value: "Work" },
      { type: "account", value: "iCloud" },
      expect.objectContaining({
        type: "date",
        field: "modified",
        op: ">=",
        start: Date.parse("2026-01-01"),
      }),
    ]);
  });

  it("ignores an unparseable modifiedSince, as the AppleScript path does", () => {
    expect(buildSearchContentQuery({ query: "q", modifiedSince: "not a date" })).toEqual({
      type: "text",
      field: "any",
      value: "q",
    });
  });
});

describe("searchContentViaDatabase against a fixture NoteStore", () => {
  it("matches bodies and title lines case-insensitively, newest first, excluding Recently Deleted and locked bodies", () => {
    expect(pks()).toEqual([104, 100, 101, 102]);
  });

  it("returns Note-shaped results with CoreData ids, folder paths, account, and dates", () => {
    const acme = search({ query: "contract" }).notes[0];
    expect(acme).toMatchObject({
      id: `x-coredata://${UUID}/ICNote/p102`,
      title: "Acme",
      folder: "Work/Clients",
      account: "iCloud",
      content: "",
      tags: [],
    });
    expect(acme.modified.toISOString()).toBe(new Date(Date.UTC(2025, 2, 1, 12)).toISOString());
  });

  it("scopes to an account", () => {
    expect(pks({ account: "iCloud" })).toEqual([100, 101, 102]);
    expect(pks({ account: "On My Mac" })).toEqual([104]);
  });

  it("scopes to a folder by name or by path", () => {
    expect(pks({ folder: "Clients" })).toEqual([102]);
    expect(pks({ folder: "Work/Clients" })).toEqual([102]);
    expect(pks({ folder: "Work" })).toEqual([101]);
  });

  it("applies modifiedSince", () => {
    expect(pks({ modifiedSince: "2026-08-15" })).toEqual([104, 100]);
  });

  it("applies the result limit but still counts every match", () => {
    const result = search({ limit: 2 });
    expect(result.notes).toHaveLength(2);
    expect(result.scan.matched).toBe(4);
    expect(result.scan.scanTruncated).toBe(false);
  });

  it("does not cap the limit at query-notes' maximum", () => {
    expect(search({ limit: 10_000 }).notes).toHaveLength(4);
  });

  it("reports an unreadable database as NoteQueryStoreError so the caller can fall back", () => {
    let caught: unknown;
    try {
      search({ dbPath: join(dir, "missing.sqlite") });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoteQueryStoreError);
    expect((caught as NoteQueryStoreError).kind).toBe("no_fda");
  });
});

describe("describeContentScan", () => {
  it("is empty when the whole library was scanned or the database was not used", () => {
    expect(describeContentScan(undefined)).toBe("");
    expect(describeContentScan({ scanned: 5, eligible: 5, scanTruncated: false, matched: 1 })).toBe(
      ""
    );
  });

  it("discloses a truncated scan window", () => {
    const note = describeContentScan({
      scanned: 5000,
      eligible: 6200,
      scanTruncated: true,
      matched: 3,
    });
    expect(note).toContain("5000 most recently modified of 6200 notes");
    expect(note).toContain("searchContent: false");
  });
});

describe("contentSearchFailureHint", () => {
  const timeout = 'Failed to search notes for "the": Operation timed out after 30 seconds.';

  it("leaves non-timeout errors unchanged", () => {
    expect(contentSearchFailureHint("boom", "no_fda")).toBe("boom");
  });

  it("points a timeout at Full Disk Access when that is why the database was skipped", () => {
    const message = contentSearchFailureHint(timeout, "no_fda");
    expect(message).toContain(timeout);
    expect(message).toContain("Full Disk Access");
    expect(message).toContain("`modifiedSince`");
  });

  it("omits the Full Disk Access remedy when the database failed for another reason", () => {
    expect(contentSearchFailureHint(timeout, "schema")).not.toContain("Full Disk Access");
  });
});
