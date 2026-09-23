/**
 * Paper and classic drawing attachments: report them and export Notes' own
 * rendered raster [BETA].
 *
 * Notes stores a modern Paper drawing (`com.apple.paper`) as a CRDT bundle
 * under `Accounts/<account>/Paper/Bundles/<identifier>.bundle`. No public API
 * reads that bundle (PaperKit's public initializer accepts only its own
 * container format), so this module does not decode strokes. Notes also keeps
 * a finished raster of every drawing, which is what this module exposes:
 *
 * - `FallbackImages/<identifier>/<generation>/FallbackImage.png` (the
 *   generation is recorded in `ZFALLBACKIMAGEGENERATION`), or the flat
 *   `FallbackImages/<identifier>.{png,jpg}` shape older drawings use;
 * - failing that, the largest rendered thumbnail in `Previews/`, named
 *   `<identifier>-<scale>-<W>x<H>-<appearance>` and stored either as a flat
 *   image or as a directory holding `<n>_<uuid>/Preview.png`.
 *
 * Classic drawings (`com.apple.drawing`, `com.apple.drawing.2`) are reported
 * the same way. When Notes has computed handwriting recognition text for the
 * drawing it is stored in `ZHANDWRITINGSUMMARY` and returned as-is.
 *
 * Everything is read-only: NoteStore through `sqlite3 -readonly`, the group
 * container through canonicalized paths that must stay inside the account
 * directory. The export opens the source with O_NOFOLLOW, validates its image
 * header on the open descriptor, creates the destination with O_EXCL, and
 * re-validates what it wrote.
 *
 * @module utils/paperAttachments
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { assertSafeSavePath } from "./attachmentFs.js";
import {
  AttachmentStoreError,
  NOTES_CONTAINER_DIR,
  attachmentCoreDataId,
  generationRank,
  isInsideNotesContainer,
  parseNoteId,
  previewPixelArea,
  realInside,
  resolveAccountDir,
  safeComponent,
} from "./attachmentAssets.js";

/** Largest raster dimension accepted from a header (guards against corrupt or hostile files). */
const MAX_AXIS = 32_768;
const MAX_PREVIEW_DIR_ENTRIES = 100_000;
const MAX_DIR_ENTRIES = 64;
const HEADER_BYTES = 64 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg"]);

/** Validated raster header information. */
export interface ImageInfo {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

/** One stored drawing row. */
export interface DrawingRow {
  pk: number;
  identifier: string;
  uti: string;
  handwritingSummary: string | null;
  fallbackImageGeneration: string | null;
  accountIdentifier: string | null;
}

/** A drawing with its rendered raster, if Notes has one on disk. */
export interface DrawingAttachment {
  pk: number;
  identifier: string;
  uti: string;
  /** "paper" for com.apple.paper, "drawing" for classic com.apple.drawing*. */
  kind: "paper" | "drawing";
  /** Notes' handwriting recognition text, when it stored any. */
  handwritingSummary: string | null;
  /** Whether the Paper CRDT bundle directory exists (Paper only; false for classic drawings). */
  bundlePresent: boolean;
  /** Notes' full rendered raster (FallbackImage), newest generation first. */
  fallbackImagePath: string | null;
  /** The largest rendered thumbnail, always an image file. */
  previewPath: string | null;
  /** The raster an export would copy: the fallback image, else the preview; null when neither validates. */
  raster: ({ path: string; source: "fallback" | "preview" } & ImageInfo) | null;
}

// -----------------------------------------------------------------------------
// Image header validation
// -----------------------------------------------------------------------------

const axisOk = (n: number) => Number.isInteger(n) && n > 0 && n <= MAX_AXIS;

/**
 * Parse and validate a PNG or JPEG header. PNG: the 8-byte signature and an
 * IHDR first chunk with nonzero dimensions. JPEG: SOI, then the first
 * start-of-frame segment's dimensions. Returns null for anything else.
 */
export function parseImageHeader(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    if (buf.readUInt32BE(8) !== 13 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return axisOk(width) && axisOk(height) ? { format: "png", width, height } : null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      if (length < 2) return null;
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (offset + 9 > buf.length) return null;
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return axisOk(width) && axisOk(height) ? { format: "jpeg", width, height } : null;
      }
      offset += 2 + length;
    }
  }
  return null;
}

/** Validate the image header of an open descriptor (must be a regular file). */
export function readImageInfoFd(fd: number): ImageInfo | null {
  if (!fstatSync(fd).isFile()) return null;
  const buf = Buffer.alloc(HEADER_BYTES);
  const read = readSync(fd, buf, 0, buf.length, 0);
  return parseImageHeader(buf.subarray(0, read));
}

