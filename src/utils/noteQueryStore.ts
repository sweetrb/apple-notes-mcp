/**
 * Read-only NoteStore reader behind `query-notes`.
 *
 * One `sqlite3 -readonly` call detects the schema (PRAGMA table_info), and a
 * second call reads, inside a single read transaction, the store UUID, the
 * folder and account tables, and the most recently modified notes. Each row is
 * emitted as one `json_object(...)` line, so titles containing newlines or the
 * column separator cannot break parsing. Note bodies (gzipped protobuf in
 * ZICNOTEDATA.ZDATA) are fetched only when the query needs them and decoded
 * lazily, one note at a time, with the shared protobuf wire decoder.
 *
 * The database is never written. Nothing from the caller is interpolated into
 * SQL: the scan bound is a validated integer and every column name comes from a
 * fixed allowlist confirmed by PRAGMA table_info.
 *
 * @module utils/noteQueryStore
 * @see TECHNICAL_NOTES.md#query-notes-data-sources
 */

import { countWords } from "@/utils/wordCount.js";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gunzipSync } from "zlib";
import {
  decodeMessage,
  embeddedMessage,
  getField,
  getFields,
  stringValue,
  varintValue,
} from "@/utils/protobuf.js";
import { escapeFolderName } from "@/services/appleNotesManager.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";
import {
  evaluateNoteQuery,
  noteBodyText,
  matchLocations,
  needsContent,
  needsTags,
  normalizeForMatch,
  parseNoteQuery,
  positiveTextPredicates,
  positiveTextTerms,
  type Facet,
  type NoteContent,
  type QueryableNote,
  type QueryNode,
} from "@/utils/noteQuery.js";
import type { QueryNotesHit, QueryNotesResult } from "@/types.js";

const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Scan window: how many of the most recently modified notes are examined. */
export const QUERY_SCAN = { DEFAULT: 500, MAX: 5000 } as const;
/** Result cap: how many matching notes are returned. */
export const QUERY_RESULTS = { DEFAULT: 50, MAX: 500 } as const;

/** Core Data stores dates as seconds since 2001-01-01T00:00:00Z. */
const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 180;

export const QUERY_FDA_MESSAGE =
  "Full Disk Access is required to query notes. " +
  "In System Settings > Privacy & Security > Full Disk Access, grant access to the Node binary running this server " +
  "(required under Claude Desktop) or the terminal that launches it, then fully quit and " +
  `relaunch it. Setup guide: ${FULL_DISK_ACCESS_GUIDE_URL} — run the doctor tool to verify.`;

/** Raised for conditions the tool reports verbatim (permission, schema, parse). */
export class NoteQueryStoreError extends Error {
  constructor(
    message: string,
    public readonly kind: "no_fda" | "schema" | "query_error"
  ) {
    super(message);
    this.name = "NoteQueryStoreError";
  }
}

// -----------------------------------------------------------------------------
// Attachment type (UTI) → facet mapping
// -----------------------------------------------------------------------------

/**
 * Facet for one attachment type identifier, as stored in the note body's
 * attribute runs (AttachmentInfo field 2). Inline text attachments (hashtags,
 * mentions, note links) and tables are not "attachments" in the Notes UI.
 */
export function facetsForAttachmentType(uti: string): Facet[] {
  const type = uti.toLowerCase();
  if (type === "com.apple.notes.inlinetextattachment.hashtag") return [];
  if (type === "com.apple.notes.inlinetextattachment.link") return ["link"];
  if (type.startsWith("com.apple.notes.inlinetextattachment.")) return [];
  if (type === "com.apple.notes.table") return ["table"];
  const facets: Facet[] = ["attachment"];
  if (type === "public.url") facets.push("link");
  else if (type === "com.apple.paper.doc.scan" || type === "com.apple.notes.gallery")
    facets.push("scan");
  else if (type === "com.adobe.pdf" || type === "com.apple.paper.doc.pdf") facets.push("pdf");
  else if (
    type === "com.apple.paper" ||
    type === "com.apple.drawing" ||
    type === "com.apple.drawing.2" ||
    type === "com.apple.notes.sketch"
  )
    facets.push("drawing");
  else if (
    /^public\.(jpeg|png|heic|heif|tiff|gif|image|camera-raw-image|webp|bmp|svg-image)$/.test(
      type
    ) ||
    type === "com.adobe.raw-image" ||
    type === "com.compuserve.gif" ||
    type === "org.webmproject.webp" ||
    type === "com.microsoft.bmp"
  )
    facets.push("image");
  else if (
    /^public\.(movie|video|mpeg-4|mpeg|avi|3gpp|3gpp2)$/.test(type) ||
    type === "com.apple.quicktime-movie" ||
    type === "com.apple.m4v-video"
  )
    facets.push("video");
  else if (
    /^public\.(audio|mp3|mpeg-4-audio|aiff-audio|aifc-audio)$/.test(type) ||
    type === "com.apple.m4a-audio" ||
    type === "com.apple.coreaudio-format" ||
    type === "com.microsoft.waveform-audio"
  )
    facets.push("audio");
  return facets;
}

