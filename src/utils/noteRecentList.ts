/**
 * Database-backed note listing with exact incremental checkpoints, plus a
 * folder tree with note counts.
 *
 * `list-notes` enumerates through AppleScript, which cannot order by date,
 * see Recently Deleted, or read a stored timestamp exactly. This reader goes
 * to NoteStore instead (read-only, one transaction per call) and adds:
 *
 * - a sync cursor on every row (`modifiedCheckpoint`): the stored Core Data
 *   double's exact IEEE-754 bits, read with sqlite3's `ieee754_to_blob` and
 *   bound back with `ieee754_from_blob` so the value never passes through a
 *   JavaScript Date or a rounded decimal, plus the row's `Z_PK` to break ties;
 * - `since` queries that walk rows oldest first in `(modified, Z_PK)` order
 *   after the cursor, and newest-first browsing without `since`;
 * - optional word and character counts from the shared body decoder
 *   (noteBlocks.ts) and a body preview.
 *
 * Sync rule: with `since`, `nextSince` is the last returned row's cursor, so
 * every call advances whether or not it filled `limit`. Rows that share one
 * timestamp are ordered by key, so paging never skips or repeats them.
 * `saturated` (count equals limit) only says more rows may follow.
 *
 * @module utils/noteRecentList
 */

import { decodeCompressedNoteBlocks } from "@/utils/noteBlocks.js";
import { countWords } from "@/utils/wordCount.js";
import {
  accountRef,
  activeNoteSql,
  col,
  CORE_DATA_EPOCH_MS,
  coreDataToIso,
  doubleToHex,
  entity,
  folderPaths,
  hexToDouble,
  NOTES_DB_PATH,
  noteIdFor,
  NoteStoreError,
  notTombstonedSql,
  parseJsonLines,
  readColumns,
  readStoreContext,
  requireColumns,
  resolveAccountName,
  runReadOnlySql,
  trashFolderSql,
  type BoundValue,
  type StoreAccount,
  type StoreContext,
  type StoreFolder,
} from "@/utils/noteStoreSql.js";
import type {
  FolderTreeAccount,
  FolderTreeNode,
  FolderTreeResult,
  RecentNoteRow,
  RecentNotesResult,
} from "@/types.js";

/** Row caps for `list-recent-notes`. */
export const RECENT_LIMIT = { DEFAULT: 50, MAX: 1000 } as const;

/** Prefix of a sync cursor token (versioned so the format can change). */
export const CHECKPOINT_PREFIX = "cdts1:";

/**
 * A position in `(modified, Z_PK)` order. Without `pk`, the position sits
 * after every row stored at `modified` (a strict timestamp boundary).
 */
export interface SyncCursor {
  modified: number;
  pk?: number;
}

const PREVIEW_LENGTH = 180;
/** U+FFFC OBJECT REPLACEMENT CHARACTER, which marks each inline attachment. */
const OBJECT_REPLACEMENT = new RegExp(String.fromCharCode(0xfffc), "gu");

// -----------------------------------------------------------------------------
// Checkpoints and `since`
// -----------------------------------------------------------------------------

/** Renders a cursor as an opaque `cdts1:<16 hex bits>[:<Z_PK>]` token. */
export function formatCursor(cursor: SyncCursor): string {
  const base = CHECKPOINT_PREFIX + doubleToHex(cursor.modified);
  return cursor.pk === undefined ? base : `${base}:${cursor.pk}`;
}

/**
 * Cursor token for a stored row, from the timestamp's IEEE-754 bits (16 hex
 * digits) and its key. Null when the row has no usable timestamp.
 */
export function checkpointFromBits(bits: string | null | undefined, pk: number): string | null {
  if (!bits) return null;
  try {
    return formatCursor({ modified: hexToDouble(bits), pk });
  } catch {
    return null;
  }
}

const CURSOR = /^([0-9a-f]{16})(?::(0|[1-9]\d{0,15}))?$/i;

