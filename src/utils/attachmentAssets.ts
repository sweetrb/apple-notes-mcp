/**
 * Attachment asset and preview discovery, first-image selection, and batch
 * export for one note [BETA].
 *
 * AppleScript can name a note's attachments but not where their files live,
 * which of them comes first in the body, or which rendered thumbnail Notes
 * keeps for each. This module answers those questions from two read-only
 * sources:
 *
 * - NoteStore.sqlite (opened with `sqlite3 -readonly`): the attachment rows,
 *   their media rows, account identifier, and the note body protobuf, whose
 *   attribute runs give the attachments' body order.
 * - The Notes group container's account directory, which holds the files:
 *   `Media/<media-id>/<generation>/<filename>` for real assets,
 *   `FallbackImages/<id>/<generation>/FallbackImage.png` and
 *   `FallbackPDFs/<id>/<generation>/FallbackPDF.pdf` for Notes' own renderings,
 *   and `Previews/<id>-<scale>-<W>x<H>-<appearance>` for thumbnails. A preview
 *   entry is either a flat image file or a directory holding
 *   `<n>_<uuid>/Preview.png`.
 *
 * Nothing here writes to the group container. Every discovered path is
 * canonicalized and must stay inside the account directory, so a symlink
 * planted in the store cannot lead a read (or a later copy) elsewhere. Export
 * copies open the source with O_NOFOLLOW and create each destination with
 * O_EXCL, so an existing file is never replaced.
 *
 * @module utils/attachmentAssets
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
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { assertSafeSavePath } from "./attachmentFs.js";
import { decodeMessage, embeddedMessage, getField, getFields, stringValue } from "./protobuf.js";

/** The Notes group container (read-only for this module). */
export const NOTES_CONTAINER_DIR = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes"
);

/** Coarse attachment kind derived from the stored UTI. */
export type AttachmentKind =
  "image" | "scan" | "drawing" | "pdf" | "audio" | "video" | "url" | "table" | "other";

/** One attachment row as read from NoteStore.sqlite. */
export interface AttachmentRow {
  pk: number;
  identifier: string;
  uti: string | null;
  parentPk: number | null;
  filename: string | null;
  mediaIdentifier: string | null;
  mediaFilename: string | null;
  mediaGeneration: string | null;
  fallbackImageGeneration: string | null;
  fallbackPdfGeneration: string | null;
  accountIdentifier: string | null;
}

/** An attachment with its discovered files. */
export interface AttachmentAssetRecord {
  pk: number;
  identifier: string;
  uti: string | null;
  kind: AttachmentKind;
  /** Identifier of the container attachment (gallery, audio) for a child row. */
  parentIdentifier: string | null;
  /** Stored filename, when Notes recorded one. */
  filename: string | null;
  /** Zero-based position among the body's attachments; null when not in the body. */
  bodyIndex: number | null;
  /** The attachment's own files (media asset, fallback image or PDF), best first. */
  assetPaths: string[];
  /** The largest rendered preview image, or null. Always a file, never a directory. */
  previewPath: string | null;
  /** assetPaths followed by previewPath: everything on disk for this attachment. */
  paths: string[];
}

/** Every attachment of one note with the order source used. */
export interface NoteAttachmentAssets {
  /** "body" when the note body gave the order, "creation" when it fell back to row order. */
  orderSource: "body" | "creation";
  /** Top-level attachments in order, each followed by its child rows (by creation order). */
  attachments: AttachmentAssetRecord[];
}

/** The note's lead visual. */
export interface FirstImage {
  pk: number;
  identifier: string;
  uti: string | null;
  kind: AttachmentKind;
  /** The asset file, or null when the asset has not downloaded. Never a preview. */
  path: string | null;
  previewPath: string | null;
  /** Container identifier when the lead visual is a gallery child. */
  parentIdentifier: string | null;
  /** Zero-based position inside the container, for a gallery child. */
  galleryIndex: number | null;
  orderSource: "body" | "creation";
}