// -----------------------------------------------------------------------------
// Body decoding
// -----------------------------------------------------------------------------

/** Facts decoded from one note body, before lower-casing for matching. */
export interface DecodedNoteBody {
  text: string;
  facets: Set<Facet>;
  checklist: { total: number; open: number };
  /** Identifiers of inline objects, used to confirm native tag rows are live. */
  objectIds: Set<string>;
}

const CHECKLIST_STYLE = 103;

/**
 * Decodes a decompressed note document: Document → field 2 → field 3 holds the
 * text (field 2) and attribute runs (field 5). Each run may carry a link
 * (field 9), an attachment (field 12: id=1, type=2), and a paragraph style
 * (field 2) whose style 103 marks a checklist item with done state in 5.2.
 * Unlike the strict rich-text reader, unknown link schemes are tolerated: this
 * is a search, not a round-trip.
 */
export function decodeNoteBody(data: Uint8Array): DecodedNoteBody | null {
  const wrapper = embeddedMessage(getField(decodeMessage(data), 2));
  const body = wrapper && embeddedMessage(getField(wrapper, 3));
  const text = body && stringValue(getField(body, 2));
  if (!body || text === undefined) return null;
  const facets = new Set<Facet>();
  const objectIds = new Set<string>();
  const checklist = new Map<string, boolean>();
  let position = 0;
  for (const run of getFields(body, 5)) {
    const fields = embeddedMessage(run);
    if (!fields) continue;
    const length = varintValue(getField(fields, 1)) ?? 0;
    if (stringValue(getField(fields, 9))) facets.add("link");
    const attachment = embeddedMessage(getField(fields, 12));
    if (attachment) {
      const id = stringValue(getField(attachment, 1));
      if (id) objectIds.add(id);
      for (const facet of facetsForAttachmentType(stringValue(getField(attachment, 2)) ?? ""))
        facets.add(facet);
    }
    const paragraph = embeddedMessage(getField(fields, 2));
    if (paragraph && varintValue(getField(paragraph, 1)) === CHECKLIST_STYLE) {
      const item = embeddedMessage(getField(paragraph, 5));
      const rawId = item && getField(item, 1)?.value;
      // Several runs can style one item; its UUID (or, failing that, the start
      // of its line) identifies it so it is counted once.
      const key =
        rawId instanceof Uint8Array
          ? Buffer.from(rawId).toString("hex")
          : `line:${text.lastIndexOf("\n", position - 1) + 1}`;
      checklist.set(key, (item && varintValue(getField(item, 2))) === 1);
    }
    position += length;
  }
  if (checklist.size > 0) facets.add("checklist");
  const done = [...checklist.values()].filter(Boolean).length;
  return {
    text,
    facets,
    checklist: { total: checklist.size, open: checklist.size - done },
    objectIds,
  };
}

/** Decodes a hex-encoded, gzipped note document; null when it cannot be read. */
export function decodeBodyHex(hex: string): DecodedNoteBody | null {
  try {
    return decodeNoteBody(
      new Uint8Array(gunzipSync(Buffer.from(hex, "hex"), { maxOutputLength: 32 * 1024 * 1024 }))
    );
  } catch {
    return null;
  }
}

/** Counts words as every word-reporting tool does; see utils/wordCount. */
export { countWords };