/** Read and validate an image header through a descriptor opened without following symlinks. */
export function readImageInfo(path: string): ImageInfo | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    return readImageInfoFd(fd);
  } finally {
    closeSync(fd);
  }
}

// -----------------------------------------------------------------------------
// SQL
// -----------------------------------------------------------------------------

/**
 * One read-only transaction for a note's drawings. Output lines: (1) 1 when
 * the note exists, else 0; (2) a JSON array of drawing rows. Only the note's
 * integer key is not a fixed identifier; optional columns degrade to NULL.
 */
export function buildDrawingRowsSql(notePk: number, columns: Set<string>): string {
  if (!Number.isSafeInteger(notePk) || notePk < 0) throw new Error("Invalid note primary key");
  const col = (name: string) => (columns.has(name) ? `a.${name}` : "NULL");
  const accountCols = [...columns].filter((c) => /^ZACCOUNT\d*$/.test(c)).sort();
  const account = accountCols.length
    ? `(SELECT acc.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT acc WHERE acc.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICAccount') AND acc.Z_PK IN (${[
        ...accountCols.map((c) => `a.${c}`),
        ...accountCols.map((c) => `n.${c}`),
      ].join(", ")}) LIMIT 1)`
    : "NULL";
  const deleted = columns.has("ZMARKEDFORDELETION")
    ? " AND COALESCE(a.ZMARKEDFORDELETION, 0) = 0"
    : "";
  const fields = [
    `'pk', a.Z_PK`,
    `'identifier', a.ZIDENTIFIER`,
    `'uti', a.ZTYPEUTI`,
    `'handwritingSummary', ${col("ZHANDWRITINGSUMMARY")}`,
    `'fallbackImageGeneration', ${col("ZFALLBACKIMAGEGENERATION")}`,
    `'accountIdentifier', ${account}`,
  ].join(", ");
  return [
    "BEGIN;",
    `SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ${notePk} AND Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote');`,
    `SELECT json_group_array(json_object(${fields})) FROM ZICCLOUDSYNCINGOBJECT a LEFT JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = a.ZNOTE WHERE a.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICAttachment') AND a.ZNOTE = ${notePk} AND (a.ZTYPEUTI = 'com.apple.paper' OR a.ZTYPEUTI = 'com.apple.drawing' OR a.ZTYPEUTI LIKE 'com.apple.drawing.%')${deleted};`,
    "COMMIT;",
  ].join(" ");
}

function runSqlite(dbPath: string, sql: string): string {
  try {
    return execFileSync("/usr/bin/sqlite3", ["-readonly", dbPath, sql], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message)) {
      throw new AttachmentStoreError(
        "Full Disk Access is required to read drawing attachments. Grant it to the app that launches this server, then relaunch it (run the doctor tool to verify).",
        "no_fda"
      );
    }
    throw new AttachmentStoreError(`Failed to read drawing attachments: ${message}`, "query_error");
  }
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** Validate the JSON rows sqlite3 returned; malformed rows are dropped. */
export function parseDrawingRows(json: string): DrawingRow[] {
  const raw: unknown = JSON.parse(json || "[]");
  if (!Array.isArray(raw)) throw new Error("Invalid drawing rows");
  const rows: DrawingRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const identifier = str(r.identifier);
    const uti = str(r.uti);
    if (!Number.isSafeInteger(r.pk) || !identifier || !uti) continue;
    const summary = str(r.handwritingSummary);
    rows.push({
      pk: r.pk as number,
      identifier,
      uti,
      handwritingSummary: summary && summary.trim() ? summary : null,
      fallbackImageGeneration: str(r.fallbackImageGeneration),
      accountIdentifier: str(r.accountIdentifier),
    });
  }
  return rows.sort((a, b) => a.pk - b.pk);
}

/** Read one note's drawing rows. */
export function readDrawingRows(
  noteId: string,
  dbPath: string = join(NOTES_CONTAINER_DIR, "NoteStore.sqlite")
): DrawingRow[] {
  const { pk } = parseNoteId(noteId);
  const columns = new Set(
    runSqlite(
      dbPath,
      "SELECT group_concat(name, ',') FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');"
    )
      .trim()
      .split(",")
      .filter(Boolean)
  );
  if (!columns.has("ZIDENTIFIER") || !columns.has("ZTYPEUTI") || !columns.has("ZNOTE")) {
    throw new AttachmentStoreError("Unsupported Notes database schema", "query_error");
  }
  const lines = runSqlite(dbPath, buildDrawingRowsSql(pk, columns)).split("\n");
  if (lines[0]?.trim() !== "1") {
    throw new AttachmentStoreError(
      `No note found in the database for ID "${noteId}".`,
      "not_found"
    );
  }
  try {
    return parseDrawingRows(lines[1] ?? "[]");
  } catch {
    throw new AttachmentStoreError("Drawing rows could not be parsed", "query_error");
  }
}