/** Result of exporting one attachment. */
export interface AttachmentExportResult {
  pk: number;
  identifier: string;
  uti: string | null;
  kind: AttachmentKind;
  parentIdentifier: string | null;
  exportedTo: string | null;
  /** "asset" for the real file, "preview" only when no asset exists, null when nothing was copied. */
  exportedKind: "asset" | "preview" | null;
  error?: string;
}

/** Error with a classification the tool layer turns into guidance. */
export class AttachmentStoreError extends Error {
  constructor(
    message: string,
    readonly code: "no_fda" | "invalid_id" | "not_found" | "query_error"
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

/** Upper bounds that keep a malformed or hostile store from causing unbounded work. */
const MAX_PREVIEW_DIR_ENTRIES = 100_000;
const MAX_BUNDLE_ENTRIES = 64;
const MAX_GENERATION_DIRS = 64;
const MAX_COLLISION_SUFFIX = 10_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const PREVIEW_IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".heic", ".tiff", ".gif"]);
const GENERIC_FILE_NAMES = new Set([
  "fallbackimage.png",
  "fallbackimage.jpg",
  "fallbackpdf.pdf",
  "preview.png",
  "orientedpreview.png",
]);

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

const IMAGE_UTIS = new Set([
  "public.jpeg",
  "public.png",
  "public.heic",
  "public.heif",
  "public.tiff",
  "public.image",
  "com.compuserve.gif",
  "org.webmproject.webp",
  "com.microsoft.bmp",
  "com.adobe.raw-image",
]);

/** Map a stored UTI to a coarse kind. Order matters: a doc scan is not a drawing. */
export function classifyAttachmentKind(uti: string | null | undefined): AttachmentKind {
  if (!uti) return "other";
  const u = uti.toLowerCase();
  if (u === "com.apple.notes.table") return "table";
  if (u === "public.url" || u.startsWith("public.url")) return "url";
  if (u === "com.apple.paper.doc.scan" || u === "com.apple.notes.gallery" || u.includes("scan"))
    return "scan";
  if (u === "com.apple.paper" || u.startsWith("com.apple.drawing")) return "drawing";
  if (u === "com.adobe.pdf" || u.includes("pdf")) return "pdf";
  if (u.includes("audio")) return "audio";
  if (u === "public.mpeg-4" || u.includes("movie") || u.includes("video")) return "video";
  if (IMAGE_UTIS.has(u) || u.includes("image")) return "image";
  return "other";
}

// -----------------------------------------------------------------------------
// SQL
// -----------------------------------------------------------------------------

/** Parse a canonical note id into its store UUID and primary key. */
export function parseNoteId(noteId: string): { store: string; pk: number } {
  const m = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/ICNote\/p(\d+)$/.exec(noteId);
  if (!m) {
    throw new AttachmentStoreError(
      `Invalid note ID format: "${noteId}". Expected x-coredata://UUID/ICNote/pNNN`,
      "invalid_id"
    );
  }
  return { store: m[1], pk: Number(m[2]) };
}

/** The AppleScript-style attachment id for a row of the given note. */
export function attachmentCoreDataId(noteId: string, pk: number): string {
  return noteId.replace(/ICNote\/p\d+$/, `ICAttachment/p${pk}`);
}

/**
 * Build the one-transaction read for a note's attachments.
 *
 * Columns vary between macOS releases (the account link is `ZACCOUNT1` on one
 * release and another suffix on the next), so the caller passes the columns
 * that exist and every optional one degrades to NULL. The only value that is
 * not a fixed identifier is the note's primary key, which must be a
 * non-negative integer.
 *
 * Output lines: (1) 1 when the note row exists, else 0; (2) a JSON array of
 * attachment rows; (3) the note body as hex (absent for a note with no body).
 */