// -----------------------------------------------------------------------------
// SQL
// -----------------------------------------------------------------------------

/** Columns the reader must have; without them no query is possible. */
const REQUIRED_COLUMNS = ["Z_PK", "Z_ENT", "ZTITLE1", "ZFOLDER", "ZMODIFICATIONDATE1"];

export interface ScanSqlOptions {
  scanLimit: number;
  includeDeleted: boolean;
  withBodies: boolean;
  withTags: boolean;
}

/** Returns the column if this store has it, else a SQL NULL. */
function col(available: ReadonlySet<string>, alias: string, name: string): string {
  return available.has(name) ? `${alias}.${name}` : "NULL";
}

const entity = (name: string) => `(SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME='${name}')`;

/**
 * Builds the single read transaction that feeds a query. Exported so tests can
 * inspect the generated SQL directly: execution is mocked there, so a SQL error
 * would otherwise be invisible until it met a real database.
 */
export function buildScanSql(available: ReadonlySet<string>, options: ScanSqlOptions): string {
  const missing = REQUIRED_COLUMNS.filter((c) => !available.has(c));
  if (missing.length) {
    throw new NoteQueryStoreError(
      `This macOS version's Notes database lacks columns query-notes needs (${missing.join(", ")}).`,
      "schema"
    );
  }
  const scan = Math.trunc(options.scanLimit);
  if (!Number.isInteger(scan) || scan < 1 || scan > QUERY_SCAN.MAX) {
    throw new NoteQueryStoreError(`scanLimit must be 1–${QUERY_SCAN.MAX}`, "query_error");
  }
  const created =
    ["ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE"]
      .filter((c) => available.has(c))
      .map((c) => `n.${c}`)
      .join(", ") || "NULL";
  const createdExpr = created.includes(",") ? `COALESCE(${created})` : created;
  const bool = (name: string) => (available.has(name) ? `COALESCE(n.${name}, 0)` : "0");
  const notNull = (alias: string, name: string) =>
    available.has(name) ? `${alias}.${name} IS NOT NULL` : "0";

  const tagsExpr =
    options.withTags &&
    ["ZNOTE1", "ZTYPEUTI1", "ZALTTEXT", "ZIDENTIFIER"].every((c) => available.has(c))
      ? `(SELECT json_group_array(json_array(t.ZIDENTIFIER, t.ZALTTEXT)) FROM ZICCLOUDSYNCINGOBJECT t ` +
        `WHERE t.ZNOTE1 = n.Z_PK AND t.ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.hashtag')`
      : "NULL";

  const where = [`n.Z_ENT = ${entity("ICNote")}`];
  if (!options.includeDeleted) {
    where.push("n.ZFOLDER IS NOT NULL");
    if (available.has("ZMARKEDFORDELETION")) where.push("COALESCE(n.ZMARKEDFORDELETION, 0) = 0");
    if (available.has("ZFOLDERTYPE")) {
      // Folder type 1 is Recently Deleted (identifier TrashFolder-…).
      where.push(
        `n.ZFOLDER NOT IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ${entity("ICFolder")} AND ZFOLDERTYPE = 1)`
      );
    }
  }
  const whereSql = where.join(" AND ");

  const folderRow =
    `SELECT json_object('k', 'folder', 'pk', f.Z_PK, 'name', ${col(available, "f", "ZTITLE2")}, ` +
    `'parent', ${col(available, "f", "ZPARENT")}, 'type', ${col(available, "f", "ZFOLDERTYPE")}, ` +
    `'owner', ${col(available, "f", "ZOWNER")}, 'shared', ${notNull("f", "ZSERVERSHAREDATA")}) ` +
    `FROM ZICCLOUDSYNCINGOBJECT f WHERE f.Z_ENT = ${entity("ICFolder")};`;
  const accountRow =
    `SELECT json_object('k', 'account', 'pk', a.Z_PK, 'name', ${col(available, "a", "ZNAME")}) ` +
    `FROM ZICCLOUDSYNCINGOBJECT a WHERE a.Z_ENT = ${entity("ICAccount")};`;
  // A correlated subquery (not a join) so a note can never appear twice, and
  // the body table is not touched at all for metadata-only queries.
  const dataExpr = options.withBodies
    ? "(SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK ORDER BY d.Z_PK DESC LIMIT 1)"
    : "NULL";
  const noteRow =
    `SELECT json_object('k', 'note', 'pk', n.Z_PK, 'title', n.ZTITLE1, 'folder', n.ZFOLDER, ` +
    `'created', ${createdExpr}, 'modified', n.ZMODIFICATIONDATE1, ` +
    `'pinned', ${bool("ZISPINNED")}, 'locked', ${bool("ZISPASSWORDPROTECTED")}, ` +
    `'shared', ${notNull("n", "ZSERVERSHAREDATA")}, 'snippet', ${col(available, "n", "ZSNIPPET")}, ` +
    `'data', ${dataExpr}, 'tags', ${tagsExpr}) ` +
    `FROM ZICCLOUDSYNCINGOBJECT n ` +
    `WHERE ${whereSql} ORDER BY n.ZMODIFICATIONDATE1 DESC, n.Z_PK DESC LIMIT ${scan};`;

  return [
    "BEGIN;",
    "SELECT json_object('k', 'meta', 'uuid', (SELECT Z_UUID FROM Z_METADATA LIMIT 1));",
    `SELECT json_object('k', 'total', 'n', COUNT(*)) FROM ZICCLOUDSYNCINGOBJECT n WHERE ${whereSql};`,
    folderRow,
    accountRow,
    noteRow,
    "COMMIT;",
  ].join(" ");
}

