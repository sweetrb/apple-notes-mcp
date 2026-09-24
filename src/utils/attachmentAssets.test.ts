/**
 * Tests for attachment asset/preview discovery, first-image selection, and
 * batch export.
 *
 * The SQL is not mocked: each run builds a throwaway NoteStore-shaped fixture
 * database and runs the generated query through the real sqlite3 CLI. The
 * filesystem side uses a synthetic group-container tree in a temp directory.
 * The live Notes store is never touched, and every name here is synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  AttachmentStoreError,
  assembleAttachmentAssets,
  assetPathsFor,
  attachmentCoreDataId,
  attachmentOrderFromNoteData,
  buildAttachmentRowsSql,
  classifyAttachmentKind,
  collisionName,
  copyFileExclusive,
  exportAttachmentAssets,
  exportFileName,
  exportOneAttachment,
  exportSource,
  generationRank,
  isInsideNotesContainer,
  listPreviewEntries,
  parseAttachmentRows,
  parseNoteId,
  prepareExportDir,
  previewPaths,
  previewPixelArea,
  readNoteAttachmentRows,
  resolveAccountDir,
  safeComponent,
  selectFirstImage,
  type AttachmentAssetRecord,
  type AttachmentRow,
  type NoteAttachmentAssets,
} from "./attachmentAssets.js";

// -----------------------------------------------------------------------------
// Protobuf fixture encoding (inverse of utils/protobuf.ts)
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

/** A gzipped note body whose attribute runs reference `ids` in order. */
function noteBody(ids: string[]): Buffer {
  const text = "Intro\n" + ids.map(() => "￼").join("");
  const runs = [lField(5, vField(1, 6))];
  for (const id of ids)
    runs.push(lField(5, [...vField(1, 1), ...lField(12, [...lField(1, id), ...lField(2, "x")])]));
  const body = [...lField(2, text), ...runs.flat()];
  return gzipSync(Buffer.from(lField(2, lField(3, body))));
}

// -----------------------------------------------------------------------------
// Fixture store
// -----------------------------------------------------------------------------

const ACCT = "ACCT0000-0000-0000-0000-000000000001";
const STORE = "5A0E0000-0000-0000-0000-000000000000";
const ID = {
  scan: "A0000000-0000-0000-0000-000000000001",
  image: "A0000000-0000-0000-0000-000000000002",
  undownloaded: "A0000000-0000-0000-0000-000000000003",
  url: "A0000000-0000-0000-0000-000000000004",
  paper: "A0000000-0000-0000-0000-000000000005",
  gallery: "A0000000-0000-0000-0000-000000000006",
  child1: "A0000000-0000-0000-0000-000000000007",
  child2: "A0000000-0000-0000-0000-000000000008",
  deleted: "A0000000-0000-0000-0000-000000000009",
  orphan: "A0000000-0000-0000-0000-00000000000A",
  table: "A0000000-0000-0000-0000-00000000000B",
};
const MEDIA = "M0000000-0000-0000-0000-000000000001";
const MEDIA_CHILD = "M0000000-0000-0000-0000-000000000002";

let root: string;
let container: string;
let accountDir: string;
let dbPath: string;
let outside: string;
let exportRoot: string;

const sqlite = (db: string, sql: string) =>
  execFileSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8" });

function file(path: string, data: string | Buffer = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
}