export function buildAttachmentRowsSql(notePk: number, columns: Set<string>): string {
  if (!Number.isSafeInteger(notePk) || notePk < 0) throw new Error("Invalid note primary key");
  const col = (alias: string, name: string) => (columns.has(name) ? `${alias}.${name}` : "NULL");
  const firstOf = (alias: string, names: string[]) => {
    const present = names.filter((n) => columns.has(n)).map((n) => `${alias}.${n}`);
    if (present.length === 0) return "NULL";
    return present.length === 1 ? present[0] : `COALESCE(${present.join(", ")})`;
  };
  const accountCols = [...columns].filter((c) => /^ZACCOUNT\d*$/.test(c)).sort();
  const accountRefs = [
    ...accountCols.map((c) => `a.${c}`),
    ...accountCols.map((c) => `n.${c}`),
  ].join(", ");
  const account = accountCols.length
    ? `(SELECT acc.ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT acc WHERE acc.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICAccount') AND acc.Z_PK IN (${accountRefs}) LIMIT 1)`
    : "NULL";
  const noteLink = columns.has("ZNOTE") ? "a.ZNOTE" : "NULL";
  const parent = col("a", "ZPARENTATTACHMENT");
  const deleted = columns.has("ZMARKEDFORDELETION")
    ? " AND COALESCE(a.ZMARKEDFORDELETION, 0) = 0"
    : "";
  const fields = [
    `'pk', a.Z_PK`,
    `'identifier', a.ZIDENTIFIER`,
    `'uti', ${col("a", "ZTYPEUTI")}`,
    `'parentPk', ${parent}`,
    `'filename', ${col("a", "ZFILENAME")}`,
    `'mediaIdentifier', m.ZIDENTIFIER`,
    `'mediaFilename', ${col("m", "ZFILENAME")}`,
    `'mediaGeneration', ${firstOf("m", ["ZGENERATION1", "ZGENERATION"])}`,
    `'fallbackImageGeneration', ${col("a", "ZFALLBACKIMAGEGENERATION")}`,
    `'fallbackPdfGeneration', ${col("a", "ZFALLBACKPDFGENERATION")}`,
    `'accountIdentifier', ${account}`,
  ].join(", ");
  const mediaJoin = columns.has("ZMEDIA")
    ? "LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = a.ZMEDIA"
    : "LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON 0";
  const childClause =
    parent === "NULL"
      ? ""
      : ` OR a.ZPARENTATTACHMENT IN (SELECT p.Z_PK FROM ZICCLOUDSYNCINGOBJECT p WHERE p.ZNOTE = ${notePk})`;
  return [
    "BEGIN;",
    `SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ${notePk} AND Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote');`,
    `SELECT json_group_array(json_object(${fields})) FROM ZICCLOUDSYNCINGOBJECT a ${mediaJoin} LEFT JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = ${noteLink} WHERE a.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICAttachment') AND (${noteLink} = ${notePk}${childClause})${deleted};`,
    `SELECT hex(ZDATA) FROM ZICNOTEDATA WHERE ZNOTE = ${notePk};`,
    "COMMIT;",
  ].join(" ");
}

/** Run one read-only query. The database is never opened for writing. */
function runSqlite(dbPath: string, sql: string): string {
  try {
    return execFileSync("/usr/bin/sqlite3", ["-readonly", dbPath, sql], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message)) {
      throw new AttachmentStoreError(
        "Full Disk Access is required to read attachment paths. Grant it to the Node binary running this server (or the terminal that launches it), then relaunch it (run the doctor tool to verify).",
        "no_fda"
      );
    }
    throw new AttachmentStoreError(`Failed to read attachment rows: ${message}`, "query_error");
  }
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Validate and normalize the JSON rows sqlite3 returned. */
export function parseAttachmentRows(json: string): AttachmentRow[] {
  const raw: unknown = JSON.parse(json || "[]");
  if (!Array.isArray(raw)) throw new Error("Invalid attachment rows");
  const rows: AttachmentRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const pk = toIntOrNull(r.pk);
    const identifier = toStringOrNull(r.identifier);
    if (pk === null || identifier === null) continue;
    rows.push({
      pk,
      identifier,
      uti: toStringOrNull(r.uti),
      parentPk: toIntOrNull(r.parentPk),
      filename: toStringOrNull(r.filename),
      mediaIdentifier: toStringOrNull(r.mediaIdentifier),
      mediaFilename: toStringOrNull(r.mediaFilename),
      mediaGeneration: toStringOrNull(r.mediaGeneration),
      fallbackImageGeneration: toStringOrNull(r.fallbackImageGeneration),
      fallbackPdfGeneration: toStringOrNull(r.fallbackPdfGeneration),
      accountIdentifier: toStringOrNull(r.accountIdentifier),
    });
  }
  return rows.sort((a, b) => a.pk - b.pk);
}

