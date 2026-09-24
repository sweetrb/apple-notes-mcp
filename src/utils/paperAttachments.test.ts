/**
 * Tests for Paper / classic drawing discovery and raster export.
 *
 * The SQL runs through the real sqlite3 CLI against a throwaway NoteStore-shaped
 * fixture; the files live in a synthetic group-container tree in a temp
 * directory. The live Notes store is never touched and all data is synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildDrawingRowsSql,
  describeDrawings,
  exportDrawingRaster,
  findFallbackImage,
  findLargestPreview,
  locateFallbackImage,
  parseDrawingRows,
  parseImageHeader,
  readDrawingRows,
  readImageInfo,
  selectDrawing,
  verifyWrittenImage,
  type DrawingAttachment,
} from "./paperAttachments.js";
import {
  AttachmentStoreError,
  attachmentCoreDataId,
  generationRank,
  isInsideNotesContainer,
  parseNoteId,
  previewPixelArea,
  resolveAccountDir,
  safeComponent,
} from "./attachmentAssets.js";

// -----------------------------------------------------------------------------
// Synthetic images
// -----------------------------------------------------------------------------

/** A minimal PNG: signature + IHDR (+ a fake trailing chunk; only the header is validated). */
function png(width: number, height: number, extra = 32): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.alloc(extra, 1),
  ]);
}

/** A minimal JPEG: SOI, an APP0 segment, then SOF0 with the dimensions. */
function jpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = sofMarker;
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff]), sof]);
}

// -----------------------------------------------------------------------------
// Fixture store
// -----------------------------------------------------------------------------

const ACCT = "ACC00000-0000-0000-0000-000000000001";
const STORE = "5A0E0000-0000-0000-0000-000000000000";
const PAPER = "B0000000-0000-0000-0000-000000000001";
const PAPER_PREVIEW_ONLY = "B0000000-0000-0000-0000-000000000002";
const CLASSIC = "B0000000-0000-0000-0000-000000000003";
const NOTHING = "B0000000-0000-0000-0000-000000000004";

let root: string;
let container: string;
let accountDir: string;
let dbPath: string;
let outside: string;

const sqlite = (db: string, sql: string) =>
  execFileSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8" });

function file(path: string, data: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
}