const q = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "att-assets-")));
  container = join(root, "group.com.apple.notes");
  accountDir = join(container, "Accounts", ACCT);
  outside = join(root, "outside");
  exportRoot = join(root, "exports");
  dbPath = join(container, "NoteStore.sqlite");
  mkdirSync(accountDir, { recursive: true });
  file(join(outside, "secret.png"), "secret");

  // Media asset for the image, and for a gallery child.
  file(join(accountDir, "Media", MEDIA, "1_GEN", "photo.jpg"), "JPEGDATA");
  file(join(accountDir, "Media", MEDIA_CHILD, "photo.jpg"), "CHILDDATA");
  // Paper: fallback image in a generation directory, plus an older generation.
  file(join(accountDir, "FallbackImages", ID.paper, "3_NEW", "FallbackImage.png"), "PAPER3");
  file(join(accountDir, "FallbackImages", ID.paper, "1_OLD", "FallbackImage.png"), "PAPER1");
  // Scan: fallback PDF with no recorded generation.
  file(join(accountDir, "FallbackPDFs", ID.scan, "2_GEN", "FallbackPDF.pdf"), "PDF");
  // Previews: flat files and bundle directories of several sizes.
  const P = join(accountDir, "Previews");
  file(join(P, `${ID.image}-1-200x100-0.png`), "small");
  file(join(P, `${ID.image}-2-1024x768-0`, "1_OLD", "Preview.png"), "big-old");
  file(join(P, `${ID.image}-2-1024x768-0`, "2_NEW", "Preview.png"), "big-new");
  file(join(P, `${ID.image}-3-4000x10-0.json`), "{}"); // not an image: ignored
  file(join(P, `${ID.undownloaded}-2-640x480-1`, "1_GEN", "OrientedPreview.png"), "oriented");
  file(join(P, `${ID.url}-1-300x200-0.png`), "card");
  file(join(P, `${ID.scan}-1-10x10-0`, "Preview.png"), "scanprev"); // bundle with a direct file
  // A symlink planted in Previews that points outside must never be returned.
  symlinkSync(join(outside, "secret.png"), join(P, `${ID.url}-9-9999x9999-0.png`));
  // A preview bundle whose only image sits inside a symlinked generation dir.
  mkdirSync(join(P, `${ID.orphan}-1-50x50-0`), { recursive: true });
  symlinkSync(outside, join(P, `${ID.orphan}-1-50x50-0`, "1_GEN"));

  // NoteStore fixture.
  sqlite(
    dbPath,
    [
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
      "INSERT INTO Z_PRIMARYKEY VALUES (5,'ICAttachment'),(11,'ICMedia'),(12,'ICNote'),(14,'ICAccount');",
      "CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);",
      `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT,
        ZTYPEUTI TEXT, ZNOTE INTEGER, ZPARENTATTACHMENT INTEGER, ZMEDIA INTEGER, ZFILENAME TEXT,
        ZGENERATION1 TEXT, ZFALLBACKIMAGEGENERATION TEXT, ZFALLBACKPDFGENERATION TEXT,
        ZMARKEDFORDELETION INTEGER, ZACCOUNT1 INTEGER, ZACCOUNT7 INTEGER);`,
    ].join("\n")
  );
  const rows: Array<Array<string | number | null>> = [
    // pk, ent, identifier, uti, note, parent, media, filename, gen1, fbImgGen, fbPdfGen, deleted, acct1, acct7
    [1, 14, ACCT, null, null, null, null, null, null, null, null, 0, null, null],
    [10, 12, "NOTE", null, null, null, null, null, null, null, null, 0, null, 1],
    [11, 12, "NOTE-EMPTY", null, null, null, null, null, null, null, null, 0, null, 1],
    [12, 12, "NOTE-BAD", null, null, null, null, null, null, null, null, 0, null, 1],
    [20, 11, MEDIA, null, null, null, null, "photo.jpg", "1_GEN", null, null, 0, null, null],
    [21, 11, MEDIA_CHILD, null, null, null, null, "photo.jpg", null, null, null, 0, null, null],
    [
      100,
      5,
      ID.scan,
      "com.apple.paper.doc.scan",
      10,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      1,
      null,
    ],
    [101, 5, ID.image, "public.jpeg", 10, null, 20, null, null, null, null, 0, 1, null],
    [102, 5, ID.undownloaded, "public.heic", 10, null, null, null, null, null, null, 0, 1, null],
    [103, 5, ID.url, "public.url", 10, null, null, null, null, null, null, 0, 1, null],
    [104, 5, ID.paper, "com.apple.paper", 10, null, null, null, null, "3_NEW", null, 0, 1, null],
    [
      105,
      5,
      ID.gallery,
      "com.apple.notes.gallery",
      10,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      1,
      null,
    ],
    [
      106,
      5,
      ID.child1,
      "com.apple.paper.doc.scan",
      10,
      105,
      null,
      null,
      null,
      null,
      null,
      0,
      1,
      null,
    ],
    [107, 5, ID.child2, "public.jpeg", 10, 105, 21, null, null, null, null, 0, 1, null],
    [108, 5, ID.deleted, "public.jpeg", 10, null, null, null, null, null, null, 1, 1, null],
    [109, 5, ID.orphan, "public.url", 10, null, null, null, null, null, null, 0, 1, null],
    [110, 5, ID.table, "com.apple.notes.table", 12, null, null, null, null, null, null, 0, 1, null],
  ];
  sqlite(
    dbPath,
    rows.map((r) => `INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (${r.map(q).join(",")});`).join("\n")
  );
  // Body order: undownloaded image first, then scan, image, url, paper, gallery (orphan not in body).
  const body = noteBody([ID.undownloaded, ID.scan, ID.image, ID.url, ID.paper, ID.gallery]);
  sqlite(
    dbPath,
    `INSERT INTO ZICNOTEDATA VALUES (1, 10, X'${body.toString("hex")}');` +
      `INSERT INTO ZICNOTEDATA VALUES (2, 12, X'00ff');`
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOTE = `x-coredata://${STORE}/ICNote/p10`;

function readAssets(noteId = NOTE): NoteAttachmentAssets {
  const { rows, bodyOrder } = readNoteAttachmentRows(noteId, dbPath);
  return assembleAttachmentAssets(rows, bodyOrder, container);
}

const byId = (assets: NoteAttachmentAssets, id: string) =>
  assets.attachments.find((a) => a.identifier === id)!;

// -----------------------------------------------------------------------------
// SQL against a real sqlite3
// -----------------------------------------------------------------------------

describe("readNoteAttachmentRows (real sqlite3, fixture store)", () => {
  it("reads rows, media, account identifier and body order; skips deleted rows", () => {
    const { rows, bodyOrder } = readNoteAttachmentRows(NOTE, dbPath);
    expect(rows.map((r) => r.pk)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 109]);
    const image = rows.find((r) => r.pk === 101)!;
    expect(image).toMatchObject({
      mediaIdentifier: MEDIA,
      mediaFilename: "photo.jpg",
      mediaGeneration: "1_GEN",
      accountIdentifier: ACCT,
    });
    expect(rows.find((r) => r.pk === 104)!.fallbackImageGeneration).toBe("3_NEW");
    expect(rows.find((r) => r.pk === 106)!.parentPk).toBe(105);
    expect(bodyOrder).toEqual([ID.undownloaded, ID.scan, ID.image, ID.url, ID.paper, ID.gallery]);
  });

  it("reports a note with no body data as undecodable order", () => {
    const r = readNoteAttachmentRows(`x-coredata://${STORE}/ICNote/p11`, dbPath);
    expect(r.rows).toEqual([]);
    expect(r.bodyOrder).toBeNull();
  });

  it("classifies a missing note, a bad id, a missing database, and a broken schema", () => {
    expect(() => readNoteAttachmentRows(`x-coredata://${STORE}/ICNote/p999`, dbPath)).toThrow(
      expect.objectContaining({ code: "not_found" })
    );
    expect(() => readNoteAttachmentRows("x-coredata://X/ICFolder/p1", dbPath)).toThrow(
      expect.objectContaining({ code: "invalid_id" })
    );
    expect(() => readNoteAttachmentRows(NOTE, join(root, "missing", "NoteStore.sqlite"))).toThrow(
      expect.objectContaining({ code: "no_fda" })
    );
    const empty = join(root, "empty.sqlite");
    sqlite(empty, "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER);");
    expect(() => readNoteAttachmentRows(NOTE, empty)).toThrow(
      expect.objectContaining({ code: "query_error" })
    );
    const noKeys = join(root, "nokeys.sqlite");
    sqlite(noKeys, "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, ZIDENTIFIER TEXT);");
    expect(() => readNoteAttachmentRows(NOTE, noKeys)).toThrow(
      expect.objectContaining({ code: "query_error" })
    );
  });

  it("degrades optional columns to NULL on an older schema", () => {
    const old = join(root, "old.sqlite");
    sqlite(
      old,
      [
        "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
        "INSERT INTO Z_PRIMARYKEY VALUES (5,'ICAttachment'),(12,'ICNote');",
        "CREATE TABLE ZICNOTEDATA (ZNOTE INTEGER, ZDATA BLOB);",
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTYPEUTI TEXT, ZNOTE INTEGER);",
        "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 12, 'N', NULL, NULL), (2, 5, 'ATT', 'public.png', 1);",
      ].join("\n")
    );
    const { rows } = readNoteAttachmentRows(`x-coredata://${STORE}/ICNote/p1`, old);
    expect(rows).toEqual([
      expect.objectContaining({
        pk: 2,
        identifier: "ATT",
        parentPk: null,
        mediaIdentifier: null,
        accountIdentifier: null,
      }),
    ]);
  });

  it("builds SQL only from fixed identifiers and an integer key", () => {
    expect(() => buildAttachmentRowsSql(1.5, new Set())).toThrow(/primary key/);
    expect(() => buildAttachmentRowsSql(-1, new Set())).toThrow(/primary key/);
    const sql = buildAttachmentRowsSql(7, new Set(["ZNOTE", "ZGENERATION", "ZGENERATION1"]));
    expect(sql).toContain("COALESCE(m.ZGENERATION1, m.ZGENERATION)");
    expect(sql).toContain("LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON 0");
    expect(buildAttachmentRowsSql(7, new Set())).toContain("n.Z_PK = NULL");
  });
});