/**
 * The attachment identifiers in body order, from the gzipped note protobuf
 * (Document.2 -> Version.3 -> String.5 attribute runs -> field 12 attachment
 * info -> field 1 identifier). Returns null when the body cannot be decoded.
 */
export function attachmentOrderFromNoteData(hex: string | undefined): string[] | null {
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  try {
    const data = gunzipSync(Buffer.from(hex, "hex"), { maxOutputLength: MAX_BODY_BYTES });
    const wrapper = embeddedMessage(getField(decodeMessage(data), 2));
    const body = wrapper && embeddedMessage(getField(wrapper, 3));
    if (!body) return null;
    const ids: string[] = [];
    for (const run of getFields(body, 5)) {
      const fields = embeddedMessage(run);
      const info = fields && embeddedMessage(getField(fields, 12));
      const id = info && stringValue(getField(info, 1));
      if (id && !ids.some((seen) => seen.toLowerCase() === id.toLowerCase())) ids.push(id);
    }
    return ids;
  } catch {
    return null;
  }
}

/** Read one note's attachment rows and body order. */
export function readNoteAttachmentRows(
  noteId: string,
  dbPath: string = join(NOTES_CONTAINER_DIR, "NoteStore.sqlite")
): { rows: AttachmentRow[]; bodyOrder: string[] | null } {
  const { pk } = parseNoteId(noteId);
  const columnList = runSqlite(
    dbPath,
    "SELECT group_concat(name, ',') FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');"
  ).trim();
  const columns = new Set(columnList.split(",").filter(Boolean));
  if (!columns.has("ZIDENTIFIER")) {
    throw new AttachmentStoreError("Unsupported Notes database schema", "query_error");
  }
  const lines = runSqlite(dbPath, buildAttachmentRowsSql(pk, columns)).split("\n");
  if (lines[0]?.trim() !== "1") {
    throw new AttachmentStoreError(
      `No note found in the database for ID "${noteId}".`,
      "not_found"
    );
  }
  let rows: AttachmentRow[];
  try {
    rows = parseAttachmentRows(lines[1] ?? "[]");
  } catch {
    throw new AttachmentStoreError("Attachment rows could not be parsed", "query_error");
  }
  return { rows, bodyOrder: attachmentOrderFromNoteData(lines[2]?.trim()) };
}

// -----------------------------------------------------------------------------
// Filesystem discovery (read-only)
// -----------------------------------------------------------------------------

/** One literal path component from stored data, or null for anything that could traverse. */
export function safeComponent(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value || value.length > 255) return null;
  if (value === "." || value === ".." || value.includes("/") || value.includes("\0")) return null;
  return value;
}