/** Parses the part of a cursor token after {@link CHECKPOINT_PREFIX}. */
function parseCursorBody(body: string, input: string): SyncCursor {
  const match = CURSOR.exec(body);
  const pk = match?.[2] !== undefined ? Number(match[2]) : undefined;
  try {
    if (!match || (pk !== undefined && !Number.isSafeInteger(pk))) throw new Error("bad");
    return pk === undefined
      ? { modified: hexToDouble(match[1]) }
      : { modified: hexToDouble(match[1]), pk };
  } catch {
    throw new NoteStoreError(`Invalid checkpoint "${input}".`, "invalid_input");
  }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parses `since` into a cursor. A token yields its exact double and key. An
 * ISO date without a time is local midnight; a date-time without an offset is
 * local time; an explicit offset or `Z` is honored. ISO values carry no key,
 * so they select rows modified strictly after that moment.
 */
export function parseSince(input: string): SyncCursor {
  const text = input.trim();
  if (text.startsWith(CHECKPOINT_PREFIX)) {
    return parseCursorBody(text.slice(CHECKPOINT_PREFIX.length), input);
  }
  let ms = Number.NaN;
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const local = new Date(year, month - 1, day);
    if (local.getMonth() === month - 1 && local.getDate() === day) ms = local.getTime();
  } else if (DATE_TIME.test(text)) {
    // Date.parse keeps millisecond precision only; finer digits are dropped.
    ms = Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
  }
  if (!Number.isFinite(ms)) {
    throw new NoteStoreError(
      `Invalid since value "${input}". Use an ISO 8601 date or date-time (e.g. 2026-08-01 or ` +
        `2026-08-01T09:30:00+02:00) or a modifiedCheckpoint token.`,
      "invalid_input"
    );
  }
  return { modified: (ms - CORE_DATA_EPOCH_MS) / 1000 };
}

// -----------------------------------------------------------------------------
// Body statistics
// -----------------------------------------------------------------------------

/**
 * Word and character counts for decoded note text. Attachment placeholders
 * (U+FFFC) are not counted. Words are counted by utils/wordCount (the count
 * query-notes' words: filter uses); characters are Unicode code points.
 */
export function textStats(text: string): { wordCount: number; charCount: number } {
  const visible = text.replace(OBJECT_REPLACEMENT, "");
  return { wordCount: countWords(visible), charCount: [...visible].length };
}

/** A one-line preview: placeholders removed, whitespace collapsed, 180 code points. */
export function previewText(text: string): string {
  const flat = text.replace(OBJECT_REPLACEMENT, " ").replace(/\s+/gu, " ").trim();
  return [...flat].slice(0, PREVIEW_LENGTH).join("");
}