/**
 * Runs one read-only sqlite3 invocation. execFileSync with an argument array
 * means no shell: the path's spaces and the SQL are passed verbatim.
 */
function runSqlite(dbPath: string, query: string): string {
  return execFileSync("sqlite3", ["-readonly", dbPath, query], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function presentColumns(dbPath: string): Set<string> {
  const cols = new Set<string>();
  for (const line of runSqlite(dbPath, "PRAGMA table_info(ZICCLOUDSYNCINGOBJECT);").split("\n")) {
    const name = line.split("|")[1];
    if (name) cols.add(name);
  }
  return cols;
}

/**
 * Detects the schema, builds SQL for it, and runs it read-only, turning
 * permission and sqlite failures into {@link NoteQueryStoreError}s.
 */
function readStore(dbPath: string, build: (available: ReadonlySet<string>) => string): string {
  if (!fs.existsSync(dbPath)) throw new NoteQueryStoreError(QUERY_FDA_MESSAGE, "no_fda");
  try {
    return runSqlite(dbPath, build(presentColumns(dbPath)));
  } catch (error) {
    if (error instanceof NoteQueryStoreError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("authorization denied") || message.includes("unable to open database")) {
      throw new NoteQueryStoreError(QUERY_FDA_MESSAGE, "no_fda");
    }
    console.error(`query-notes: database read failed: ${message}`);
    throw new NoteQueryStoreError("Failed to read the Notes database.", "query_error");
  }
}

/** Most notes one batched text read accepts (the query-notes result cap). */
export const NOTE_TEXT_BATCH_MAX = QUERY_RESULTS.MAX;

/**
 * Builds the read of the newest document row for specific notes, by primary
 * key, used to enrich search results without a per-note AppleScript call.
 * Every key is validated as a positive safe integer before it enters the SQL.
 * Exported so tests can run the generated SQL through real sqlite3.
 */
export function buildNoteTextsSql(available: ReadonlySet<string>, pks: number[]): string {
  const missing = ["Z_PK", "Z_ENT"].filter((c) => !available.has(c));
  if (missing.length) {
    throw new NoteQueryStoreError(
      `This macOS version's Notes database lacks columns search enrichment needs (${missing.join(", ")}).`,
      "schema"
    );
  }
  const keys = [...new Set(pks)];
  if (keys.length > NOTE_TEXT_BATCH_MAX) {
    throw new NoteQueryStoreError(
      `At most ${NOTE_TEXT_BATCH_MAX} notes can be read at once.`,
      "query_error"
    );
  }
  for (const pk of keys) {
    if (!Number.isSafeInteger(pk) || pk < 1) {
      throw new NoteQueryStoreError(`Invalid note key ${String(pk)}`, "query_error");
    }
  }
  const locked = available.has("ZISPASSWORDPROTECTED")
    ? "COALESCE(n.ZISPASSWORDPROTECTED, 0)"
    : "0";
  return [
    "BEGIN;",
    "SELECT json_object('k', 'meta', 'uuid', (SELECT Z_UUID FROM Z_METADATA LIMIT 1));",
    `SELECT json_object('k', 'note', 'pk', n.Z_PK, 'locked', ${locked}, ` +
      "'data', (SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK ORDER BY d.Z_PK DESC LIMIT 1)) " +
      `FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_ENT = ${entity("ICNote")} ` +
      `AND n.Z_PK IN (${keys.length ? keys.join(", ") : "NULL"});`,
    "COMMIT;",
  ].join(" ");
}

/** Decoded text for specific notes, keyed by primary key. */
export interface NoteTexts {
  /** The store UUID, to confirm an x-coredata id belongs to this store. */
  uuid: string | undefined;
  /** Text per found note; null when the note is locked or its body is unreadable. */
  texts: Map<number, string | null>;
}

/**
 * Reads and decodes the text of specific notes in one read-only query. Notes
 * that do not exist are absent from the map.
 *
 * @throws NoteQueryStoreError for permission, schema, or database failures
 */
export function readNoteTexts(pks: number[], options: { dbPath?: string } = {}): NoteTexts {
  const output = readStore(options.dbPath ?? NOTES_DB_PATH, (available) =>
    buildNoteTextsSql(available, pks)
  );
  let uuid: string | undefined;
  const texts = new Map<number, string | null>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      k: string;
      uuid?: unknown;
      pk?: number;
      locked?: number;
      data?: string | null;
    };
    if (row.k === "meta") uuid = typeof row.uuid === "string" ? row.uuid : undefined;
    else if (row.k === "note" && typeof row.pk === "number") {
      const body = row.locked || !row.data ? null : decodeBodyHex(row.data);
      texts.set(row.pk, body ? body.text : null);
    }
  }
  return { uuid, texts };
}

