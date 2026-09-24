/**
 * Tests for the identifier bridge.
 *
 * The SQL is not mocked: a mocked sqlite3 would hide a SQL compile error until
 * it met a real database. Each run builds a throwaway fixture store in a temp
 * directory with the NoteStore tables and columns the bridge reads, and runs
 * the generated SQL through the real sqlite3 CLI (present on every macOS,
 * including the CI runners). The live NoteStore is never touched: every call
 * below passes the fixture path, and the schema tests inject a resolver bound
 * to it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildLookupSql,
  buildResolveSql,
  canonicalCoreDataId,
  exactIdArrayInput,
  exactIdInput,
  identifierForm,
  IdentifierResolutionError,
  lookupStableIdentifiers,
  looseIdTransform,
  NOTE_ID_MESSAGE,
  resolveIdentifiers,
  withStableIdentifiers,
  type IdentifierEntity,
} from "./noteIdentifiers.js";

// Synthetic identifiers only.
const STORE = "11111111-2222-3333-4444-555555555555";
const OTHER_STORE = "99999999-8888-7777-6666-555555555555";
const ACCOUNT_UUID = "AAAAAAAA-0000-0000-0000-000000000001";
const FOLDER_UUID = "BBBBBBBB-0000-0000-0000-000000000010";
const SUBFOLDER_UUID = "BBBBBBBB-0000-0000-0000-000000000011";
const NOTE_UUID = "CCCCCCCC-0000-0000-0000-000000000020";
const LOWER_NOTE_UUID = "cccccccc-0000-0000-0000-000000000021";
const ATTACHMENT_UUID = "DDDDDDDD-0000-0000-0000-000000000030";
const UNKNOWN_UUID = "EEEEEEEE-0000-0000-0000-000000000099";

// Entity numbers deliberately differ from a real store's, so the SQL must look
// them up in Z_PRIMARYKEY rather than hard-code them.
const ENT = { note: 41, folder: 42, account: 43, attachment: 44 };

const note = (pk: number, store = STORE) => `x-coredata://${store}/ICNote/p${pk}`;
const folder = (pk: number) => `x-coredata://${STORE}/ICFolder/p${pk}`;

const OBJECTS = [
  `(3, ${ENT.account}, '${ACCOUNT_UUID}', NULL, NULL, NULL)`,
  `(10, ${ENT.folder}, '${FOLDER_UUID}', NULL, 3, NULL)`,
  `(11, ${ENT.folder}, '${SUBFOLDER_UUID}', NULL, 3, 10)`,
  `(20, ${ENT.note}, '${NOTE_UUID}', 11, NULL, NULL)`,
  `(21, ${ENT.note}, '${LOWER_NOTE_UUID}', 10, NULL, NULL)`,
  `(22, ${ENT.note}, NULL, NULL, NULL, NULL)`,
  `(30, ${ENT.attachment}, '${ATTACHMENT_UUID}', NULL, NULL, NULL)`,
];

let dir: string;
let db: string;

function createStore(path: string) {
  const sql = [
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
    `INSERT INTO Z_PRIMARYKEY VALUES (${ENT.note}, 'ICNote'), (${ENT.folder}, 'ICFolder'), (${ENT.account}, 'ICAccount'), (${ENT.attachment}, 'ICAttachment');`,
    "CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID TEXT);",
    `INSERT INTO Z_METADATA VALUES (1, '${STORE}');`,
    "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZFOLDER INTEGER, ZOWNER INTEGER, ZPARENT INTEGER);",
    "CREATE UNIQUE INDEX Z_ICCloudSyncingObject_UNIQUE_identifier ON ZICCLOUDSYNCINGOBJECT (ZIDENTIFIER);",
    `INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES ${OBJECTS.join(", ")};`,
  ].join("\n");
  execFileSync("sqlite3", [path], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "notes-identifiers-"));
  db = join(dir, "NoteStore.sqlite");
  createStore(db);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixtureResolver = (values: string[], entity: IdentifierEntity) =>
  resolveIdentifiers(values, entity, db);

function resolutionError(fn: () => unknown): IdentifierResolutionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IdentifierResolutionError);
    return error as IdentifierResolutionError;
  }
  throw new Error("expected an IdentifierResolutionError");
}

describe("identifierForm", () => {
  it("classifies UUIDs, numeric keys, and everything else", () => {
    expect(identifierForm(NOTE_UUID)).toBe("uuid");
    expect(identifierForm(LOWER_NOTE_UUID)).toBe("uuid");
    expect(identifierForm("20")).toBe("key");
    expect(identifierForm(note(20))).toBe("other");
    expect(identifierForm("p20")).toBe("other");
    expect(identifierForm("-20")).toBe("other");
    expect(identifierForm("1234567890123456789")).toBe("other"); // 19 digits
    expect(identifierForm(`${NOTE_UUID}0`)).toBe("other");
    expect(identifierForm("GGGGGGGG-0000-0000-0000-000000000020")).toBe("other");
    expect(identifierForm("Meeting notes")).toBe("other");
  });
});

describe("SQL builders", () => {
  it("refuse any value outside the strict UUID and digit patterns", () => {
    expect(() => buildResolveSql("ICNote", ["1); DROP TABLE x;--"], [])).toThrow(/invalid/);
    expect(() => buildResolveSql("ICNote", [], ["' OR 1=1 --"])).toThrow(/invalid/);
    expect(() => buildLookupSql("ICNote", ["1 OR 1"])).toThrow(/invalid/);
  });

  it("compile against a real sqlite3 store for every entity", () => {
    for (const entity of ["ICNote", "ICFolder", "ICAccount"] as const) {
      const out = execFileSync("sqlite3", ["-readonly", db, buildLookupSql(entity, ["3"])], {
        encoding: "utf8",
      });
      expect(JSON.parse(out).store).toBe(STORE);
    }
    const out = execFileSync("sqlite3", ["-readonly", db, buildResolveSql("ICNote", [], [])], {
      encoding: "utf8",
    });
    expect(JSON.parse(out).rows).toEqual([]);
  });
});

describe("resolveIdentifiers", () => {
  it("resolves a note UUID and numeric key to the same x-coredata id", () => {
    const map = resolveIdentifiers([NOTE_UUID, "20"], "ICNote", db);
    expect(map.get(NOTE_UUID)).toBe(note(20));
    expect(map.get("20")).toBe(note(20));
  });

  it("matches UUIDs case-insensitively in both directions", () => {
    const map = resolveIdentifiers(
      [NOTE_UUID.toLowerCase(), LOWER_NOTE_UUID.toUpperCase()],
      "ICNote",
      db
    );
    expect(map.get(NOTE_UUID.toLowerCase())).toBe(note(20));
    expect(map.get(LOWER_NOTE_UUID.toUpperCase())).toBe(note(21));
  });

  it("treats leading zeros in a numeric key as the same key", () => {
    expect(resolveIdentifiers(["0021"], "ICNote", db).get("0021")).toBe(note(21));
  });

  it("resolves a note without a UUID by its numeric key", () => {
    expect(resolveIdentifiers(["22"], "ICNote", db).get("22")).toBe(note(22));
  });

  it("never resolves a numeric key or UUID of another entity to a note", () => {
    expect(resolutionError(() => resolveIdentifiers(["30"], "ICNote", db)).code).toBe("not_found");
    expect(resolutionError(() => resolveIdentifiers(["10"], "ICNote", db)).code).toBe("not_found");
    expect(
      resolutionError(() => resolveIdentifiers([ATTACHMENT_UUID], "ICNote", db)).message
    ).toMatch(/No note found for identifier/);
    expect(resolutionError(() => resolveIdentifiers([FOLDER_UUID], "ICNote", db)).code).toBe(
      "not_found"
    );
  });

  it("resolves folders only to folder rows", () => {
    const map = resolveIdentifiers([SUBFOLDER_UUID, "10"], "ICFolder", db);
    expect(map.get(SUBFOLDER_UUID)).toBe(folder(11));
    expect(map.get("10")).toBe(folder(10));
    expect(resolutionError(() => resolveIdentifiers(["20"], "ICFolder", db)).message).toMatch(
      /No folder found for numeric key 20/
    );
  });

  it("names every value it could not resolve", () => {
    const error = resolutionError(() =>
      resolveIdentifiers([NOTE_UUID, UNKNOWN_UUID, "999"], "ICNote", db)
    );
    expect(error.message).toContain("numeric key 999");
    expect(error.message).toContain(`identifier ${UNKNOWN_UUID}`);
    expect(error.message).not.toContain(NOTE_UUID);
  });

  it("passes x-coredata ids and other values through without opening the database", () => {
    const missing = join(dir, "does-not-exist.sqlite");
    const map = resolveIdentifiers([note(20), "Meeting notes"], "ICNote", missing);
    expect(map.get(note(20))).toBe(note(20));
    expect(map.get("Meeting notes")).toBe("Meeting notes");
  });

  it("reports missing Full Disk Access when the store cannot be reached", () => {
    const missing = join(dir, "does-not-exist.sqlite");
    const error = resolutionError(() => resolveIdentifiers([NOTE_UUID], "ICNote", missing));
    expect(error.code).toBe("no_fda");
    expect(error.message).toMatch(/Full Disk Access/);
    expect(error.message).toMatch(/x-coredata ids .* work without it/);
  });

  it("reports missing Full Disk Access when sqlite3 cannot open the store", () => {
    const unopenable = join(dir, "a-directory.sqlite");
    mkdirSync(unopenable);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(resolutionError(() => resolveIdentifiers(["20"], "ICNote", unopenable)).code).toBe(
        "no_fda"
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("lookupStableIdentifiers", () => {
  it("returns a note's own, folder, and account UUIDs in one batch", () => {
    const map = lookupStableIdentifiers([note(20), note(21), note(22)], "ICNote", db);
    expect(map.get(note(20))).toEqual({
      identifier: NOTE_UUID,
      folderIdentifier: SUBFOLDER_UUID,
      accountIdentifier: ACCOUNT_UUID,
    });
    expect(map.get(note(21))).toEqual({
      identifier: LOWER_NOTE_UUID,
      folderIdentifier: FOLDER_UUID,
      accountIdentifier: ACCOUNT_UUID,
    });
    expect(map.get(note(22))).toEqual({});
  });

  it("returns a folder's parent and account UUIDs", () => {
    const map = lookupStableIdentifiers([folder(10), folder(11)], "ICFolder", db);
    expect(map.get(folder(10))).toEqual({
      identifier: FOLDER_UUID,
      accountIdentifier: ACCOUNT_UUID,
    });
    expect(map.get(folder(11))).toEqual({
      identifier: SUBFOLDER_UUID,
      parentIdentifier: FOLDER_UUID,
      accountIdentifier: ACCOUNT_UUID,
    });
  });

  it("returns an account's UUID", () => {
    const id = `x-coredata://${STORE}/ICAccount/p3`;
    expect(lookupStableIdentifiers([id], "ICAccount", db).get(id)).toEqual({
      identifier: ACCOUNT_UUID,
    });
  });

  it("skips ids from another store, another entity, or another row type", () => {
    const map = lookupStableIdentifiers(
      [note(20, OTHER_STORE), folder(10), note(30), "not an id"],
      "ICNote",
      db
    );
    expect(map.size).toBe(0);
  });

  it("returns an empty map instead of failing when the store is unreadable", () => {
    const map = lookupStableIdentifiers([note(20)], "ICNote", join(dir, "missing.sqlite"));
    expect(map.size).toBe(0);
  });
});

describe("withStableIdentifiers", () => {
  it("adds identifier fields and keeps every existing field and item", () => {
    const items = [{ id: note(20), title: "a" }, { id: note(999), title: "b" }, { title: "c" }];
    expect(withStableIdentifiers(items, "ICNote", db)).toEqual([
      {
        id: note(20),
        title: "a",
        identifier: NOTE_UUID,
        folderIdentifier: SUBFOLDER_UUID,
        accountIdentifier: ACCOUNT_UUID,
      },
      { id: note(999), title: "b" },
      { title: "c" },
    ]);
  });

  it("returns items unchanged without database access", () => {
    const items = [{ id: note(20), title: "a" }];
    expect(withStableIdentifiers(items, "ICNote", join(dir, "missing.sqlite"))).toBe(items);
  });
});

describe("id input schemas", () => {
  const PATTERN = /^x-coredata:\/\/[0-9A-Fa-f-]+\/ICNote\/p\d+$/;
  const strict = exactIdInput("ICNote", PATTERN, NOTE_ID_MESSAGE, { resolver: fixtureResolver });

  it("accepts every x-coredata id it accepted before, unchanged and without a lookup", () => {
    const resolver = vi.fn();
    const schema = exactIdInput("ICNote", PATTERN, NOTE_ID_MESSAGE, { resolver });
    expect(schema.parse(note(20))).toBe(note(20));
    expect(resolver).not.toHaveBeenCalled();
  });

  it("resolves a UUID and a numeric key through the real SQL", () => {
    expect(strict.parse(NOTE_UUID)).toBe(note(20));
    expect(strict.parse("21")).toBe(note(21));
  });

  it("rejects values in no accepted form, as before", () => {
    for (const bad of ["", "p20", "abc", "x-coredata://ABC/ICFolder/p1", `${NOTE_UUID}x`]) {
      const result = strict.safeParse(bad);
      expect(result.success).toBe(false);
    }
    const result = strict.safeParse("abc");
    expect(!result.success && result.error.issues[0].message).toBe(NOTE_ID_MESSAGE);
  });

  it("turns a failed resolution into a clear validation issue", () => {
    const result = strict.safeParse("30");
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0].message).toMatch(/No note found/);
  });

  it("keeps the case-insensitive pattern of the native-operation tools", () => {
    const schema = exactIdInput("ICNote", /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i, "bad", {
      resolver: fixtureResolver,
    });
    expect(schema.parse("x-coredata://abc/icnote/p5")).toBe("x-coredata://abc/icnote/p5");
    expect(schema.parse(NOTE_UUID)).toBe(note(20));
  });

  it("resolves a whole array in one lookup and enforces its bounds", () => {
    const resolver = vi.fn(fixtureResolver);
    const schema = exactIdArrayInput("ICNote", PATTERN, NOTE_ID_MESSAGE, {
      resolver,
      maxItems: 3,
    });
    expect(schema.parse([note(21), NOTE_UUID, "22"])).toEqual([note(21), note(20), note(22)]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(schema.safeParse([note(1), note(2), note(3), note(4)]).success).toBe(false);
    resolver.mockClear();
    expect(schema.parse([note(1)])).toEqual([note(1)]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("loose ids resolve only UUIDs and numeric keys and pass everything else through", async () => {
    const { z } = await import("zod");
    const schema = z.string().transform(looseIdTransform("ICNote", fixtureResolver));
    expect(schema.parse("20")).toBe(note(20));
    expect(schema.parse(NOTE_UUID)).toBe(note(20));
    expect(schema.parse("whatever-it-was")).toBe("whatever-it-was");
    expect(schema.parse(note(7))).toBe(note(7));
    expect(schema.safeParse("30").success).toBe(false);
  });
});

describe("canonicalCoreDataId", () => {
  it("upper-cases the store UUID and drops leading zeros from the key", () => {
    expect(canonicalCoreDataId("x-coredata://8fa9-ab/ICFolder/p0012")).toBe(
      "x-coredata://8FA9-AB/ICFolder/p12"
    );
    expect(canonicalCoreDataId("x-coredata://AB/ICNote/p0")).toBe("x-coredata://AB/ICNote/p0");
    expect(canonicalCoreDataId("Meeting notes")).toBe("Meeting notes");
  });
});