/** Decoded text of a stored body, or null when it cannot be decoded. */
function decodeBodyText(hex: string | null): string | null {
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  try {
    return decodeCompressedNoteBlocks(Buffer.from(hex, "hex")).text;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Recent notes
// -----------------------------------------------------------------------------

const flag = (columns: ReadonlySet<string>, alias: string, name: string) =>
  columns.has(name) ? `COALESCE(${alias}.${name}, 0)` : "0";

/** Columns the listing needs. */
const REQUIRED = ["Z_PK", "Z_ENT", "ZFOLDER", "ZTITLE1", "ZMODIFICATIONDATE1"];

/** Which optional filters and payloads a listing uses. */
export interface RecentSqlOptions {
  includeDeleted: boolean;
  /** Bind `@account`. */
  scoped: boolean;
  /** Bind `@folder`. */
  inFolder: boolean;
  /**
   * `since` query: bind `@since` (and `@sincePk` when `sinceKey`) and walk
   * rows oldest first. Otherwise rows come newest first.
   */
  since: boolean;
  /** The `since` cursor carries a key: bind `@sincePk` to break ties. */
  sinceKey?: boolean;
  /** Fetch compressed bodies for decoding. */
  withBodies: boolean;
}

/**
 * Builds the listing query. Always binds `@limit`; other parameters per
 * `options`. Exported so tests can run the SQL against a fixture store.
 */
export function buildRecentNotesSql(columns: ReadonlySet<string>, options: RecentSqlOptions) {
  requireColumns(columns, REQUIRED, "list-recent-notes");
  const owner = col(columns, "f", "ZOWNER");
  const account =
    owner === "NULL" ? accountRef(columns, "n") : `COALESCE(${owner}, ${accountRef(columns, "n")})`;
  const created =
    ["ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE"]
      .filter((name) => columns.has(name))
      .map((name) => `n.${name}`)
      .join(", ") || "NULL";
  const createdExpr = created.includes(",") ? `COALESCE(${created})` : created;
  const locked = flag(columns, "n", "ZISPASSWORDPROTECTED");
  const cloud = ["ZNEEDSTOBEFETCHEDFROMCLOUD", "ZNEEDSINITIALFETCHFROMCLOUD"]
    .filter((name) => columns.has(name))
    .map((name) => `COALESCE(n.${name}, 0)`);
  const where = [`n.Z_ENT = ${entity("ICNote")}`];
  if (!options.includeDeleted) where.push(activeNoteSql(columns, "n", "f"));
  if (options.scoped) where.push("a.Z_PK = @account");
  if (options.inFolder) where.push("n.ZFOLDER = @folder");
  if (options.since) {
    where.push(
      options.sinceKey
        ? "(n.ZMODIFICATIONDATE1 > @since OR (n.ZMODIFICATIONDATE1 = @since AND n.Z_PK > @sincePk))"
        : "n.ZMODIFICATIONDATE1 > @since"
    );
  }
  const order = options.since
    ? "n.ZMODIFICATIONDATE1 ASC, n.Z_PK ASC"
    : "n.ZMODIFICATIONDATE1 DESC, n.Z_PK DESC";
  const data = options.withBodies
    ? `CASE WHEN ${locked} = 1 THEN NULL ELSE ` +
      `(SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK ORDER BY d.Z_PK DESC LIMIT 1) END`
    : "NULL";
  return (
    `SELECT json_object('pk', n.Z_PK, 'identifier', ${col(columns, "n", "ZIDENTIFIER")}, ` +
    `'title', n.ZTITLE1, 'folder', f.Z_PK, 'account', a.Z_PK, 'created', ${createdExpr}, ` +
    `'modified', n.ZMODIFICATIONDATE1, 'bits', hex(ieee754_to_blob(n.ZMODIFICATIONDATE1)), ` +
    `'pinned', ${flag(columns, "n", "ZISPINNED")}, 'locked', ${locked}, ` +
    `'trash', f.Z_PK IS NOT NULL AND ${trashFolderSql(columns, "f")}, ` +
    `'tombstoned', NOT ${notTombstonedSql(columns, "n")}, ` +
    `'cloud', ${cloud.length ? cloud.join(" + ") : "0"}, ` +
    `'snippet', CASE WHEN ${locked} = 1 THEN NULL ELSE ${col(columns, "n", "ZSNIPPET")} END, ` +
    `'data', ${data}) ` +
    `FROM ZICCLOUDSYNCINGOBJECT n ` +
    `LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER AND f.Z_ENT = ${entity("ICFolder")} ` +
    `LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = ${account} AND a.Z_ENT = ${entity("ICAccount")} ` +
    `WHERE ${where.join(" AND ")} ` +
    `ORDER BY ${order} LIMIT @limit;`
  );
}

interface RawRecentRow {
  pk: number;
  identifier: string | null;
  title: string | null;
  folder: number | null;
  account: number | null;
  created: number | null;
  modified: number | null;
  bits: string | null;
  pinned: number;
  locked: number;
  trash: number;
  tombstoned: number;
  cloud: number;
  snippet: string | null;
  data: string | null;
}

/** Options for {@link listRecentNotes}. */
export interface RecentNotesOptions {
  account?: string;
  folder?: string;
  since?: string;
  limit?: number;
  includeDeleted?: boolean;
  wordCounts?: boolean;
  bodyPreview?: boolean;
  /** Fixture database path for tests. */
  dbPath?: string;
}

/**
 * Resolves a folder path to one folder. Accepts a full path in list-folders
 * syntax (case-insensitive), or a bare folder name when it is unique.
 */
export function resolveFolderPath(
  folders: StoreFolder[],
  paths: Map<number, string>,
  input: string,
  accountPk?: number
): StoreFolder {
  const candidates = folders.filter(
    (folder) => !folder.tombstoned && (accountPk === undefined || folder.account === accountPk)
  );
  const wanted = input
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLocaleLowerCase();
  const byPath = candidates.filter((f) => (paths.get(f.pk) ?? "").toLocaleLowerCase() === wanted);
  const byName = candidates.filter(
    (f) => (f.name ?? "").toLocaleLowerCase() === wanted.replace(/\\\//g, "/")
  );
  const matches = byPath.length ? byPath : byName;
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw new NoteStoreError(`No folder "${input}" found.`, "invalid_input");
  }
  const options = matches.map((f) => paths.get(f.pk)).join(", ");
  throw new NoteStoreError(
    `Folder "${input}" is ambiguous (${options}). Pass the full path, or an account.`,
    "invalid_input"
  );
}

/**
 * With `since`, lists notes after that cursor oldest first and returns the
 * last row's cursor as `nextSince`. Without it, lists the newest notes first.
 */
export function listRecentNotes(options: RecentNotesOptions = {}): RecentNotesResult {
  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? RECENT_LIMIT.DEFAULT)),
    RECENT_LIMIT.MAX
  );
  const since = options.since !== undefined ? parseSince(options.since) : undefined;
  const columns = readColumns(dbPath);
  const context = readStoreContext(dbPath, columns);
  const paths = folderPaths(context.folders);
  const scope = options.account ? resolveAccountName(context.accounts, options.account) : undefined;
  const folder = options.folder
    ? resolveFolderPath(context.folders, paths, options.folder, scope?.pk)
    : undefined;

  const withBodies = Boolean(options.wordCounts);
  const params: Record<string, BoundValue> = { limit: { int: limit } };
  if (scope) params.account = { int: scope.pk };
  if (folder) params.folder = { int: folder.pk };
  if (since) params.since = { double: since.modified };
  if (since?.pk !== undefined) params.sincePk = { int: since.pk };
  const sql = buildRecentNotesSql(columns, {
    includeDeleted: Boolean(options.includeDeleted),
    scoped: Boolean(scope),
    inFolder: Boolean(folder),
    since: Boolean(since),
    sinceKey: since?.pk !== undefined,
    withBodies,
  });
  const raw = parseJsonLines<RawRecentRow>(runReadOnlySql(dbPath, sql, params));
  const accountNames = new Map(context.accounts.map((account) => [account.pk, account.name]));
  const notes = raw.map((row) => toRecentRow(row, context, paths, accountNames, options));

  const saturated = notes.length === limit;
  let nextSince: string | null;
  if (since) {
    // A since query can only return dated rows, so the last row has a cursor.
    nextSince = notes.length ? notes[notes.length - 1].modifiedCheckpoint : formatCursor(since);
  } else {
    // Browsing newest first: the newest row is a complete cursor only when
    // nothing older was cut off.
    nextSince = !saturated && notes.length ? notes[0].modifiedCheckpoint : null;
  }
  return {
    notes,
    count: notes.length,
    limit,
    order: since ? "oldest-first" : "newest-first",
    saturated,
    nextSince,
    ...(scope ? { account: scope.name } : {}),
    ...(folder ? { folder: paths.get(folder.pk) } : {}),
  };
}

