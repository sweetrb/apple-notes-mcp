/**
 * Tests for the smart folder reader.
 *
 * The decoder tests are pure. The reader tests do not mock sqlite3: each run
 * builds a throwaway fixture store in a temp directory with the NoteStore
 * tables and columns the reader uses, and runs the real SQL through the real
 * sqlite3 CLI in read-only mode. The live NoteStore is never touched, and all
 * names and identifiers below are synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decodeSmartFolderQuery, readSmartFolders, SMART_FOLDERS_SQL } from "./smartFolders.js";

const wrap = (inner: unknown, deleted = false) =>
  JSON.stringify({ entity: "note", type: { and: [{ deleted }, inner] } });

describe("decodeSmartFolderQuery", () => {
  it("strips the outer deleted wrapper and decodes match all", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({ and: [{ pinned: true }, { checklistInProgress: true }] })
    );
    expect(decoded.match).toBe("all");
    expect(decoded.includesRecentlyDeleted).toBe(false);
    expect(decoded.query).toEqual({ and: [{ pinned: true }, { checklistInProgress: true }] });
    expect(decoded.filters).toEqual([
      { type: "pinned", value: true, description: "is pinned" },
      { type: "checklistInProgress", value: true, description: "has an unfinished checklist" },
    ]);
    expect(decoded.fullyDecoded).toBe(true);
  });

  it("decodes match any with relative date ranges", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({
        or: [
          { creationDateRelativeRange: { type: 2 } },
          { modificationDateRelativeRange: { type: 6, customAmount: 3, customUnit: 2 } },
        ],
      })
    );
    expect(decoded.match).toBe("any");
    expect(decoded.filters.map((f) => f.description)).toEqual([
      "created in the last 7 days",
      "edited in the last 3 weeks",
    ]);
  });

  it("decodes match none from a top-level not/or", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({ not: { or: [{ shared: true }, { pinned: true }] } })
    );
    expect(decoded.match).toBe("none");
    expect(decoded.filters.map((f) => f.type)).toEqual(["shared", "pinned"]);
    expect(decoded.filters.every((f) => !f.excluded)).toBe(true);
  });

  it("reports includesRecentlyDeleted when the wrapper includes deleted notes", () => {
    const decoded = decodeSmartFolderQuery(wrap({ and: [{ attachment: true }] }, true));
    expect(decoded.includesRecentlyDeleted).toBe(true);
  });

  it("resolves folder identifiers and marks excluded folder groups", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({
        and: [
          { systemPaper: false },
          { or: [{ folder: "FOLDER-A" }] },
          { not: { or: [{ folder: "FOLDER-B" }, { folder: "FOLDER-MISSING" }] } },
        ],
      }),
      {
        folders: {
          "FOLDER-A": { id: "x-coredata://S/ICFolder/p5", title: "Alpha" },
          "FOLDER-B": { id: "x-coredata://S/ICFolder/p6", title: "Beta" },
        },
      }
    );
    const [quick, include, exclude] = decoded.filters;
    expect(quick).toEqual({
      type: "systemPaper",
      value: false,
      description: "is not a Quick Note",
    });
    // A one-item group is the same as its item.
    expect(include).toEqual({
      type: "folder",
      value: "FOLDER-A",
      folderId: "x-coredata://S/ICFolder/p5",
      name: "Alpha",
      description: 'is in folder "Alpha"',
    });
    expect(exclude).toMatchObject({ type: "group", match: "any", excluded: true });
    expect(exclude.filters?.map((f) => f.name ?? f.value)).toEqual(["Beta", "FOLDER-MISSING"]);
    expect(exclude.description).toBe(
      'not any of: is in folder "Beta"; is in folder FOLDER-MISSING (not found)'
    );
  });

  it("decodes tag filters, the Any Tag form, and a single excluded tag", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({
        and: [
          { or: [{ tag: "CODING" }, { tag: "RESEARCH" }] },
          { and: [{ tagged: true }, { deleted: false }] },
          { not: { tag: "ARCHIVE" } },
        ],
      }),
      { tags: { CODING: ["Coding"], RESEARCH: ["Research", "research"] } }
    );
    const [anyTags, anyTag, notTag] = decoded.filters;
    expect(anyTags.match).toBe("any");
    expect(anyTags.filters).toEqual([
      { type: "tag", value: "CODING", name: "Coding", description: "has tag #Coding" },
      // Ambiguous display names are not guessed.
      { type: "tag", value: "RESEARCH", description: "has tag #RESEARCH" },
    ]);
    expect(anyTag).toEqual({ type: "tagged", value: true, description: "has any tag" });
    expect(notTag).toEqual({
      type: "tag",
      value: "ARCHIVE",
      excluded: true,
      description: "does not have tag #ARCHIVE",
    });
  });

  it("describes negated flags and double negation plainly", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({
        and: [
          { not: { pinned: true } },
          { not: { systemPaper: false } },
          { not: { or: [{ not: { folder: "F" } }] } },
          { not: { mentionParticipant: "_me" } },
        ],
      })
    );
    expect(decoded.filters.map((f) => [f.excluded ?? false, f.description])).toEqual([
      [true, "is not pinned"],
      [true, "is a Quick Note"],
      [false, "is in folder F (not found)"],
      [true, "does not mention participant _me"],
    ]);
  });

  it("decodes attachment sections, participants, mentions, and absolute dates", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({
        and: [
          { attachmentSection: 7 },
          { sharedParticipant: "_user1" },
          { mention: false },
          { creationDateRange: { fromDate: 0, toDate: 86400 } },
        ],
      })
    );
    expect(decoded.filters).toEqual([
      { type: "attachmentSection", value: 7, name: "Scans", description: "has Scans attachments" },
      {
        type: "sharedParticipant",
        value: "_user1",
        description: "is shared with participant _user1",
      },
      { type: "mention", value: false, description: "mentions no one" },
      {
        type: "creationDateRange",
        value: { fromDate: 0, toDate: 86400 },
        from: "2001-01-01T00:00:00.000Z",
        to: "2001-01-02T00:00:00.000Z",
        description: "created between 2001-01-01T00:00:00.000Z and 2001-01-02T00:00:00.000Z",
      },
    ]);
    expect(decoded.fullyDecoded).toBe(true);
  });

  it("keeps unrecognized clauses verbatim and clears fullyDecoded", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({ and: [{ futureClause: { x: 1 } }, { attachmentSection: 99 }, { pinned: true }] })
    );
    expect(decoded.fullyDecoded).toBe(false);
    expect(decoded.filters[0]).toMatchObject({
      type: "unknown",
      key: "futureClause",
      value: { x: 1 },
    });
    expect(decoded.filters[1]).toMatchObject({
      type: "unknown",
      key: "attachmentSection",
      value: 99,
    });
    expect(decoded.filters[2].type).toBe("pinned");
  });

  it("treats a multi-key clause as an all-group", () => {
    const decoded = decodeSmartFolderQuery(
      wrap({ or: [{ pinned: true, shared: true }, { checklist: true }] })
    );
    expect(decoded.filters[0]).toMatchObject({ type: "group", match: "all" });
    expect(decoded.filters[0].filters?.map((f) => f.type)).toEqual(["pinned", "shared"]);
  });

  it("decodes a query stored without the wrapper", () => {
    const decoded = decodeSmartFolderQuery(
      JSON.stringify({ entity: "note", type: { or: [{ pinned: true }] } })
    );
    expect(decoded.match).toBe("any");
    expect(decoded.includesRecentlyDeleted).toBeUndefined();
    expect(decoded.filters).toHaveLength(1);
  });

  it("handles absent and unparseable queries without throwing", () => {
    expect(decodeSmartFolderQuery(null)).toEqual({
      match: null,
      filters: [],
      query: null,
      fullyDecoded: false,
    });
    expect(decodeSmartFolderQuery("{not json")).toMatchObject({ match: null, fullyDecoded: false });
    expect(decodeSmartFolderQuery(JSON.stringify([1, 2]))).toMatchObject({
      match: null,
      fullyDecoded: false,
    });
  });

  it("stops at a nesting limit instead of recursing without bound", () => {
    let deep: unknown = { pinned: true };
    for (let i = 0; i < 200; i++) deep = { not: deep };
    const decoded = decodeSmartFolderQuery(wrap({ and: [deep, { shared: true }] }));
    expect(decoded.fullyDecoded).toBe(false);
  });
});

describe("readSmartFolders against a fixture NoteStore", () => {
  let dir: string;
  let db: string;
  const sql = (statements: string) => execFileSync("sqlite3", [db, statements]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "smart-folders-"));
    db = join(dir, "NoteStore.sqlite");
    const query = wrap({ and: [{ systemPaper: false }, { or: [{ folder: "FOLDER-A" }] }] });
    const tagQuery = wrap({ or: [{ tag: "CODING" }] });
    sql(`
      CREATE TABLE Z_METADATA (Z_VERSION INTEGER, Z_UUID VARCHAR, Z_PLIST BLOB);
      CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
      CREATE TABLE ZICCLOUDSYNCINGOBJECT (
        Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR, ZTITLE2 VARCHAR,
        ZFOLDERTYPE INTEGER, ZSMARTFOLDERQUERYJSON VARCHAR, ZPARENT INTEGER, ZOWNER INTEGER,
        ZNAME VARCHAR, ZMARKEDFORDELETION INTEGER, ZSTANDARDIZEDCONTENT VARCHAR, ZDISPLAYTEXT VARCHAR);
      INSERT INTO Z_METADATA VALUES (1, 'AAAA-1111', NULL);
      INSERT INTO Z_PRIMARYKEY VALUES (8, 'ICHashtag', 0, 0), (14, 'ICAccount', 0, 0), (15, 'ICFolder', 0, 0);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME) VALUES (1, 14, 'ACCT-1', 'Synthetic Account');
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE, ZOWNER) VALUES
        (2, 15, 'FOLDER-A', 'Alpha', 0, 1),
        (3, 15, 'PARENT-P', 'Parent', 0, 1);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE, ZSMARTFOLDERQUERYJSON, ZPARENT, ZOWNER, ZMARKEDFORDELETION) VALUES
        (4, 15, 'SMART-1', 'Zeta Smart', 2, '${query}', NULL, 1, 0),
        (5, 15, 'SMART-2', 'Beta Smart', 2, '${tagQuery}', 3, 1, NULL),
        (6, 15, 'SMART-GONE', 'Deleted Smart', 2, '${tagQuery}', NULL, 1, 1);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZSTANDARDIZEDCONTENT, ZDISPLAYTEXT) VALUES (7, 8, 'CODING', 'Coding');
    `);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the real SQL read-only and returns decoded, sorted smart folders", () => {
    const result = readSmartFolders(db);
    expect(result.error).toBeUndefined();
    const folders = result.folders!;
    expect(folders.map((f) => f.name)).toEqual(["Beta Smart", "Zeta Smart"]);
    const [beta, zeta] = folders;
    expect(zeta).toMatchObject({
      id: "x-coredata://AAAA-1111/ICFolder/p4",
      identifier: "SMART-1",
      account: "Synthetic Account",
      accountId: "x-coredata://AAAA-1111/ICAccount/p1",
      accountIdentifier: "ACCT-1",
      parent: null,
      parentId: null,
      parentIdentifier: null,
      match: "all",
      includesRecentlyDeleted: false,
      fullyDecoded: true,
    });
    expect(zeta.filters[1]).toMatchObject({
      type: "folder",
      name: "Alpha",
      folderId: "x-coredata://AAAA-1111/ICFolder/p2",
    });
    expect(zeta.query).toEqual({ and: [{ systemPaper: false }, { or: [{ folder: "FOLDER-A" }] }] });
    expect(JSON.parse(zeta.rawQuery!)).toEqual(
      JSON.parse(wrap({ and: [{ systemPaper: false }, { or: [{ folder: "FOLDER-A" }] }] }))
    );
    expect(beta).toMatchObject({
      parent: "Parent",
      parentId: "x-coredata://AAAA-1111/ICFolder/p3",
      parentIdentifier: "PARENT-P",
      match: "any",
    });
    expect(beta.filters).toEqual([
      { type: "tag", value: "CODING", name: "Coding", description: "has tag #Coding" },
    ]);
  });

  it("refuses to write: the SQL contains no mutating statement", () => {
    expect(SMART_FOLDERS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
  });

  it("reports an unsupported schema instead of failing on missing columns", () => {
    const old = join(dir, "Old.sqlite");
    execFileSync("sqlite3", [
      old,
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, Z_ENT INTEGER);",
    ]);
    const result = readSmartFolders(old);
    expect(result.folders).toBeNull();
    expect(result.error).toBe("unsupported_schema");
    expect(result.message).toContain("ZSMARTFOLDERQUERYJSON");
  });

  it("classifies a missing database as a Full Disk Access problem", () => {
    const result = readSmartFolders(join(dir, "missing.sqlite"));
    expect(result.error).toBe("no_fda");
  });
});