describe("row parsing and body order", () => {
  it("drops malformed rows and rejects a non-array", () => {
    expect(() => parseAttachmentRows("{}")).toThrow(/Invalid/);
    expect(parseAttachmentRows("")).toEqual([]);
    expect(
      parseAttachmentRows(JSON.stringify([null, { pk: "x" }, { pk: 3, identifier: "" }, 5]))
    ).toEqual([]);
  });

  it("returns null for undecodable bodies and de-duplicates identifiers", () => {
    expect(attachmentOrderFromNoteData(undefined)).toBeNull();
    expect(attachmentOrderFromNoteData("zz")).toBeNull();
    expect(attachmentOrderFromNoteData("00ff")).toBeNull();
    expect(attachmentOrderFromNoteData(gzipSync(Buffer.from([8, 1])).toString("hex"))).toBeNull();
    const dup = noteBody(["a", "A", "b"]).toString("hex");
    expect(attachmentOrderFromNoteData(dup)).toEqual(["a", "b"]);
  });

  it("parses note ids and forms AppleScript attachment ids", () => {
    expect(parseNoteId(NOTE)).toEqual({ store: STORE, pk: 10 });
    expect(() => parseNoteId("nope")).toThrow(AttachmentStoreError);
    expect(attachmentCoreDataId(NOTE, 101)).toBe(`x-coredata://${STORE}/ICAttachment/p101`);
  });
});