function toRecentRow(
  row: RawRecentRow,
  context: StoreContext,
  paths: Map<number, string>,
  accountNames: Map<number, string>,
  options: RecentNotesOptions
): RecentNoteRow {
  const note: RecentNoteRow = {
    id: noteIdFor(context.uuid, row.pk),
    identifier: row.identifier ?? null,
    title: row.title ?? null,
    folder: row.folder !== null ? (paths.get(row.folder) ?? null) : null,
    account: row.account !== null ? (accountNames.get(row.account) ?? null) : null,
    created: coreDataToIso(row.created),
    modified: coreDataToIso(row.modified),
    modifiedCheckpoint: checkpointFromBits(row.bits, row.pk),
    pinned: Boolean(row.pinned),
    locked: Boolean(row.locked),
    inRecentlyDeleted: Boolean(row.trash),
    markedForDeletion: Boolean(row.tombstoned),
  };
  // A body is known only when it is unlocked and fully downloaded; then an
  // empty decode really is an empty note.
  const text = row.locked || row.cloud ? null : decodeBodyText(row.data);
  if (options.wordCounts) {
    const stats = text === null ? null : textStats(text);
    note.wordCount = stats?.wordCount ?? null;
    note.charCount = stats?.charCount ?? null;
  }
  if (options.bodyPreview) {
    note.textDecoded = text !== null;
    note.bodyPreview =
      text !== null ? previewText(text) : row.snippet ? previewText(row.snippet) : null;
  }
  return note;
}

// -----------------------------------------------------------------------------
// Folder tree
// -----------------------------------------------------------------------------

/** Per-folder counts of notes that are not tombstones. */
export function buildFolderCountsSql(columns: ReadonlySet<string>): string {
  requireColumns(columns, ["Z_PK", "Z_ENT", "ZFOLDER"], "list-folder-tree");
  return (
    `SELECT json_object('folder', n.ZFOLDER, 'n', COUNT(*)) FROM ZICCLOUDSYNCINGOBJECT n ` +
    `WHERE n.Z_ENT = ${entity("ICNote")} AND n.ZFOLDER IS NOT NULL AND ${notTombstonedSql(columns, "n")} ` +
    `GROUP BY n.ZFOLDER;`
  );
}