/** Canonical path of an existing entry, or null when it is missing or escapes `rootReal`. */
export function realInside(path: string, rootReal: string): string | null {
  try {
    const real = realpathSync.native(path);
    return real === rootReal || real.startsWith(rootReal + sep) ? real : null;
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Directory entries, or null when unreadable or larger than `limit`. */
function boundedEntries(dir: string, limit: number): string[] | null {
  try {
    const entries = readdirSync(dir);
    return entries.length > limit ? null : entries.sort();
  } catch {
    return null;
  }
}

/** The account's asset directory (canonical), or null. */
export function resolveAccountDir(
  containerDir: string,
  accountIdentifier: string | null
): string | null {
  const accountsDir = join(containerDir, "Accounts");
  let accountsReal: string;
  try {
    accountsReal = realpathSync.native(accountsDir);
  } catch {
    return null;
  }
  const account = safeComponent(accountIdentifier);
  if (account) {
    const dir = realInside(join(accountsReal, account), accountsReal);
    if (dir && isDirectory(dir)) return dir;
  }
  // A single-account library: the only account directory is unambiguous.
  const entries = (boundedEntries(accountsReal, 64) ?? []).filter((e) =>
    isDirectory(join(accountsReal, e))
  );
  if (entries.length !== 1) return null;
  return realInside(join(accountsReal, entries[0]), accountsReal);
}

/** Numeric generation prefix (`3_<uuid>` -> 3); 0 when absent. */
export function generationRank(name: string): number {
  const m = /^(\d+)_/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** Newest-first generation subdirectories of `base`. */
function generationDirs(base: string, accountDir: string): string[] {
  const entries = boundedEntries(base, MAX_GENERATION_DIRS) ?? [];
  return entries
    .map((e) => realInside(join(base, e), accountDir))
    .filter((p): p is string => p !== null && isDirectory(p))
    .sort((a, b) => generationRank(basename(b)) - generationRank(basename(a)));
}

/**
 * Files inside a generation-structured fallback directory, newest first:
 * `<root>/<id>/<generation>/<name>` for the known generation, then every other
 * generation, then the flat `<root>/<id>/<name>` and `<root>/<id>.<ext>` shapes
 * older releases used.
 */
function fallbackFiles(
  accountDir: string,
  rootName: string,
  identifier: string,
  generation: string | null,
  names: string[]
): string[] {
  const base = join(accountDir, rootName, identifier);
  const found: string[] = [];
  const add = (candidate: string) => {
    const real = realInside(candidate, accountDir);
    if (real && isRegularFile(real) && !found.includes(real)) found.push(real);
  };
  const gen = safeComponent(generation);
  if (gen) for (const name of names) add(join(base, gen, name));
  if (isDirectory(base)) {
    for (const dir of generationDirs(base, accountDir))
      for (const name of names) add(join(dir, name));
    for (const name of names) add(join(base, name));
  }
  for (const name of names) add(join(accountDir, rootName, `${identifier}${extname(name)}`));
  return found;
}

/** Pixel area from the last `-<W>x<H>-` token in a preview name; 0 when absent. */
export function previewPixelArea(name: string): number {
  const matches = [...name.matchAll(/-(\d{1,6})x(\d{1,6})(?=-|\.|$)/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) * Number(last[2]) : 0;
}

/** The image inside a preview bundle directory: `<n>_<uuid>/Preview.png`, newest generation first. */
function previewFileInBundle(bundle: string, accountDir: string): string | null {
  const direct: string[] = [];
  const nested: string[] = [];
  for (const entry of boundedEntries(bundle, MAX_BUNDLE_ENTRIES) ?? []) {
    const child = realInside(join(bundle, entry), accountDir);
    if (!child) continue;
    if (isRegularFile(child)) direct.push(child);
    else if (isDirectory(child)) nested.push(child);
  }
  nested.sort((a, b) => generationRank(basename(b)) - generationRank(basename(a)));
  const pick = (files: string[]) =>
    files.find((f) => basename(f) === "Preview.png") ??
    files.find((f) => PREVIEW_IMAGE_SUFFIXES.has(extname(f).toLowerCase())) ??
    null;
  for (const dir of nested) {
    const files = (boundedEntries(dir, MAX_BUNDLE_ENTRIES) ?? [])
      .map((e) => realInside(join(dir, e), accountDir))
      .filter((p): p is string => p !== null && isRegularFile(p));
    const chosen = pick(files);
    if (chosen) return chosen;
  }
  return pick(direct);
}

/** List the account's Previews directory once (bounded). */
export function listPreviewEntries(accountDir: string): string[] {
  return boundedEntries(join(accountDir, "Previews"), MAX_PREVIEW_DIR_ENTRIES) ?? [];
}

/**
 * Rendered preview image files for one attachment, largest pixel area first.
 * Entries are named `<identifier>-<scale>-<W>x<H>-<appearance>`; a flat entry
 * may carry an image suffix, a directory entry holds `<n>_<uuid>/Preview.png`.
 */
export function previewPaths(accountDir: string, identifier: string, entries: string[]): string[] {
  const id = safeComponent(identifier);
  if (!id) return [];
  const prefix = `${id}-`.toLowerCase();
  const candidates = entries
    .filter((name) => name.toLowerCase().startsWith(prefix))
    .filter((name) => {
      const ext = extname(name).toLowerCase();
      return !ext || PREVIEW_IMAGE_SUFFIXES.has(ext) || /^\.\d+$/.test(ext);
    })
    .sort((a, b) => previewPixelArea(b) - previewPixelArea(a) || a.localeCompare(b));
  const files: string[] = [];
  for (const name of candidates) {
    const real = realInside(join(accountDir, "Previews", name), accountDir);
    if (!real) continue;
    const file = isRegularFile(real)
      ? real
      : isDirectory(real)
        ? previewFileInBundle(real, accountDir)
        : null;
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/** The attachment's own files, best first: media asset, then Notes' fallback renderings. */
export function assetPathsFor(accountDir: string, row: AttachmentRow): string[] {
  const found: string[] = [];
  const add = (candidate: string) => {
    const real = realInside(candidate, accountDir);
    if (real && isRegularFile(real) && !found.includes(real)) found.push(real);
  };
  const mediaId = safeComponent(row.mediaIdentifier);
  const mediaName = safeComponent(row.mediaFilename);
  const mediaGen = safeComponent(row.mediaGeneration);
  if (mediaId && mediaName) {
    if (mediaGen) add(join(accountDir, "Media", mediaId, mediaGen, mediaName));
    add(join(accountDir, "Media", mediaId, mediaName));
  }
  const id = safeComponent(row.identifier);
  if (!id) return found;
  const ownName = safeComponent(row.filename);
  if (ownName) add(join(accountDir, "Media", id, ownName));
  for (const file of fallbackFiles(accountDir, "FallbackImages", id, row.fallbackImageGeneration, [
    "FallbackImage.png",
    "FallbackImage.jpg",
  ]))
    add(file);
  for (const file of fallbackFiles(accountDir, "FallbackPDFs", id, row.fallbackPdfGeneration, [
    "FallbackPDF.pdf",
  ]))
    add(file);
  return found;
}

// -----------------------------------------------------------------------------
// Assembly and first-image selection
// -----------------------------------------------------------------------------

/**
 * Combine rows, body order, and on-disk files. Top-level attachments come in
 * body order (then any not referenced by the body, in creation order); each is
 * followed by its children in creation order.
 */
export function assembleAttachmentAssets(
  rows: AttachmentRow[],
  bodyOrder: string[] | null,
  containerDir: string = NOTES_CONTAINER_DIR
): NoteAttachmentAssets {
  const byPk = new Map(rows.map((r) => [r.pk, r]));
  const roots = rows.filter((r) => r.parentPk === null || !byPk.has(r.parentPk));
  const bodyIndex = new Map<string, number>();
  (bodyOrder ?? []).forEach((id, index) => bodyIndex.set(id.toLowerCase(), index));
  const indexOf = (r: AttachmentRow) => bodyIndex.get(r.identifier.toLowerCase()) ?? null;
  const inBody = roots.filter((r) => indexOf(r) !== null);
  const orderSource: "body" | "creation" = inBody.length > 0 ? "body" : "creation";
  const orderedRoots = [
    ...inBody.sort((a, b) => indexOf(a)! - indexOf(b)!),
    ...roots.filter((r) => indexOf(r) === null),
  ];

  const accountDirs = new Map<string | null, string | null>();
  const previewEntries = new Map<string, string[]>();
  const accountDirFor = (account: string | null) => {
    if (!accountDirs.has(account))
      accountDirs.set(account, resolveAccountDir(containerDir, account));
    return accountDirs.get(account) ?? null;
  };
  const record = (row: AttachmentRow, parent: AttachmentRow | null): AttachmentAssetRecord => {
    const accountDir = accountDirFor(row.accountIdentifier ?? parent?.accountIdentifier ?? null);
    let assetPaths: string[] = [];
    let previews: string[] = [];
    if (accountDir) {
      if (!previewEntries.has(accountDir))
        previewEntries.set(accountDir, listPreviewEntries(accountDir));
      assetPaths = assetPathsFor(accountDir, row);
      previews = previewPaths(accountDir, row.identifier, previewEntries.get(accountDir)!);
    }
    const previewPath = previews[0] ?? null;
    return {
      pk: row.pk,
      identifier: row.identifier,
      uti: row.uti,
      kind: classifyAttachmentKind(row.uti),
      parentIdentifier: parent?.identifier ?? null,
      filename: row.filename ?? row.mediaFilename,
      bodyIndex: parent ? null : indexOf(row),
      assetPaths,
      previewPath,
      paths: previewPath ? [...assetPaths, previewPath] : [...assetPaths],
    };
  };

  const attachments: AttachmentAssetRecord[] = [];
  for (const root of orderedRoots) {
    attachments.push(record(root, null));
    for (const child of rows.filter((r) => r.parentPk === root.pk && r !== root)) {
      attachments.push(record(child, root));
    }
  }
  return { orderSource, attachments };
}

/**
 * The note's lead visual in strict body order: the first image wins even when
 * its asset has not downloaded (path null); a scan or drawing stands in only
 * when the note has no image. A container's children are considered at the
 * container's position. With no decodable body order, creation order is used.
 */
export function selectFirstImage(assets: NoteAttachmentAssets): FirstImage | null {
  const candidates = assets.attachments.filter((a) => {
    if (a.parentIdentifier !== null) return true;
    return assets.orderSource === "creation" || a.bodyIndex !== null;
  });
  const eligibleChild = (a: AttachmentAssetRecord) =>
    a.parentIdentifier === null ||
    candidates.some((p) => p.parentIdentifier === null && p.identifier === a.parentIdentifier);
  const ordered = candidates.filter(eligibleChild);
  const chosen =
    ordered.find((a) => a.kind === "image") ??
    ordered.find((a) => a.kind === "scan" || a.kind === "drawing");
  if (!chosen) return null;
  const siblings = chosen.parentIdentifier
    ? ordered.filter((a) => a.parentIdentifier === chosen.parentIdentifier)
    : [];
  return {
    pk: chosen.pk,
    identifier: chosen.identifier,
    uti: chosen.uti,
    kind: chosen.kind,
    path: chosen.assetPaths[0] ?? null,
    previewPath: chosen.previewPath,
    parentIdentifier: chosen.parentIdentifier,
    galleryIndex: chosen.parentIdentifier ? siblings.indexOf(chosen) : null,
    orderSource: assets.orderSource,
  };
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

/** Canonical form of `p` even when its tail does not exist yet. */
function canonicalTail(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** True when `p` is, or would be created, inside the Notes group container. */
export function isInsideNotesContainer(
  p: string,
  containerDir: string = NOTES_CONTAINER_DIR
): boolean {
  const target = canonicalTail(p).toLowerCase();
  const container = canonicalTail(containerDir).toLowerCase();
  const rel = relative(container, target);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Copy `src` to a new file `dest`. The source is opened without following a
 * final symlink and must be a regular file (checked on the open descriptor);
 * the destination is created exclusively, so an existing file is never
 * replaced (EEXIST is thrown instead). A partial copy is removed. The copy
 * is created owner-only (0600): attachments are private note content, and an
 * export directory may sit under the temp dir.
 */
export function copyFileExclusive(src: string, dest: string): void {
  const input = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(input).isFile()) throw new Error("Source is not a regular file");
    const output = openSync(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += writeSync(output, buffer, written, read - written);
      }
    } catch (error) {
      closeSync(output);
      unlinkSync(dest);
      throw error;
    }
    closeSync(output);
  } finally {
    closeSync(input);
  }
}

/** The file name an export should use, before any collision suffix. */
export function exportFileName(
  record: Pick<AttachmentAssetRecord, "identifier" | "filename">,
  source: string,
  kind: "asset" | "preview"
): string {
  const ext = extname(source);
  // The identifier comes from the store like the file name, so it gets the
  // same one-component check, with a constant fallback.
  const id = safeComponent(record.identifier) ?? "attachment";
  if (kind === "preview") {
    // A preview is a thumbnail in its own format: never present it under the
    // asset's name and extension.
    const stored = safeComponent(record.filename ? basename(record.filename) : null);
    const stem = stored ? basename(stored, extname(stored)) : id;
    return `${safeComponent(stem) ?? id}-preview${ext}`;
  }
  const stored = safeComponent(record.filename ? basename(record.filename) : null);
  if (stored && !GENERIC_FILE_NAMES.has(stored.toLowerCase())) return stored;
  const own = safeComponent(basename(source));
  if (own && !GENERIC_FILE_NAMES.has(own.toLowerCase())) return own;
  return `${id}${ext}`;
}

/** `name`, then `stem-2.ext`, `stem-3.ext`, ... */
export function collisionName(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem}-${attempt}${ext}`;
}

/** Validate an export directory and create it. Throws on anything unsafe. */
export function prepareExportDir(exportDir: string, containerDir = NOTES_CONTAINER_DIR): string {
  const abs = assertSafeSavePath(exportDir);
  if (isInsideNotesContainer(abs, containerDir)) {
    throw new Error(`Refusing to write inside the Notes data container: "${abs}"`);
  }
  mkdirSync(abs, { recursive: true });
  if (isInsideNotesContainer(abs, containerDir)) {
    throw new Error(`Refusing to write inside the Notes data container: "${abs}"`);
  }
  return abs;
}

/** Copy one attachment's best file into `dir`: its asset, or its preview only when no asset exists. */
export function exportOneAttachment(
  record: AttachmentAssetRecord,
  dir: string,
  source: { path: string; kind: "asset" | "preview" } | null
): AttachmentExportResult {
  const base: AttachmentExportResult = {
    pk: record.pk,
    identifier: record.identifier,
    uti: record.uti,
    kind: record.kind,
    parentIdentifier: record.parentIdentifier,
    exportedTo: null,
    exportedKind: null,
  };
  if (!source) return base;
  const name = exportFileName(record, source.path, source.kind);
  for (let attempt = 1; attempt <= MAX_COLLISION_SUFFIX; attempt++) {
    const dest = join(dir, collisionName(name, attempt));
    try {
      if (dirname(dest) !== resolve(dir))
        throw new Error(`Refusing to write outside the export directory: "${dest}"`);
      assertSafeSavePath(dest);
      copyFileExclusive(source.path, dest);
      return { ...base, exportedTo: dest, exportedKind: source.kind };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ...base, error: "Too many name collisions in the export directory" };
}

/** The file an export takes for a record: asset first, preview only as a fallback. */
export function exportSource(
  record: Pick<AttachmentAssetRecord, "assetPaths" | "previewPath">
): { path: string; kind: "asset" | "preview" } | null {
  if (record.assetPaths[0]) return { path: record.assetPaths[0], kind: "asset" };
  if (record.previewPath) return { path: record.previewPath, kind: "preview" };
  return null;
}

/**
 * Export every top-level attachment (or a container's children when the
 * container has no file of its own) into `exportDir`.
 */
export function exportAttachmentAssets(
  assets: NoteAttachmentAssets,
  exportDir: string,
  options: { firstImageOnly?: boolean; containerDir?: string } = {}
): { exportDir: string; results: AttachmentExportResult[]; firstImage?: FirstImage | null } {
  const dir = prepareExportDir(exportDir, options.containerDir);
  if (options.firstImageOnly) {
    const first = selectFirstImage(assets);
    if (!first) return { exportDir: dir, results: [], firstImage: null };
    const record = assets.attachments.find((a) => a.pk === first.pk)!;
    return {
      exportDir: dir,
      results: [exportOneAttachment(record, dir, exportSource(record))],
      firstImage: first,
    };
  }
  const results: AttachmentExportResult[] = [];
  for (const record of assets.attachments) {
    if (record.parentIdentifier !== null) {
      const parent = assets.attachments.find(
        (a) => a.parentIdentifier === null && a.identifier === record.parentIdentifier
      );
      // Children are exported only for a container that has no file of its own.
      if (parent && exportSource(parent)) continue;
    } else if (
      !exportSource(record) &&
      assets.attachments.some((c) => c.parentIdentifier === record.identifier)
    ) {
      continue;
    }
    results.push(exportOneAttachment(record, dir, exportSource(record)));
  }
  return { exportDir: dir, results };
}