// -----------------------------------------------------------------------------
// Filesystem (read-only)
// -----------------------------------------------------------------------------

function kindOf(path: string): "file" | "dir" | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

function entries(dir: string, limit: number): string[] {
  try {
    const list = readdirSync(dir);
    return list.length > limit ? [] : list.sort();
  } catch {
    return [];
  }
}

const byGenerationDesc = (a: string, b: string) =>
  generationRank(basename(b)) - generationRank(basename(a));

/**
 * Notes' full rendered raster for a drawing: the recorded generation first,
 * then other generations newest first, then the flat legacy shapes.
 */
export function findFallbackImage(
  accountDir: string,
  identifier: string,
  generation: string | null
): string | null {
  const id = safeComponent(identifier);
  if (!id) return null;
  const base = join(accountDir, "FallbackImages", id);
  const names = ["FallbackImage.png", "FallbackImage.jpg"];
  const candidates: string[] = [];
  const gen = safeComponent(generation);
  if (gen) for (const n of names) candidates.push(join(base, gen, n));
  const gens = entries(base, MAX_DIR_ENTRIES)
    .map((e) => join(base, e))
    .sort(byGenerationDesc);
  for (const g of gens) for (const n of names) candidates.push(join(g, n));
  for (const n of names) candidates.push(join(base, n));
  candidates.push(join(accountDir, "FallbackImages", `${id}.png`));
  candidates.push(join(accountDir, "FallbackImages", `${id}.jpg`));
  for (const c of candidates) {
    const real = realInside(c, accountDir);
    if (real && kindOf(real) === "file") return real;
  }
  return null;
}

/** The largest rendered preview image file for `identifier`, or null. */
export function findLargestPreview(accountDir: string, identifier: string): string | null {
  const id = safeComponent(identifier);
  if (!id) return null;
  const dir = join(accountDir, "Previews");
  const prefix = `${id}-`.toLowerCase();
  const names = entries(dir, MAX_PREVIEW_DIR_ENTRIES)
    .filter((n) => n.toLowerCase().startsWith(prefix))
    .filter((n) => {
      const ext = extname(n).toLowerCase();
      return !ext || IMAGE_SUFFIXES.has(ext) || /^\.\d+$/.test(ext);
    })
    .sort((a, b) => previewPixelArea(b) - previewPixelArea(a) || a.localeCompare(b));
  for (const name of names) {
    const real = realInside(join(dir, name), accountDir);
    if (!real) continue;
    const kind = kindOf(real);
    if (kind === "file") return real;
    if (kind !== "dir") continue;
    const gens = entries(real, MAX_DIR_ENTRIES)
      .map((e) => realInside(join(real, e), accountDir))
      .filter((p): p is string => p !== null && kindOf(p) === "dir")
      .sort(byGenerationDesc);
    for (const g of [...gens, real]) {
      const file = realInside(join(g, "Preview.png"), accountDir);
      if (file && kindOf(file) === "file") return file;
    }
  }
  return null;
}