const note = (pk: number) => `x-coredata://${STORE}/ICNote/p${pk}`;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "paper-")));
  container = join(root, "group.com.apple.notes");
  accountDir = join(container, "Accounts", ACCT);
  outside = join(root, "outside");
  dbPath = join(container, "NoteStore.sqlite");
  mkdirSync(accountDir, { recursive: true });
  file(join(outside, "secret.png"), png(9, 9));

  // Paper with a recorded generation, an older generation, a bundle, and previews.
  file(join(accountDir, "FallbackImages", PAPER, "3_NEW", "FallbackImage.png"), png(1536, 1734));
  file(join(accountDir, "FallbackImages", PAPER, "1_OLD", "FallbackImage.png"), png(10, 10));
  mkdirSync(join(accountDir, "Paper", "Bundles", `${PAPER}.bundle`, "Database"), {
    recursive: true,
  });
  file(join(accountDir, "Previews", `${PAPER}-1-192x216-0.png`), png(192, 216));
  // Paper with only previews: a flat small one and a bundle-directory large one.
  file(join(accountDir, "Previews", `${PAPER_PREVIEW_ONLY}-1-100x100-0.png`), png(100, 100));
  file(
    join(accountDir, "Previews", `${PAPER_PREVIEW_ONLY}-2-600x400-0`, "2_G", "Preview.png"),
    png(600, 400)
  );
  file(join(accountDir, "Previews", `${PAPER_PREVIEW_ONLY}-3-9000x9000-0.json`), "{}");
  // Classic drawing: legacy flat JPEG fallback.
  file(join(accountDir, "FallbackImages", `${CLASSIC}.jpg`), jpeg(320, 240));
  // A drawing whose only candidates are a planted symlink and a corrupt file.
  symlinkSync(join(outside, "secret.png"), join(accountDir, "Previews", `${NOTHING}-1-5x5-0.png`));
  file(join(accountDir, "FallbackImages", NOTHING, "FallbackImage.png"), "not an image");

  sqlite(
    dbPath,
    [
      "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);",
      "INSERT INTO Z_PRIMARYKEY VALUES (5,'ICAttachment'),(12,'ICNote'),(14,'ICAccount');",
      `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT,
        ZTYPEUTI TEXT, ZNOTE INTEGER, ZHANDWRITINGSUMMARY TEXT, ZFALLBACKIMAGEGENERATION TEXT,
        ZMARKEDFORDELETION INTEGER, ZACCOUNT1 INTEGER, ZACCOUNT7 INTEGER);`,
      `INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES
        (1, 14, '${ACCT}', NULL, NULL, NULL, NULL, 0, NULL, NULL),
        (10, 12, 'N1', NULL, NULL, NULL, NULL, 0, NULL, 1),
        (11, 12, 'N2', NULL, NULL, NULL, NULL, 0, NULL, 1),
        (12, 12, 'N3', NULL, NULL, NULL, NULL, 0, NULL, 1),
        (100, 5, '${PAPER}', 'com.apple.paper', 10, 'shopping list', '3_NEW', 0, 1, NULL),
        (101, 5, '${PAPER_PREVIEW_ONLY}', 'com.apple.paper', 10, '', NULL, 0, 1, NULL),
        (102, 5, '${CLASSIC}', 'com.apple.drawing.2', 10, NULL, NULL, 0, 1, NULL),
        (103, 5, '${NOTHING}', 'com.apple.drawing', 10, '   ', NULL, 0, 1, NULL),
        (104, 5, 'SCAN', 'com.apple.paper.doc.scan', 10, 'scan text', NULL, 0, 1, NULL),
        (105, 5, 'PHOTO', 'public.jpeg', 10, NULL, NULL, 0, 1, NULL),
        (106, 5, 'GONE', 'com.apple.paper', 10, NULL, NULL, 1, 1, NULL),
        (107, 5, '${PAPER}', 'com.apple.paper', 11, NULL, '3_NEW', 0, 1, NULL);`,
    ].join("\n")
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const drawings = (pk = 10) => describeDrawings(readDrawingRows(note(pk), dbPath), container);

describe("image header validation", () => {
  it("accepts PNG and JPEG headers and reads their dimensions", () => {
    expect(parseImageHeader(png(3, 4))).toEqual({ format: "png", width: 3, height: 4 });
    expect(parseImageHeader(jpeg(320, 240))).toEqual({ format: "jpeg", width: 320, height: 240 });
    expect(parseImageHeader(jpeg(5, 6, 0xc2))).toEqual({ format: "jpeg", width: 5, height: 6 });
  });

  it("rejects wrong magic, bad IHDR, zero or huge sizes, and truncated JPEGs", () => {
    expect(parseImageHeader(Buffer.from("not an image at all, really"))).toBeNull();
    const badChunk = png(3, 4);
    badChunk.write("IDAT", 12, "latin1");
    expect(parseImageHeader(badChunk)).toBeNull();
    expect(parseImageHeader(png(0, 4))).toBeNull();
    expect(parseImageHeader(png(40_000, 4))).toBeNull();
    expect(parseImageHeader(jpeg(0, 4))).toBeNull();
    expect(parseImageHeader(jpeg(3, 4).subarray(0, 12))).toBeNull();
    // A DHT (0xC4) segment is not a frame; with nothing after it there is no size.
    expect(parseImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x02]))).toBeNull();
    expect(parseImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0]))).toBeNull();
    expect(parseImageHeader(Buffer.from([0xff, 0xd8, 0x00, 0xe0, 0x00, 0x04, 0, 0]))).toBeNull();
    expect(
      parseImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12, 0]))
    ).toBeNull();
  });

  it("reads headers without following symlinks and rejects non-files", () => {
    const f = join(root, "h.png");
    file(f, png(7, 8));
    expect(readImageInfo(f)).toEqual({ format: "png", width: 7, height: 8 });
    symlinkSync(f, join(root, "h-link.png"));
    expect(readImageInfo(join(root, "h-link.png"))).toBeNull();
    expect(readImageInfo(root)).toBeNull();
    expect(readImageInfo(join(root, "missing.png"))).toBeNull();
  });
});