// -----------------------------------------------------------------------------
// Row assembly
// -----------------------------------------------------------------------------

/** One ICFolder row as emitted by {@link buildScanSql}. */
export interface FolderRow {
  pk: number;
  name: string | null;
  parent: number | null;
  type: number | null;
  owner: number | null;
  shared: number;
}
interface NoteRow {
  pk: number;
  title: string | null;
  folder: number | null;
  created: number | null;
  modified: number | null;
  pinned: number;
  locked: number;
  shared: number;
  snippet: string | null;
  data: string | null;
  tags: Array<[string | null, string | null]> | null;
}

interface FolderInfo {
  /** Full path in list-folders syntax (a literal `/` in a name is escaped as `\/`). */
  path: string;
  /** Full path with unescaped separators, used only to extend child paths. */
  plainPath: string;
  /** Normalized spellings `folder:` accepts: name, plain path, escaped path. */
  keys: string[];
  accountPk: number | null;
  shared: boolean;
}

/** Escapes a literal `/` in one folder name with list-folders' own helper, so paths match. */
const escapeSegment = escapeFolderName;

/** Resolves every folder's path, account, and inherited shared state. */
export function resolveFolders(rows: FolderRow[]): Map<number, FolderInfo> {
  const byPk = new Map(rows.map((row) => [row.pk, row]));
  const resolved = new Map<number, FolderInfo>();
  const resolve = (pk: number, seen: Set<number>): FolderInfo | undefined => {
    const cached = resolved.get(pk);
    if (cached) return cached;
    const row = byPk.get(pk);
    if (!row || seen.has(pk)) return undefined; // missing or cyclic parent
    seen.add(pk);
    const parent = row.parent !== null ? resolve(row.parent, seen) : undefined;
    const name = row.name ?? "";
    const path = parent ? `${parent.path}/${escapeSegment(name)}` : escapeSegment(name);
    const plainPath = parent ? `${parent.plainPath}/${name}` : name;
    const info: FolderInfo = {
      path,
      plainPath,
      keys: [...new Set([name, plainPath, path].map(normalizeForMatch))],
      accountPk: row.owner ?? parent?.accountPk ?? null,
      shared: Boolean(row.shared) || Boolean(parent?.shared),
    };
    resolved.set(pk, info);
    return info;
  };
  for (const row of rows) resolve(row.pk, new Set());
  return resolved;
}