/** Combine rows with their on-disk rasters. */
export function describeDrawings(
  rows: DrawingRow[],
  containerDir: string = NOTES_CONTAINER_DIR
): DrawingAttachment[] {
  return rows.map((row) => {
    const accountDir = resolveAccountDir(containerDir, row.accountIdentifier);
    const kind: DrawingAttachment["kind"] = row.uti === "com.apple.paper" ? "paper" : "drawing";
    const id = safeComponent(row.identifier);
    const fallbackImagePath = accountDir
      ? findFallbackImage(accountDir, row.identifier, row.fallbackImageGeneration)
      : null;
    const previewPath = accountDir ? findLargestPreview(accountDir, row.identifier) : null;
    const bundle =
      accountDir && id && kind === "paper"
        ? realInside(join(accountDir, "Paper", "Bundles", `${id}.bundle`), accountDir)
        : null;
    let raster: DrawingAttachment["raster"] = null;
    for (const [path, source] of [
      [fallbackImagePath, "fallback"],
      [previewPath, "preview"],
    ] as const) {
      const info = path ? readImageInfo(path) : null;
      if (path && info) {
        raster = { path, source, ...info };
        break;
      }
    }
    return {
      pk: row.pk,
      identifier: row.identifier,
      uti: row.uti,
      kind,
      handwritingSummary: row.handwritingSummary,
      bundlePresent: bundle !== null && kindOf(bundle) === "dir",
      fallbackImagePath,
      previewPath,
      raster,
    };
  });
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

/**
 * Re-read a written image through its still-open descriptor and confirm it
 * matches the source header (magic, format, dimensions). A mismatch removes
 * `path` (the file the descriptor was created at) and throws. Reading the
 * descriptor, not the path, means a file swapped in after the write cannot
 * pass the check in place of the one written.
 */
export function verifyWrittenImage(fd: number, path: string, expected: ImageInfo): ImageInfo {
  const check = readImageInfoFd(fd);
  if (
    !check ||
    check.format !== expected.format ||
    check.width !== expected.width ||
    check.height !== expected.height
  ) {
    unlinkSync(path);
    throw new Error("The exported image failed validation and was removed.");
  }
  return check;
}

/** Pick the drawing to export: the one named, or the only one in the note. */
export function selectDrawing(
  drawings: DrawingAttachment[],
  noteId: string,
  attachmentId?: string
): DrawingAttachment {
  if (attachmentId) {
    const wanted = attachmentId.toLowerCase();
    const found = drawings.find(
      (d) =>
        d.identifier.toLowerCase() === wanted ||
        attachmentCoreDataId(noteId, d.pk).toLowerCase() === wanted
    );
    if (!found) throw new Error(`No Paper or drawing attachment "${attachmentId}" in this note.`);
    return found;
  }
  if (drawings.length === 0) throw new Error("This note has no Paper or drawing attachment.");
  if (drawings.length > 1) {
    throw new Error(
      `This note has ${drawings.length} Paper or drawing attachments; pass attachmentId (from list-paper-attachments) to choose one.`
    );
  }
  return drawings[0];
}

/**
 * Copy the drawing's raster to `savePath` (a new file). The destination must
 * pass the save-attachment allowlist, may not be inside the Notes container,
 * must not exist yet, and must carry the raster's extension (.png, or .jpg /
 * .jpeg). The written file is re-validated; a mismatch removes it.
 */
export function exportDrawingRaster(
  drawing: DrawingAttachment,
  savePath: string,
  containerDir = NOTES_CONTAINER_DIR
): ImageInfo & { savedPath: string; bytes: number; source: "fallback" | "preview" } {
  if (!drawing.raster) {
    throw new Error(
      "Notes has no rendered image for this drawing on disk yet (open the note in Notes.app to let it render, then retry)."
    );
  }
  const abs = assertSafeSavePath(savePath);
  if (isInsideNotesContainer(abs, containerDir)) {
    throw new Error(`Refusing to write inside the Notes data container: "${abs}"`);
  }
  const ext = extname(abs).toLowerCase();
  const expected = drawing.raster.format === "png" ? [".png"] : [".jpg", ".jpeg"];
  if (!expected.includes(ext)) {
    throw new Error(
      `The rendered image is ${drawing.raster.format.toUpperCase()}; savePath must end in ${expected.join(" or ")}.`
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  assertSafeSavePath(abs);
  if (isInsideNotesContainer(abs, containerDir)) {
    throw new Error(`Refusing to write inside the Notes data container: "${abs}"`);
  }

  const input = openSync(drawing.raster.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes = 0;
  try {
    if (!fstatSync(input).isFile()) throw new Error("The rendered image is not a regular file");
    const header = Buffer.alloc(HEADER_BYTES);
    const headerLength = readSync(input, header, 0, header.length, 0);
    const info = parseImageHeader(header.subarray(0, headerLength));
    if (!info || info.format !== drawing.raster.format) {
      throw new Error(
        "The rendered image changed or is not a valid PNG/JPEG; nothing was written."
      );
    }
    let output: number;
    try {
      // Owner-only, like export-attachments: a drawing is private note
      // content and savePath may sit under the temp dir.
      output = openSync(
        abs,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`"${abs}" already exists; choose a new savePath.`);
      }
      throw error;
    }
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, position);
        if (read === 0) break;
        position += read;
        let written = 0;
        while (written < read) written += writeSync(output, buffer, written, read - written);
      }
      bytes = position;
      const check = verifyWrittenImage(output, abs, info);
      return { savedPath: abs, bytes, source: drawing.raster.source, ...check };
    } catch (error) {
      try {
        unlinkSync(abs);
      } catch {
        // already removed by verifyWrittenImage
      }
      throw error;
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
}