describe("readDrawingRows (real sqlite3)", () => {
  it("returns only live Paper and drawing rows of the note, with account and summary", () => {
    const rows = readDrawingRows(note(10), dbPath);
    expect(rows.map((r) => r.pk)).toEqual([100, 101, 102, 103]);
    expect(rows[0]).toMatchObject({
      uti: "com.apple.paper",
      handwritingSummary: "shopping list",
      fallbackImageGeneration: "3_NEW",
      accountIdentifier: ACCT,
    });
    // Empty and whitespace-only summaries are reported as absent.
    expect(rows[1].handwritingSummary).toBeNull();
    expect(rows[3].handwritingSummary).toBeNull();
    expect(readDrawingRows(note(12), dbPath)).toEqual([]);
  });

  it("classifies a missing note, a bad id, a missing database, and an unusable schema", () => {
    expect(() => readDrawingRows(note(999), dbPath)).toThrow(
      expect.objectContaining({ code: "not_found" })
    );
    expect(() => readDrawingRows("x-coredata://X/ICFolder/p1", dbPath)).toThrow(
      AttachmentStoreError
    );
    expect(() => readDrawingRows(note(10), join(root, "none", "db.sqlite"))).toThrow(
      expect.objectContaining({ code: "no_fda" })
    );
    const bad = join(root, "bad.sqlite");
    sqlite(bad, "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER);");
    expect(() => readDrawingRows(note(10), bad)).toThrow(
      expect.objectContaining({ code: "query_error" })
    );
    const noKeys = join(root, "nokeys.sqlite");
    sqlite(
      noKeys,
      "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, ZIDENTIFIER TEXT, ZTYPEUTI TEXT, ZNOTE INTEGER);"
    );
    expect(() => readDrawingRows(note(10), noKeys)).toThrow(
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
        "CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, Z_ENT INTEGER, ZIDENTIFIER TEXT, ZTYPEUTI TEXT, ZNOTE INTEGER);",
        "INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 12, 'N', NULL, NULL), (2, 5, 'D', 'com.apple.drawing', 1);",
      ].join("\n")
    );
    expect(readDrawingRows(note(1), old)).toEqual([
      {
        pk: 2,
        identifier: "D",
        uti: "com.apple.drawing",
        handwritingSummary: null,
        fallbackImageGeneration: null,
        accountIdentifier: null,
      },
    ]);
  });

  it("builds SQL from fixed identifiers and an integer key only", () => {
    expect(() => buildDrawingRowsSql(-1, new Set())).toThrow(/primary key/);
    expect(() => buildDrawingRowsSql(2.5, new Set())).toThrow(/primary key/);
    expect(buildDrawingRowsSql(3, new Set(["ZNOTE"]))).toContain("'accountIdentifier', NULL");
  });

  it("drops malformed rows", () => {
    expect(() => parseDrawingRows("{}")).toThrow(/Invalid/);
    expect(parseDrawingRows("")).toEqual([]);
    expect(parseDrawingRows(JSON.stringify([null, 3, { pk: 1, identifier: "x" }]))).toEqual([]);
  });

  it("parses note ids and builds attachment ids", () => {
    expect(parseNoteId(note(10))).toEqual({ store: STORE, pk: 10 });
    expect(attachmentCoreDataId(note(10), 100)).toBe(`x-coredata://${STORE}/ICAttachment/p100`);
  });
});