// -----------------------------------------------------------------------------
// Filesystem discovery
// -----------------------------------------------------------------------------

describe("asset and preview discovery (synthetic container)", () => {
  it("finds media assets, fallback renderings, and the largest preview file", () => {
    const assets = readAssets();
    const image = byId(assets, ID.image);
    expect(image.assetPaths).toEqual([join(accountDir, "Media", MEDIA, "1_GEN", "photo.jpg")]);
    // Largest area wins; inside the bundle the newest generation's Preview.png is the file.
    expect(image.previewPath).toBe(
      join(accountDir, "Previews", `${ID.image}-2-1024x768-0`, "2_NEW", "Preview.png")
    );
    expect(image.paths).toEqual([...image.assetPaths, image.previewPath]);

    const paper = byId(assets, ID.paper);
    expect(paper.kind).toBe("drawing");
    expect(paper.assetPaths[0]).toBe(
      join(accountDir, "FallbackImages", ID.paper, "3_NEW", "FallbackImage.png")
    );
    expect(paper.assetPaths).toHaveLength(2);

    const scan = byId(assets, ID.scan);
    expect(scan.assetPaths).toEqual([
      join(accountDir, "FallbackPDFs", ID.scan, "2_GEN", "FallbackPDF.pdf"),
    ]);
    expect(scan.previewPath).toBe(
      join(accountDir, "Previews", `${ID.scan}-1-10x10-0`, "Preview.png")
    );

    const undownloaded = byId(assets, ID.undownloaded);
    expect(undownloaded.assetPaths).toEqual([]);
    expect(basename(undownloaded.previewPath!)).toBe("OrientedPreview.png");
  });

  it("never returns a path that escapes the account directory through a symlink", () => {
    const assets = readAssets();
    const url = byId(assets, ID.url);
    expect(url.previewPath).toBe(join(accountDir, "Previews", `${ID.url}-1-300x200-0.png`));
    expect(byId(assets, ID.orphan).previewPath).toBeNull();
    for (const a of assets.attachments)
      for (const p of a.paths) expect(p.startsWith(accountDir)).toBe(true);
  });

  it("orders top-level attachments by body, then creation, with children after containers", () => {
    const assets = readAssets();
    expect(assets.orderSource).toBe("body");
    expect(assets.attachments.map((a) => a.identifier)).toEqual([
      ID.undownloaded,
      ID.scan,
      ID.image,
      ID.url,
      ID.paper,
      ID.gallery,
      ID.child1,
      ID.child2,
      ID.orphan,
    ]);
    expect(byId(assets, ID.orphan).bodyIndex).toBeNull();
    expect(byId(assets, ID.child1).parentIdentifier).toBe(ID.gallery);
    // A child with no account of its own inherits the container's.
    expect(byId(assets, ID.child2).assetPaths).toHaveLength(1);
  });

  it("returns no paths when the account directory cannot be resolved", () => {
    const assets = assembleAttachmentAssets(
      readNoteAttachmentRows(NOTE, dbPath).rows,
      null,
      join(root, "no-container")
    );
    expect(assets.orderSource).toBe("creation");
    expect(assets.attachments.every((a) => a.paths.length === 0)).toBe(true);
  });

  it("resolves the account directory by identifier or a single-account fallback", () => {
    expect(resolveAccountDir(container, ACCT)).toBe(accountDir);
    expect(resolveAccountDir(container, "UNKNOWN")).toBe(accountDir);
    expect(resolveAccountDir(container, "../x")).toBe(accountDir);
    const multi = join(root, "multi");
    mkdirSync(join(multi, "Accounts", "A"), { recursive: true });
    mkdirSync(join(multi, "Accounts", "B"), { recursive: true });
    expect(resolveAccountDir(multi, null)).toBeNull();
    expect(resolveAccountDir(multi, "A")).toBe(join(multi, "Accounts", "A"));
    expect(resolveAccountDir(join(root, "none"), ACCT)).toBeNull();
  });

  it("lists previews once and filters by identifier prefix and image suffix", () => {
    const entries = listPreviewEntries(accountDir);
    expect(entries.length).toBeGreaterThan(5);
    expect(listPreviewEntries(join(root, "nowhere"))).toEqual([]);
    expect(previewPaths(accountDir, "../escape", entries)).toEqual([]);
    expect(previewPaths(accountDir, ID.image, entries)).toHaveLength(2);
    expect(
      previewPaths(accountDir, ID.image, [`${ID.image}-1-1x1-0.gone`, `${ID.image}-1-1x1-0.5`])
    ).toEqual([]);
  });

  it("finds a flat legacy fallback image and a stored own filename under Media", () => {
    file(join(accountDir, "FallbackImages", "LEGACY.jpg"), "legacy");
    file(join(accountDir, "Media", "OWN", "own.png"), "own");
    const row: AttachmentRow = {
      pk: 1,
      identifier: "LEGACY",
      uti: "com.apple.drawing",
      parentPk: null,
      filename: null,
      mediaIdentifier: null,
      mediaFilename: null,
      mediaGeneration: null,
      fallbackImageGeneration: null,
      fallbackPdfGeneration: null,
      accountIdentifier: null,
    };
    expect(assetPathsFor(accountDir, row)).toEqual([
      join(accountDir, "FallbackImages", "LEGACY.jpg"),
    ]);
    expect(assetPathsFor(accountDir, { ...row, identifier: "OWN", filename: "own.png" })).toEqual([
      join(accountDir, "Media", "OWN", "own.png"),
    ]);
    expect(assetPathsFor(accountDir, { ...row, identifier: ".." })).toEqual([]);
  });

  it("flags fallback renderings from an older generation than the one recorded", () => {
    const row: AttachmentRow = {
      pk: 1,
      identifier: ID.paper,
      uti: "com.apple.paper",
      parentPk: null,
      filename: null,
      mediaIdentifier: null,
      mediaFilename: null,
      mediaGeneration: null,
      fallbackImageGeneration: "3_NEW",
      fallbackPdfGeneration: null,
      accountIdentifier: null,
    };
    let stale = false;
    assetPathsFor(accountDir, row, () => (stale = true));
    expect(stale).toBe(false);
    const paths = assetPathsFor(
      accountDir,
      { ...row, fallbackImageGeneration: "9_GONE" },
      () => (stale = true)
    );
    expect(stale).toBe(true);
    expect(paths[0]).toContain("3_NEW");
    // Without a recorded generation there is nothing to be stale against.
    stale = false;
    assetPathsFor(accountDir, { ...row, fallbackImageGeneration: null }, () => (stale = true));
    expect(stale).toBe(false);
  });

  it("carries the stale flag into the record and the export result", () => {
    const [record] = assembleAttachmentAssets(
      [
        {
          pk: 1,
          identifier: ID.paper,
          uti: "com.apple.paper",
          parentPk: null,
          filename: null,
          mediaIdentifier: null,
          mediaFilename: null,
          mediaGeneration: null,
          fallbackImageGeneration: "9_GONE",
          fallbackPdfGeneration: null,
          accountIdentifier: ACCT,
        },
      ],
      null,
      container
    ).attachments;
    expect(record.fallbackStale).toBe(true);
    const dir = join(exportRoot, "stale");
    const result = exportOneAttachment(
      record,
      prepareExportDir(dir, container),
      exportSource(record)
    );
    expect(result).toMatchObject({ exportedKind: "fallback", stale: true });
  });
});