const coreDataMs = (seconds: number | null) =>
  seconds === null || !Number.isFinite(seconds) ? undefined : CORE_DATA_EPOCH_MS + seconds * 1000;

function buildSnippet(text: string, terms: string[]): string {
  const clean = text.replace(/\ufffc/gu, " ");
  const firstBreak = clean.indexOf("\n");
  const body = firstBreak === -1 ? clean : clean.slice(firstBreak + 1);
  const lower = normalizeForMatch(body);
  let start = 0;
  if (lower.length === body.length) {
    const hits = terms
      .map((term) => lower.indexOf(normalizeForMatch(term)))
      .filter((index) => index >= 0);
    if (hits.length) start = Math.max(0, Math.min(...hits) - SNIPPET_BEFORE);
  }
  const slice = body
    .slice(start, start + SNIPPET_LENGTH)
    .replace(/\s+/gu, " ")
    .trim();
  if (!slice) return "";
  return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET_LENGTH < body.length ? "…" : ""}`;
}

export interface QueryNotesOptions {
  limit?: number;
  scanLimit?: number;
  includeDeleted?: boolean;
  /**
   * Add `wordCount` to each returned note. Free when the query already read
   * bodies; otherwise one extra read-only query fetches only the returned
   * notes' bodies.
   */
  includeWordCount?: boolean;
  /**
   * Database to read. Tests point this at a fixture store; the tool never sets
   * it, so production reads always target the live NoteStore (read-only).
   */
  dbPath?: string;
}

/**
 * Parses and runs a query against the NoteStore, read-only.
 *
 * @throws NoteQueryError for a malformed expression
 * @throws NoteQueryStoreError for permission, schema, or database failures
 */
export function queryNotes(expression: string, options: QueryNotesOptions = {}): QueryNotesResult {
  const ast: QueryNode = parseNoteQuery(expression);
  return runNoteQuery(ast, {
    ...options,
    limit: Math.min(options.limit ?? QUERY_RESULTS.DEFAULT, QUERY_RESULTS.MAX),
  });
}

/**
 * Runs an already-built query AST against the NoteStore, read-only.
 *
 * Callers that assemble a query programmatically (search-notes' body search)
 * build the AST directly, so caller text never passes through the tokenizer and
 * cannot be misread as a field, operator, or quote. `limit` is applied as given
 * (search-notes has its own cap semantics); the scan window is still bounded by
 * {@link QUERY_SCAN}.
 *
 * @throws NoteQueryStoreError for permission, schema, or database failures
 */
export function runNoteQuery(ast: QueryNode, options: QueryNotesOptions = {}): QueryNotesResult {
  const limit = options.limit ?? QUERY_RESULTS.DEFAULT;
  const scanLimit = Math.min(options.scanLimit ?? QUERY_SCAN.DEFAULT, QUERY_SCAN.MAX);
  const includeDeleted = options.includeDeleted ?? false;
  const withBodies = needsContent(ast);
  const withTags = needsTags(ast);

  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const output = readStore(dbPath, (available) =>
    buildScanSql(available, { scanLimit, includeDeleted, withBodies, withTags })
  );

  let uuid: string | undefined;
  let eligible = 0;
  const folderRows: FolderRow[] = [];
  const accounts = new Map<number, string>();
  const notes: NoteRow[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { k: string } & Record<string, unknown>;
    if (row.k === "meta") uuid = typeof row.uuid === "string" ? row.uuid : undefined;
    else if (row.k === "total") eligible = Number(row.n) || 0;
    else if (row.k === "folder") folderRows.push(row as unknown as FolderRow);
    else if (row.k === "account" && typeof row.name === "string")
      accounts.set(Number(row.pk), row.name);
    else if (row.k === "note") notes.push(row as unknown as NoteRow);
  }
  if (!uuid || !/^[0-9A-Fa-f-]+$/.test(uuid)) {
    throw new NoteQueryStoreError(
      "The Notes database has no store identifier, so note IDs cannot be formed.",
      "schema"
    );
  }

  const folders = resolveFolders(folderRows);
  const textTerms = positiveTextTerms(ast);
  const textPredicates = positiveTextPredicates(ast);
  const pendingWordCounts: number[] = [];
  const hits: QueryNotesHit[] = [];
  let matched = 0;
  let unreadable = 0;

  for (const row of notes) {
    const folder = row.folder !== null ? folders.get(row.folder) : undefined;
    const account =
      folder?.accountPk !== null && folder?.accountPk !== undefined
        ? accounts.get(folder.accountPk)
        : undefined;
    const locked = Boolean(row.locked);
    let decoded: DecodedNoteBody | null | undefined;
    let content: NoteContent | null | undefined;
    const decode = (): DecodedNoteBody | null => {
      if (decoded !== undefined) return decoded;
      decoded = null;
      if (locked) return decoded;
      if (!row.data) {
        // Bodies were requested but this note has no document row.
        if (withBodies) unreadable++;
        return decoded;
      }
      decoded = decodeBodyHex(row.data);
      if (!decoded) unreadable++;
      return decoded;
    };
    const note: QueryableNote = {
      titleLower: normalizeForMatch(row.title ?? ""),
      folderKeys: folder?.keys ?? [],
      accountLower: account !== undefined ? normalizeForMatch(account) : undefined,
      pinned: Boolean(row.pinned),
      locked,
      shared: Boolean(row.shared) || Boolean(folder?.shared),
      created: coreDataMs(row.created),
      modified: coreDataMs(row.modified),
      content: () => {
        if (content !== undefined) return content;
        const body = decode();
        if (!body) return (content = null);
        const text = body.text;
        const tags = new Set<string>();
        for (const [id, alt] of row.tags ?? []) {
          // Only tag objects still referenced from the body count; Notes keeps
          // rows for removed inline objects until they are purged.
          if (id && alt && body.objectIds.has(id))
            tags.add(normalizeForMatch(alt.replace(/^#/, "")));
        }
        const facets = new Set(body.facets);
        if (tags.size) facets.add("tag");
        content = {
          textLower: normalizeForMatch(text),
          bodyLower: normalizeForMatch(noteBodyText(text)),
          words: countWords(text),
          facets,
          checklist: body.checklist,
          tags: [...tags],
        };
        return content;
      },
    };

    if (!evaluateNoteQuery(ast, note)) continue;
    matched++;
    if (hits.length >= limit) continue;
    const body = locked ? null : decode();
    // Without fetched bodies (a metadata-only query), every text predicate is
    // title:, so the title alone answers matchedIn.
    const matchedIn = matchLocations(textPredicates, row.title ?? "", body ? body.text : null);
    if (options.includeWordCount && !withBodies) pendingWordCounts.push(row.pk);
    hits.push({
      id: `x-coredata://${uuid}/ICNote/p${row.pk}`,
      title: row.title ?? "",
      ...(folder ? { folder: folder.path } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(note.modified !== undefined ? { modified: new Date(note.modified).toISOString() } : {}),
      ...(note.created !== undefined ? { created: new Date(note.created).toISOString() } : {}),
      snippet: locked
        ? ""
        : body
          ? buildSnippet(body.text, textTerms)
          : (row.snippet ?? "").replace(/\s+/gu, " ").trim(),
      ...(locked ? { locked: true } : {}),
      ...(matchedIn ? { matchedIn } : {}),
      ...(options.includeWordCount && withBodies
        ? { wordCount: body ? countWords(body.text) : null }
        : {}),
    });
  }

  // A metadata-only query never fetched bodies; read just the returned notes'
  // bodies in one extra query instead of the whole scan window.
  if (pendingWordCounts.length) {
    const { texts } = readNoteTexts(pendingWordCounts, { dbPath });
    pendingWordCounts.forEach((pk, index) => {
      const text = texts.get(pk);
      hits[index].wordCount = typeof text === "string" ? countWords(text) : null;
    });
  }

  return {
    notes: hits,
    count: hits.length,
    matched,
    scanned: notes.length,
    eligible,
    scanLimit,
    scanTruncated: eligible > notes.length,
    limit,
    truncated: matched > hits.length,
    unreadable,
  };
}