describe("raster discovery (synthetic container)", () => {
  it("prefers the recorded fallback generation, reports bundles, previews and kinds", () => {
    const [paper, previewOnly, classic, nothing] = drawings();
    expect(paper).toMatchObject({
      kind: "paper",
      bundlePresent: true,
      handwritingSummary: "shopping list",
      fallbackImagePath: join(accountDir, "FallbackImages", PAPER, "3_NEW", "FallbackImage.png"),
      previewPath: join(accountDir, "Previews", `${PAPER}-1-192x216-0.png`),
      raster: { source: "fallback", format: "png", width: 1536, height: 1734 },
    });
    expect(previewOnly).toMatchObject({
      bundlePresent: false,
      fallbackImagePath: null,
      raster: { source: "preview", format: "png", width: 600, height: 400 },
    });
    expect(basename(previewOnly.previewPath!)).toBe("Preview.png");
    expect(classic).toMatchObject({
      kind: "drawing",
      bundlePresent: false,
      raster: { source: "fallback", format: "jpeg", width: 320, height: 240 },
    });
    // The symlinked preview is ignored and the corrupt fallback does not validate.
    expect(nothing.previewPath).toBeNull();
    expect(nothing.fallbackImagePath).not.toBeNull();
    expect(nothing.raster).toBeNull();
  });

  it("finds other generations when none is recorded, and nothing for unsafe ids", () => {
    expect(findFallbackImage(accountDir, PAPER, null)).toBe(
      join(accountDir, "FallbackImages", PAPER, "3_NEW", "FallbackImage.png")
    );
    expect(findFallbackImage(accountDir, PAPER, "9_MISSING")).toBe(
      join(accountDir, "FallbackImages", PAPER, "3_NEW", "FallbackImage.png")
    );
    // The recorded generation is missing: the older file is used, but flagged (#203).
    expect(locateFallbackImage(accountDir, PAPER, "9_MISSING")).toEqual({
      path: join(accountDir, "FallbackImages", PAPER, "3_NEW", "FallbackImage.png"),
      stale: true,
    });
    expect(locateFallbackImage(accountDir, PAPER, "3_NEW").stale).toBe(false);
    expect(locateFallbackImage(accountDir, PAPER, null).stale).toBe(false);
    expect(findFallbackImage(accountDir, "..", null)).toBeNull();
    expect(findFallbackImage(accountDir, "UNKNOWN", null)).toBeNull();
    expect(findLargestPreview(accountDir, "a/b")).toBeNull();
    expect(findLargestPreview(accountDir, "UNKNOWN")).toBeNull();
  });

  it("uses a bundle's direct Preview.png and skips unusable bundles", () => {
    file(join(accountDir, "Previews", "DIRECT-1-50x50-0", "Preview.png"), png(50, 50));
    mkdirSync(join(accountDir, "Previews", "DIRECT-2-900x900-0", "1_EMPTY"), { recursive: true });
    expect(findLargestPreview(accountDir, "DIRECT")).toBe(
      join(accountDir, "Previews", "DIRECT-1-50x50-0", "Preview.png")
    );
  });

  it("returns no rasters when the account cannot be resolved", () => {
    const d = describeDrawings(readDrawingRows(note(10), dbPath), join(root, "no-container"));
    expect(d.every((x) => x.raster === null && x.previewPath === null)).toBe(true);
  });

  it("resolves the account directory by identifier or single-account fallback", () => {
    expect(resolveAccountDir(container, ACCT)).toBe(accountDir);
    expect(resolveAccountDir(container, null)).toBe(accountDir);
    const multi = join(root, "multi");
    mkdirSync(join(multi, "Accounts", "A"), { recursive: true });
    mkdirSync(join(multi, "Accounts", "B"), { recursive: true });
    expect(resolveAccountDir(multi, "C")).toBeNull();
  });

  it("small helpers", () => {
    expect(previewPixelArea("X-2-600x400-0")).toBe(240_000);
    expect(previewPixelArea("X")).toBe(0);
    expect(generationRank("7_x")).toBe(7);
    expect(generationRank("x")).toBe(0);
    expect(safeComponent("a")).toBe("a");
    for (const bad of [null, "", ".", "..", "a/b", "a\0", "y".repeat(300)])
      expect(safeComponent(bad)).toBeNull();
    expect(isInsideNotesContainer(join(container, "a", "b"), container)).toBe(true);
    expect(isInsideNotesContainer(join(root, "group.com.apple.notes2"), container)).toBe(false);
    expect(isInsideNotesContainer("/tmp/elsewhere")).toBe(false);
  });
});

describe("selectDrawing", () => {
  const ds = () => drawings();
  it("requires attachmentId when there are several, and finds by identifier or id", () => {
    expect(() => selectDrawing(ds(), note(10))).toThrow(/pass attachmentId/);
    expect(selectDrawing(ds(), note(10), CLASSIC.toLowerCase()).pk).toBe(102);
    expect(
      selectDrawing(ds(), note(10), `x-coredata://${STORE}/ICAttachment/p101`).identifier
    ).toBe(PAPER_PREVIEW_ONLY);
    expect(() => selectDrawing(ds(), note(10), "nope")).toThrow(/No Paper/);
    expect(() => selectDrawing([], note(12))).toThrow(/no Paper/);
    expect(selectDrawing(drawings(11), note(11)).pk).toBe(107);
  });
});