describe("small helpers", () => {
  it("classifies UTIs into kinds", () => {
    const cases: Array<[string | null, string]> = [
      [null, "other"],
      ["com.apple.notes.table", "table"],
      ["public.url", "url"],
      ["com.apple.paper.doc.scan", "scan"],
      ["com.apple.notes.gallery", "scan"],
      ["com.apple.paper", "drawing"],
      ["com.apple.drawing.2", "drawing"],
      ["com.adobe.pdf", "pdf"],
      ["com.apple.m4a-audio", "audio"],
      ["public.mpeg-4", "video"],
      ["com.apple.quicktime-movie", "video"],
      ["public.jpeg", "image"],
      ["com.adobe.raw-image", "image"],
      ["public.plain-text", "other"],
    ];
    for (const [uti, kind] of cases) expect(classifyAttachmentKind(uti)).toBe(kind);
  });

  it("parses preview sizes and generation ranks", () => {
    expect(previewPixelArea("X-2-1024x768-0")).toBe(1024 * 768);
    expect(previewPixelArea("X-1-10x10-0-2-30x30-1.png")).toBe(900);
    expect(previewPixelArea("X-no-size")).toBe(0);
    expect(generationRank("12_abc")).toBe(12);
    expect(generationRank("abc")).toBe(0);
  });

  it("rejects traversal components", () => {
    expect(safeComponent("ok.png")).toBe("ok.png");
    for (const bad of [null, undefined, "", ".", "..", "a/b", "a\0b", "x".repeat(256)])
      expect(safeComponent(bad)).toBeNull();
  });

  it("names exports and collision variants", () => {
    const rec = { identifier: "ID1", filename: "photo.jpg" };
    expect(exportFileName(rec, "/x/photo.jpg", "asset")).toBe("photo.jpg");
    expect(exportFileName(rec, "/x/Preview.png", "preview")).toBe("photo-preview.png");
    expect(exportFileName({ identifier: "ID1", filename: null }, "/x/Preview.png", "preview")).toBe(
      "ID1-preview.png"
    );
    expect(
      exportFileName({ identifier: "ID1", filename: null }, "/x/FallbackImage.png", "asset")
    ).toBe("ID1.png");
    expect(exportFileName({ identifier: "ID1", filename: null }, "/x/scan.pdf", "asset")).toBe(
      "scan.pdf"
    );
    expect(
      exportFileName(
        { identifier: "ID1", filename: "FallbackPDF.pdf" },
        "/x/FallbackPDF.pdf",
        "asset"
      )
    ).toBe("ID1.pdf");
    // A stored identifier that could traverse never becomes part of the name.
    for (const identifier of ["../../escape", "..", "a/b", ""]) {
      expect(exportFileName({ identifier, filename: null }, "/x/FallbackImage.png", "asset")).toBe(
        "attachment.png"
      );
      expect(exportFileName({ identifier, filename: null }, "/x/Preview.png", "preview")).toBe(
        "attachment-preview.png"
      );
    }
    expect(collisionName("a.png", 1)).toBe("a.png");
    expect(collisionName("a.png", 2)).toBe("a-2.png");
    expect(collisionName("README", 3)).toBe("README-3");
    expect(collisionName(".hidden", 2)).toBe(".hidden-2");
  });

  it("detects paths inside the Notes container, even when not yet created", () => {
    expect(isInsideNotesContainer(join(container, "new", "dir"), container)).toBe(true);
    expect(isInsideNotesContainer(container, container)).toBe(true);
    expect(isInsideNotesContainer(join(root, "elsewhere"), container)).toBe(false);
    expect(isInsideNotesContainer(join(root, "group.com.apple.notes-evil"), container)).toBe(false);
    expect(isInsideNotesContainer("/tmp/x")).toBe(false);
    // A symlink outside that points into the container is still inside.
    symlinkSync(container, join(root, "sneaky"));
    expect(isInsideNotesContainer(join(root, "sneaky", "x"), container)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// First image
// -----------------------------------------------------------------------------

function rec(
  identifier: string,
  kind: AttachmentAssetRecord["kind"],
  extra: Partial<AttachmentAssetRecord> = {}
): AttachmentAssetRecord {
  return {
    pk: extra.pk ?? 1,
    identifier,
    uti: null,
    kind,
    parentIdentifier: null,
    filename: null,
    bodyIndex: 0,
    assetPaths: [],
    previewPath: null,
    paths: [],
    ...extra,
  };
}

describe("selectFirstImage", () => {
  it("takes the first image in body order even when its asset has not downloaded", () => {
    const first = selectFirstImage(readAssets())!;
    expect(first.identifier).toBe(ID.undownloaded);
    expect(first.path).toBeNull();
    expect(basename(first.previewPath!)).toBe("OrientedPreview.png");
    expect(first.orderSource).toBe("body");
    expect(first.galleryIndex).toBeNull();
  });

  it("falls back to the first scan or drawing when there is no image", () => {
    const assets: NoteAttachmentAssets = {
      orderSource: "body",
      attachments: [
        rec("u", "url"),
        rec("d", "drawing", { bodyIndex: 1, assetPaths: ["/d.png"] }),
        rec("s", "scan", { bodyIndex: 2 }),
      ],
    };
    expect(selectFirstImage(assets)).toMatchObject({ identifier: "d", path: "/d.png" });
    expect(selectFirstImage({ orderSource: "body", attachments: [rec("u", "url")] })).toBeNull();
  });

  it("considers gallery children at the gallery's position and reports their index", () => {
    const assets: NoteAttachmentAssets = {
      orderSource: "body",
      attachments: [
        rec("s", "scan"),
        rec("g", "scan", { bodyIndex: 1 }),
        rec("c1", "scan", { parentIdentifier: "g", bodyIndex: null }),
        rec("c2", "image", { parentIdentifier: "g", bodyIndex: null }),
        rec("late", "image", { bodyIndex: 2 }),
        rec("stray", "image", { parentIdentifier: "missing", bodyIndex: null }),
      ],
    };
    expect(selectFirstImage(assets)).toMatchObject({
      identifier: "c2",
      parentIdentifier: "g",
      galleryIndex: 1,
    });
  });

  it("ignores attachments missing from the body when body order is known", () => {
    const assets: NoteAttachmentAssets = {
      orderSource: "body",
      attachments: [rec("in", "scan"), rec("out", "image", { bodyIndex: null })],
    };
    expect(selectFirstImage(assets)!.identifier).toBe("in");
    expect(selectFirstImage({ ...assets, orderSource: "creation" })!.identifier).toBe("out");
  });
});

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

describe("export", () => {
  it("copies assets, previews only when no asset exists, and never replaces files", () => {
    const dir = join(exportRoot, "all");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "photo.jpg"), "PRE-EXISTING");
    const r = exportAttachmentAssets(readAssets(), dir, { containerDir: container });
    expect(r.exportDir).toBe(dir);
    const kinds = Object.fromEntries(r.results.map((x) => [x.identifier, x.exportedKind]));
    expect(kinds).toEqual({
      [ID.undownloaded]: "preview",
      // Notes' own renderings, not the attachment's file (#202).
      [ID.scan]: "fallback",
      [ID.image]: "asset",
      [ID.url]: "preview",
      [ID.paper]: "fallback",
      // The gallery has no file of its own, so its children export in its place.
      [ID.child1]: null,
      [ID.child2]: "asset",
      [ID.orphan]: null,
    });
    // A rendering keeps its own format's extension.
    const exported = (id: string) => r.results.find((x) => x.identifier === id)!;
    expect(basename(exported(ID.scan).exportedTo!)).toBe(`${ID.scan}.pdf`);
    expect(basename(exported(ID.paper).exportedTo!)).toBe(`${ID.paper}.png`);
    // Only the attachment the body no longer shows is flagged.
    expect(r.results.filter((x) => x.inBody === false).map((x) => x.identifier)).toEqual([
      ID.orphan,
    ]);
    // The pre-existing file is untouched and the exports took -2 and -3.
    expect(readFileSync(join(dir, "photo.jpg"), "utf8")).toBe("PRE-EXISTING");
    const image = r.results.find((x) => x.identifier === ID.image)!;
    expect(basename(image.exportedTo!)).toBe("photo-2.jpg");
    expect(readFileSync(image.exportedTo!, "utf8")).toBe("JPEGDATA");
    const child = r.results.find((x) => x.identifier === ID.child2)!;
    expect(basename(child.exportedTo!)).toBe("photo-3.jpg");
    expect(readFileSync(child.exportedTo!, "utf8")).toBe("CHILDDATA");
    // A second export of the same note continues the sequence; nothing is replaced.
    const again = exportAttachmentAssets(readAssets(), dir, { containerDir: container });
    expect(basename(again.results.find((x) => x.identifier === ID.image)!.exportedTo!)).toBe(
      "photo-4.jpg"
    );
    expect(readFileSync(join(dir, "photo-2.jpg"), "utf8")).toBe("JPEGDATA");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("names a rendering from the stored name's stem with the rendering's extension (#202)", () => {
    expect(
      exportFileName({ identifier: "X", filename: "Scan.jpeg" }, "/a/FallbackPDF.pdf", "fallback")
    ).toBe("Scan.pdf");
    expect(
      exportFileName({ identifier: "X", filename: null }, "/a/FallbackImage.png", "fallback")
    ).toBe("X.png");
    expect(
      exportSource({ assetPaths: ["/acct/FallbackPDFs/X/1/FallbackPDF.pdf"], previewPath: null })
    ).toEqual({ path: "/acct/FallbackPDFs/X/1/FallbackPDF.pdf", kind: "fallback" });
    expect(exportSource({ assetPaths: ["/acct/Media/M/photo.jpg"], previewPath: null })!.kind).toBe(
      "asset"
    );
  });

  it("does not export the children of a container marked for deletion (#202)", () => {
    sqlite(
      dbPath,
      [
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZMARKEDFORDELETION, ZACCOUNT7) VALUES (13, 12, 'NOTE-DEAD', 0, 1);",
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZMARKEDFORDELETION, ZACCOUNT1) VALUES (130, 5, 'DEAD-GALLERY', 'com.apple.notes.gallery', 13, 1, 1);",
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZPARENTATTACHMENT, ZMEDIA, ZMARKEDFORDELETION, ZACCOUNT1) VALUES (131, 5, 'DEAD-CHILD', 'public.jpeg', 13, 130, 21, 0, 1);",
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTYPEUTI, ZNOTE, ZMEDIA, ZMARKEDFORDELETION, ZACCOUNT1) VALUES (132, 5, 'LIVE-IMAGE', 'public.jpeg', 13, 20, 0, 1);",
      ].join("\n")
    );
    const note = `x-coredata://${STORE}/ICNote/p13`;
    const { rows } = readNoteAttachmentRows(note, dbPath);
    expect(rows.find((row) => row.pk === 131)).toMatchObject({ parentDeleted: true });
    const assets = readAssets(note);
    expect(assets.attachments.map((a) => a.identifier)).toEqual(["LIVE-IMAGE"]);
    const dir = join(exportRoot, "dead-parent");
    const r = exportAttachmentAssets(assets, dir, { containerDir: container });
    expect(r.results.map((x) => x.identifier)).toEqual(["LIVE-IMAGE"]);
  });

  it("exports a container's children only when the container has no file of its own", () => {
    const assets: NoteAttachmentAssets = {
      orderSource: "body",
      attachments: [
        rec("g", "scan", { pk: 1 }),
        rec("c", "image", {
          pk: 2,
          parentIdentifier: "g",
          assetPaths: [join(accountDir, "Media", MEDIA_CHILD, "photo.jpg")],
        }),
        rec("audio", "audio", {
          pk: 3,
          bodyIndex: 1,
          assetPaths: [join(accountDir, "Media", MEDIA, "1_GEN", "photo.jpg")],
        }),
        rec("audiochild", "audio", {
          pk: 4,
          parentIdentifier: "audio",
          assetPaths: [join(accountDir, "Media", MEDIA, "1_GEN", "photo.jpg")],
        }),
      ],
    };
    const r = exportAttachmentAssets(assets, join(exportRoot, "containers"), {
      containerDir: container,
    });
    expect(r.results.map((x) => [x.identifier, x.exportedKind])).toEqual([
      ["c", "asset"],
      ["audio", "asset"],
    ]);
  });

  it("exports only the lead visual with firstImageOnly", () => {
    const dir = join(exportRoot, "first");
    const r = exportAttachmentAssets(readAssets(), dir, {
      firstImageOnly: true,
      containerDir: container,
    });
    expect(r.firstImage!.identifier).toBe(ID.undownloaded);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].exportedKind).toBe("preview");
    expect(basename(r.results[0].exportedTo!)).toBe(`${ID.undownloaded}-preview.png`);
    const none = exportAttachmentAssets({ orderSource: "body", attachments: [] }, dir, {
      firstImageOnly: true,
      containerDir: container,
    });
    expect(none).toMatchObject({ results: [], firstImage: null });
  });

  it("refuses the Notes container, paths outside the allowlist, and relative paths", () => {
    expect(() => prepareExportDir(join(container, "out"), container)).toThrow(/Notes data/);
    expect(existsSync(join(container, "out"))).toBe(false);
    expect(() => prepareExportDir("/etc/notes-export", container)).toThrow(/outside allowed/);
    expect(() => prepareExportDir("relative/dir", container)).toThrow(/absolute/);
  });

  it("refuses a directory that resolves into the container only after creation", () => {
    // A symlink outside the container that points into it is caught by the canonical check.
    const link = join(root, "into-container");
    symlinkSync(accountDir, link);
    expect(() => prepareExportDir(join(link, "x"), container)).toThrow(/Notes data/);
  });

  it("reports a per-attachment error when the source disappears", () => {
    const r = exportOneAttachment(rec("gone", "image"), join(exportRoot, "all"), {
      path: join(root, "missing.jpg"),
      kind: "asset",
    });
    expect(r.exportedTo).toBeNull();
    expect(r.error).toMatch(/ENOENT/);
    expect(exportOneAttachment(rec("n", "image"), join(exportRoot, "all"), null)).toMatchObject({
      exportedKind: null,
      exportedTo: null,
    });
  });

  it("keeps a traversing stored identifier inside the export directory", () => {
    const sourceDir = join(root, "generic-source");
    mkdirSync(sourceDir, { recursive: true });
    const source = join(sourceDir, "FallbackImage.png");
    writeFileSync(source, "png");
    const dir = join(exportRoot, "traversal");
    mkdirSync(dir, { recursive: true });
    const r = exportOneAttachment(rec("../../escape", "image", { filename: null }), dir, {
      path: source,
      kind: "asset",
    });
    expect(r.exportedTo).toBe(join(dir, "attachment.png"));
    expect(existsSync(join(exportRoot, "..", "escape.png"))).toBe(false);
  });

  it("chooses the asset over the preview", () => {
    expect(exportSource({ assetPaths: ["/a"], previewPath: "/p" })).toEqual({
      path: "/a",
      kind: "asset",
    });
    expect(exportSource({ assetPaths: [], previewPath: "/p" })).toEqual({
      path: "/p",
      kind: "preview",
    });
    expect(exportSource({ assetPaths: [], previewPath: null })).toBeNull();
  });
});