/** Options for {@link folderTree}. */
export interface FolderTreeOptions {
  account?: string;
  includeDeleted?: boolean;
  /** Fixture database path for tests. */
  dbPath?: string;
}

const KIND_ORDER: Record<FolderTreeNode["kind"], number> = { folder: 0, smart: 1, trash: 2 };

/** Regular folders by name, then smart folders, then Recently Deleted. */
function compareNodes(a: FolderTreeNode, b: FolderTreeNode): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);
}

/** Folder hierarchy with direct and cumulative note counts, grouped by account. */
export function folderTree(options: FolderTreeOptions = {}): FolderTreeResult {
  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const columns = readColumns(dbPath);
  const context = readStoreContext(dbPath, columns);
  const scope = options.account ? resolveAccountName(context.accounts, options.account) : undefined;
  const counts = new Map(
    parseJsonLines<{ folder: number; n: number }>(
      runReadOnlySql(dbPath, buildFolderCountsSql(columns))
    ).map((row) => [row.folder, row.n])
  );
  return assembleFolderTree(context, counts, Boolean(options.includeDeleted), scope);
}

/** Builds the tree from folder rows and counts. Exported for unit tests. */
export function assembleFolderTree(
  context: StoreContext,
  counts: Map<number, number>,
  includeDeleted: boolean,
  scope?: StoreAccount
): FolderTreeResult {
  const paths = folderPaths(context.folders);
  const visible = context.folders.filter(
    (folder) => (includeDeleted || !folder.tombstoned) && (!scope || folder.account === scope.pk)
  );
  const byPk = new Map(visible.map((folder) => [folder.pk, folder]));
  const nodes = new Map<number, FolderTreeNode>();
  for (const folder of visible) {
    const node: FolderTreeNode = {
      id: `x-coredata://${context.uuid}/ICFolder/p${folder.pk}`,
      identifier: folder.identifier,
      name: folder.name ?? "",
      path: paths.get(folder.pk) ?? "",
      kind: folder.trash ? "trash" : folder.folderType === 2 ? "smart" : "folder",
      noteCount: counts.get(folder.pk) ?? 0,
      totalNoteCount: 0,
      children: [],
    };
    if (includeDeleted) node.markedForDeletion = Boolean(folder.tombstoned);
    nodes.set(folder.pk, node);
  }

  /** The visible parent, unless following parents from it loops back to `pk`. */
  const parentOf = (folder: StoreFolder): number | undefined => {
    if (folder.parent === null || !byPk.has(folder.parent)) return undefined;
    const seen = new Set<number>([folder.pk]);
    for (
      let at = byPk.get(folder.parent);
      at;
      at = at.parent !== null ? byPk.get(at.parent) : undefined
    ) {
      if (seen.has(at.pk)) return undefined;
      seen.add(at.pk);
    }
    return folder.parent;
  };

  const roots = new Map<number | null, FolderTreeNode[]>();
  for (const folder of visible) {
    const node = nodes.get(folder.pk)!;
    const parent = parentOf(folder);
    if (parent !== undefined) nodes.get(parent)!.children.push(node);
    else {
      const key =
        folder.account !== null && context.accounts.some((a) => a.pk === folder.account)
          ? folder.account
          : null;
      roots.set(key, [...(roots.get(key) ?? []), node]);
    }
  }

  const finish = (node: FolderTreeNode): number => {
    node.children.sort(compareNodes);
    node.totalNoteCount = node.noteCount + node.children.reduce((sum, c) => sum + finish(c), 0);
    return node.totalNoteCount;
  };
  const accounts: FolderTreeAccount[] = [];
  const addAccount = (name: string, identifier: string | null, folders: FolderTreeNode[]) => {
    folders.sort(compareNodes);
    let noteCount = 0;
    for (const node of folders) {
      const total = finish(node);
      if (node.kind === "folder") noteCount += total;
    }
    accounts.push({ account: name, identifier, noteCount, folders });
  };
  for (const account of scope ? [scope] : context.accounts) {
    addAccount(account.name, account.identifier, roots.get(account.pk) ?? []);
  }
  // Folders whose account is gone surface only when deleted items were asked for.
  const orphans = roots.get(null);
  if (orphans && includeDeleted) addAccount("unknown", null, orphans);
  return { accounts, folderCount: accounts.reduce((sum, a) => sum + countNodes(a.folders), 0) };
}

function countNodes(nodes: FolderTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}