describe("exportDrawingRaster", () => {
  const out = () => join(root, "out");

  it("copies the fallback PNG, validates it, and never overwrites", () => {
    const paper = drawings()[0];
    const dest = join(out(), "nested", "paper.png");
    const r = exportDrawingRaster(paper, dest, container);
    expect(r).toMatchObject({
      savedPath: dest,
      format: "png",
      width: 1536,
      height: 1734,
      source: "fallback",
    });
    expect(readFileSync(dest).equals(readFileSync(paper.raster!.path))).toBe(true);
    expect(r.bytes).toBe(readFileSync(dest).length);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(() => exportDrawingRaster(paper, dest, container)).toThrow(/already exists/);
  });

  it("exports a JPEG fallback only to a JPEG extension", () => {
    const classic = drawings()[2];
    expect(() => exportDrawingRaster(classic, join(out(), "c.png"), container)).toThrow(
      /must end in \.jpg or \.jpeg/
    );
    expect(exportDrawingRaster(classic, join(out(), "c.jpeg"), container).format).toBe("jpeg");
    const paper = drawings()[0];
    expect(() => exportDrawingRaster(paper, join(out(), "p.jpg"), container)).toThrow(
      /must end in \.png/
    );
  });

  it("refuses drawings with no raster, the Notes container, and paths outside the allowlist", () => {
    const [paper, , , nothing] = drawings();
    expect(() => exportDrawingRaster(nothing, join(out(), "n.png"), container)).toThrow(
      /no rendered image/
    );
    expect(() => exportDrawingRaster(paper, join(container, "x.png"), container)).toThrow(
      /Notes data/
    );
    expect(existsSync(join(container, "x.png"))).toBe(false);
    expect(() => exportDrawingRaster(paper, "/etc/paper.png", container)).toThrow(
      /outside allowed/
    );
    symlinkSync(accountDir, join(root, "to-container"));
    expect(() =>
      exportDrawingRaster(paper, join(root, "to-container", "sub", "x.png"), container)
    ).toThrow(/Notes data/);
  });

  it("refuses a source that changed format, is not a file, or is a symlink", () => {
    const paper = drawings()[0];
    const swapped = join(root, "swapped.png");
    file(swapped, jpeg(4, 4));
    const changed: DrawingAttachment = {
      ...paper,
      raster: { ...paper.raster!, path: swapped },
    };
    expect(() => exportDrawingRaster(changed, join(out(), "changed.png"), container)).toThrow(
      /changed or is not a valid/
    );
    expect(existsSync(join(out(), "changed.png"))).toBe(false);
    const dir: DrawingAttachment = { ...paper, raster: { ...paper.raster!, path: root } };
    expect(() => exportDrawingRaster(dir, join(out(), "dir.png"), container)).toThrow(
      /not a regular file/
    );
    symlinkSync(swapped, join(root, "link.png"));
    const link: DrawingAttachment = {
      ...paper,
      raster: { ...paper.raster!, path: join(root, "link.png") },
    };
    expect(() => exportDrawingRaster(link, join(out(), "link.png"), container)).toThrow(
      expect.objectContaining({ code: "ELOOP" })
    );
  });

  it("verifies a written image and removes one that does not match", () => {
    const verifyAt = (path: string, expected: { format: "png"; width: number; height: number }) => {
      const fd = openSync(path, "r");
      try {
        return verifyWrittenImage(fd, path, expected);
      } finally {
        closeSync(fd);
      }
    };
    const good = join(root, "verify-good.png");
    file(good, png(5, 6));
    expect(verifyAt(good, { format: "png", width: 5, height: 6 })).toEqual({
      format: "png",
      width: 5,
      height: 6,
    });
    const wrongSize = join(root, "verify-size.png");
    file(wrongSize, png(5, 7));
    expect(() => verifyAt(wrongSize, { format: "png", width: 5, height: 6 })).toThrow(
      /failed validation/
    );
    expect(existsSync(wrongSize)).toBe(false);
    const wrongFormat = join(root, "verify-format.png");
    file(wrongFormat, jpeg(5, 6));
    expect(() => verifyAt(wrongFormat, { format: "png", width: 5, height: 6 })).toThrow(
      /failed validation/
    );
    const wrongWidth = join(root, "verify-width.png");
    file(wrongWidth, png(4, 6));
    expect(() => verifyAt(wrongWidth, { format: "png", width: 5, height: 6 })).toThrow();
    const garbage = join(root, "verify-garbage.png");
    file(garbage, "garbage");
    expect(() => verifyAt(garbage, { format: "png", width: 5, height: 6 })).toThrow();
    expect(existsSync(garbage)).toBe(false);
  });
});