describe("copyFileExclusive", () => {
  it("copies bytes, refuses to overwrite, and refuses symlinked or non-file sources", () => {
    const dir = join(exportRoot, "copy");
    mkdirSync(dir, { recursive: true });
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    file(join(dir, "src.bin"), big);
    copyFileExclusive(join(dir, "src.bin"), join(dir, "dst.bin"));
    expect(readFileSync(join(dir, "dst.bin")).equals(big)).toBe(true);
    expect(() => copyFileExclusive(join(dir, "src.bin"), join(dir, "dst.bin"))).toThrow(
      expect.objectContaining({ code: "EEXIST" })
    );
    symlinkSync(join(outside, "secret.png"), join(dir, "link.png"));
    expect(() => copyFileExclusive(join(dir, "link.png"), join(dir, "out.png"))).toThrow(
      expect.objectContaining({ code: "ELOOP" })
    );
    expect(existsSync(join(dir, "out.png"))).toBe(false);
    expect(() => copyFileExclusive(dir, join(dir, "dir-copy"))).toThrow(/regular file/);
  });

  it("removes a partial destination when writing fails", () => {
    const dir = join(exportRoot, "partial");
    mkdirSync(dir, { recursive: true });
    // /dev/zero opened without O_NOFOLLOW issues is a character device: refused before writing.
    expect(() => copyFileExclusive("/dev/zero", join(dir, "z"))).toThrow(/regular file/);
    expect(existsSync(join(dir, "z"))).toBe(false);
  });
});
