/**
 * Database-backed listings of pinned notes, Quick Notes, Recently Deleted,
 * and password-protected notes, plus an account-wide native tag inventory.
 *
 * AppleScript exposes none of these sets: it cannot read pin state, the
 * Quick Note flag, or tag objects, and it hides Recently Deleted. They are
 * plain columns and rows in NoteStore, read here with `sqlite3 -readonly`.
 *
 * Detection is version-aware. PRAGMA table_info decides which columns the
 * SQL may name, and a listing whose defining column is absent reports
 * `supported: false` instead of guessing:
 *
 * - pinned: ZISPINNED
 * - quick-notes: ZISSYSTEMPAPER (Quick Notes arrived in macOS 12)
 * - recently-deleted: the note's folder is a trash folder, identified by
 *   ZFOLDERTYPE = 1 or, where that column is missing, a `TrashFolder`
 *   identifier prefix
 * - locked: ZISPASSWORDPROTECTED
 *
 * No body text is read for any listing. The tag inventory decodes bodies only
 * to confirm that each tag object is still referenced by its note.
 *
 * @module utils/noteListings
 */

import { gunzipSync } from "zlib";
import {
  decodeMessage,
  embeddedMessage,
  getField,
  getFields,
  stringValue,
} from "@/utils/protobuf.js";
import {
  accountRef,
  activeNoteSql,
  col,
  coreDataToIso,
  entity,
  folderPaths,
  NOTES_DB_PATH,
  NoteStoreError,
  noteIdFor,
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
} from "@/utils/noteStoreSql.js";
import type {
  NativeTagInventory,
  NativeTagInventoryEntry,
  SpecialNoteKind,
  SpecialNoteRow,
  SpecialNotesResult,
} from "@/types.js";

/** Row caps for `list-special-notes`. */
export const SPECIAL_LIMIT = { DEFAULT: 100, MAX: 1000 } as const;

const HASHTAG_UTI = "com.apple.notes.inlinetextattachment.hashtag";

/** The column that defines each listing; without it the listing is unsupported. */
const KIND_COLUMN: Record<SpecialNoteKind, string[]> = {
  pinned: ["ZISPINNED"],
  "quick-notes": ["ZISSYSTEMPAPER"],
  "recently-deleted": ["ZFOLDERTYPE", "ZIDENTIFIER"],
  locked: ["ZISPASSWORDPROTECTED"],
};

/** Whether this store can answer a listing (any of its defining columns exists). */
export function kindSupported(columns: ReadonlySet<string>, kind: SpecialNoteKind): boolean {
  return KIND_COLUMN[kind].some((name) => columns.has(name));
}

const flag = (columns: ReadonlySet<string>, alias: string, name: string) =>
  columns.has(name) ? `COALESCE(${alias}.${name}, 0)` : "0";

/** The WHERE predicate that selects one listing. */
function kindPredicate(columns: ReadonlySet<string>, kind: SpecialNoteKind): string {
  switch (kind) {
    case "pinned":
      return `${flag(columns, "n", "ZISPINNED")} = 1 AND ${activeNoteSql(columns, "n", "f")}`;
    case "quick-notes":
      return `${flag(columns, "n", "ZISSYSTEMPAPER")} = 1 AND ${activeNoteSql(columns, "n", "f")}`;
    case "recently-deleted":
      return `f.Z_PK IS NOT NULL AND ${trashFolderSql(columns, "f")} AND ${notTombstonedSql(columns, "n")}`;
    case "locked":
      // Deliberately unfiltered by folder or trash: an inventory of what cannot
      // be read is most useful when it also finds the misplaced ones. Rows
      // carry inRecentlyDeleted / markedForDeletion / folder so callers can tell.
      return `${flag(columns, "n", "ZISPASSWORDPROTECTED")} = 1`;
  }
}

/**
 * Joins note alias `n` to its folder `f` and account `a`. A folder's owner is
 * its account; a folderless note falls back to its own account reference.
 */
export function folderAccountJoins(columns: ReadonlySet<string>): string {
  const owner = col(columns, "f", "ZOWNER");
  const account =
    owner === "NULL" ? accountRef(columns, "n") : `COALESCE(${owner}, ${accountRef(columns, "n")})`;
  return (
    `LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER AND f.Z_ENT = ${entity("ICFolder")} ` +
    `LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = ${account} AND a.Z_ENT = ${entity("ICAccount")}`
  );
}

/** FROM clause shared by the listings: note, its folder, and its account. */
function noteFrom(columns: ReadonlySet<string>): string {
  return `FROM ZICCLOUDSYNCINGOBJECT n ${folderAccountJoins(columns)}`;
}

/** Columns every database listing needs. */
const REQUIRED = ["Z_PK", "Z_ENT", "ZFOLDER", "ZTITLE1"];

/**
 * Builds the read transaction for one listing: the total match count, then up
 * to `@limit` rows newest first. Binds `@limit` and, when `scoped`, `@account`.
 * Exported so tests can run the generated SQL against a fixture store.
 */
export function buildSpecialNotesSql(
  columns: ReadonlySet<string>,
  kind: SpecialNoteKind,
  scoped: boolean
): string {
  requireColumns(columns, REQUIRED, "list-special-notes");
  const created =
    ["ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE"]
      .filter((name) => columns.has(name))
      .map((name) => `n.${name}`)
      .join(", ") || "NULL";
  const createdExpr = created.includes(",") ? `COALESCE(${created})` : created;
  const modified = col(columns, "n", "ZMODIFICATIONDATE1");
  const locked = flag(columns, "n", "ZISPASSWORDPROTECTED");
  const where =
    `WHERE n.Z_ENT = ${entity("ICNote")} AND ${kindPredicate(columns, kind)}` +
    (scoped ? " AND a.Z_PK = @account" : "");
  const snippet = `CASE WHEN ${locked} = 1 THEN NULL ELSE ${col(columns, "n", "ZSNIPPET")} END`;
  const hint = kind === "locked" ? col(columns, "n", "ZPASSWORDHINT") : "NULL";
  const row =
    `SELECT json_object('k', 'note', 'pk', n.Z_PK, 'identifier', ${col(columns, "n", "ZIDENTIFIER")}, ` +
    `'title', n.ZTITLE1, 'folder', f.Z_PK, 'account', a.Z_PK, 'created', ${createdExpr}, ` +
    `'modified', ${modified}, 'pinned', ${flag(columns, "n", "ZISPINNED")}, 'locked', ${locked}, ` +
    `'quick', ${flag(columns, "n", "ZISSYSTEMPAPER")}, ` +
    `'trash', f.Z_PK IS NOT NULL AND ${trashFolderSql(columns, "f")}, ` +
    `'tombstoned', NOT ${notTombstonedSql(columns, "n")}, 'snippet', ${snippet}, 'hint', ${hint}) ` +
    `${noteFrom(columns)} ${where} ORDER BY ${modified} DESC, n.Z_PK DESC LIMIT @limit;`;
  return [
    "BEGIN;",
    `SELECT json_object('k', 'total', 'n', COUNT(*)) ${noteFrom(columns)} ${where};`,
    row,
    "COMMIT;",
  ].join(" ");
}

interface RawNoteRow {
  k: "note";
  pk: number;
  identifier: string | null;
  title: string | null;
  folder: number | null;
  account: number | null;
  created: number | null;
  modified: number | null;
  pinned: number;
  locked: number;
  quick: number;
  trash: number;
  tombstoned: number;
  snippet: string | null;
  hint: string | null;
}

/** Options for {@link listSpecialNotes}. */
export interface SpecialNotesOptions {
  kind: SpecialNoteKind;
  account?: string;
  limit?: number;
  /** Fixture database path for tests. */
  dbPath?: string;
}

/** Lists one special set of notes, newest first. Metadata only. */
export function listSpecialNotes(options: SpecialNotesOptions): SpecialNotesResult {
  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? SPECIAL_LIMIT.DEFAULT)),
    SPECIAL_LIMIT.MAX
  );
  const columns = readColumns(dbPath);
  const empty: SpecialNotesResult = {
    kind: options.kind,
    notes: [],
    count: 0,
    total: 0,
    limit,
    supported: false,
  };
  if (!kindSupported(columns, options.kind)) return empty;

  const context = readStoreContext(dbPath, columns);
  const scope = options.account ? resolveAccountName(context.accounts, options.account) : undefined;
  const params: Record<string, BoundValue> = { limit: { int: limit } };
  if (scope) params.account = { int: scope.pk };
  const rows = parseJsonLines<RawNoteRow | { k: "total"; n: number }>(
    runReadOnlySql(dbPath, buildSpecialNotesSql(columns, options.kind, Boolean(scope)), params)
  );

  const paths = folderPaths(context.folders);
  const accountNames = new Map(context.accounts.map((account) => [account.pk, account.name]));
  const notes = rows
    .filter((row): row is RawNoteRow => row.k === "note")
    .map((row) => toSpecialRow(row, context.uuid, paths, accountNames, options.kind));
  return {
    kind: options.kind,
    notes,
    count: notes.length,
    total: rows.find((row) => row.k === "total")?.n ?? notes.length,
    limit,
    supported: true,
    ...(scope ? { account: scope.name } : {}),
  };
}

function toSpecialRow(
  row: RawNoteRow,
  uuid: string,
  paths: Map<number, string>,
  accountNames: Map<number, string>,
  kind: SpecialNoteKind
): SpecialNoteRow {
  const locked = Boolean(row.locked);
  const note: SpecialNoteRow = {
    id: noteIdFor(uuid, row.pk),
    identifier: row.identifier ?? null,
    title: row.title ?? null,
    folder: row.folder !== null ? (paths.get(row.folder) ?? null) : null,
    account: row.account !== null ? (accountNames.get(row.account) ?? null) : null,
    created: coreDataToIso(row.created),
    modified: coreDataToIso(row.modified),
    pinned: Boolean(row.pinned),
    locked,
    quickNote: Boolean(row.quick),
    inRecentlyDeleted: Boolean(row.trash),
    markedForDeletion: Boolean(row.tombstoned),
  };
  if (!locked) note.snippet = row.snippet ?? null;
  if (kind === "locked" && row.hint) note.passwordHint = row.hint;
  return note;
}

/** Exact note id: store UUID and primary key. */
const EXACT_NOTE_ID = /^x-coredata:\/\/([0-9A-F-]+)\/ICNote\/p(\d+)$/i;

/**
 * Whether one exact note is a Quick Note, for the delete-note guard, which
 * must not rest on one. Reads the same ZISSYSTEMPAPER flag as the
 * `quick-notes` listing.
 *
 * @returns the flag, or null when this store has no row for the note yet
 *   (Notes.app can save a new note to the database some time after
 *   AppleScript already sees it). A store without the column predates Quick
 *   Notes, so every note it has is ordinary.
 * @throws NoteStoreError `no_fda` without Full Disk Access, `invalid_input`
 *   for an id that is not an exact note id of this store
 */
export function quickNoteFlag(noteId: string, dbPath: string = NOTES_DB_PATH): boolean | null {
  const match = EXACT_NOTE_ID.exec(noteId);
  if (!match) throw new NoteStoreError(`Not an exact note id: ${noteId}`, "invalid_input");
  const columns = readColumns(dbPath);
  const sql =
    "SELECT json_object('uuid', (SELECT Z_UUID FROM Z_METADATA LIMIT 1), 'quick', " +
    `(SELECT ${flag(columns, "n", "ZISSYSTEMPAPER")} FROM ZICCLOUDSYNCINGOBJECT n ` +
    `WHERE n.Z_PK = @pk AND n.Z_ENT = ${entity("ICNote")}));`;
  const [row] = parseJsonLines<{ uuid: string | null; quick: number | null }>(
    runReadOnlySql(dbPath, sql, { pk: { int: Number(match[2]) } })
  );
  if (row?.uuid?.toUpperCase() !== match[1].toUpperCase()) {
    throw new NoteStoreError(
      `Note id ${noteId} belongs to a different Notes database.`,
      "invalid_input"
    );
  }
  return row.quick === null ? null : row.quick === 1;
}

// -----------------------------------------------------------------------------
// Account-wide native tag inventory
// -----------------------------------------------------------------------------

const TAG_REQUIRED = ["Z_PK", "Z_ENT", "ZFOLDER", "ZNOTE1", "ZTYPEUTI1", "ZALTTEXT", "ZIDENTIFIER"];

/**
 * Builds the read transaction for the tag inventory: tag objects (ICHashtag),
 * tag uses (inline hashtag attachments in active notes), and the bodies of the
 * notes that use them. Binds `@account` when `scoped`.
 */
export function buildTagInventorySql(columns: ReadonlySet<string>, scoped: boolean): string {
  requireColumns(columns, TAG_REQUIRED, "list-native-tags");
  const accountFilter = scoped ? " AND a.Z_PK = @account" : "";
  const uses =
    `FROM ZICCLOUDSYNCINGOBJECT i JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = i.ZNOTE1 AND n.Z_ENT = ${entity("ICNote")} ` +
    `${folderAccountJoins(columns)} ` +
    `WHERE i.ZTYPEUTI1 = '${HASHTAG_UTI}' AND ${notTombstonedSql(columns, "i")} ` +
    `AND ${activeNoteSql(columns, "n", "f")}${accountFilter}`;
  const tagAccount = accountRef(columns, "t");
  const display = ["ZDISPLAYTEXT", "ZSTANDARDIZEDCONTENT", "ZNAME"]
    .filter((name) => columns.has(name))
    .map((name) => `t.${name}`);
  const displayExpr = display.length > 1 ? `COALESCE(${display.join(", ")})` : display[0] || "NULL";
  return [
    "BEGIN;",
    `SELECT json_object('k', 'tag', 'text', ${displayExpr}, 'account', ta.Z_PK) ` +
      `FROM ZICCLOUDSYNCINGOBJECT t LEFT JOIN ZICCLOUDSYNCINGOBJECT ta ON ta.Z_PK = ${tagAccount} ` +
      `AND ta.Z_ENT = ${entity("ICAccount")} WHERE t.Z_ENT = ${entity("ICHashtag")} ` +
      `AND ${notTombstonedSql(columns, "t")}${scoped ? " AND ta.Z_PK = @account" : ""};`,
    `SELECT json_object('k', 'use', 'note', n.Z_PK, 'object', i.ZIDENTIFIER, 'text', i.ZALTTEXT, ` +
      `'account', a.Z_PK, 'locked', ${flag(columns, "n", "ZISPASSWORDPROTECTED")}) ${uses};`,
    `SELECT json_object('k', 'body', 'note', b.Z_PK, 'data', ` +
      `(SELECT hex(d.ZDATA) FROM ZICNOTEDATA d WHERE d.ZNOTE = b.Z_PK ORDER BY d.Z_PK DESC LIMIT 1)) ` +
      `FROM ZICCLOUDSYNCINGOBJECT b WHERE b.Z_PK IN (SELECT n.Z_PK ${uses}) ` +
      `AND ${flag(columns, "b", "ZISPASSWORDPROTECTED")} = 0;`,
    "COMMIT;",
  ].join(" ");
}

export type TagRow =
  | { k: "tag"; text: string | null; account: number | null }
  | {
      k: "use";
      note: number;
      object: string | null;
      text: string | null;
      account: number | null;
      locked: number;
    }
  | { k: "body"; note: number; data: string | null };

/** Tag text as list-native-tags reports it: no leading `#`. */
const bareTag = (text: string) => text.replace(/^#/, "").trim();

/**
 * The inline object ids a note body still references, or null when the body
 * cannot be decoded (then its tag objects are counted unverified).
 */
export function referencedObjects(hex: string | null): Set<string> | null {
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  try {
    const data = gunzipSync(Buffer.from(hex, "hex"), { maxOutputLength: 32 * 1024 * 1024 });
    // Document.2 → Note.3; attribute runs are Note.5, attachments run field 12.
    const wrapper = embeddedMessage(getField(decodeMessage(data), 2));
    const body = wrapper && embeddedMessage(getField(wrapper, 3));
    if (!body) return null;
    const ids = new Set<string>();
    for (const run of getFields(body, 5)) {
      const attachment = embeddedMessage(getField(embeddedMessage(run) ?? [], 12));
      const id = attachment && stringValue(getField(attachment, 1));
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}

/** Options for {@link nativeTagInventory}. */
export interface TagInventoryOptions {
  account?: string;
  /** Fixture database path for tests. */
  dbPath?: string;
}

/**
 * Account-wide native tag inventory with per-tag note counts. A tag counts
 * for a note only while the note's body still references the tag object;
 * notes whose body cannot be decoded (locked ones, for example) are counted
 * from the tag objects alone and reported through `unverifiedNotes`.
 */
export function nativeTagInventory(options: TagInventoryOptions = {}): NativeTagInventory {
  const dbPath = options.dbPath ?? NOTES_DB_PATH;
  const columns = readColumns(dbPath);
  const context = readStoreContext(dbPath, columns);
  const scope = options.account ? resolveAccountName(context.accounts, options.account) : undefined;
  const rows = parseJsonLines<TagRow>(
    runReadOnlySql(
      dbPath,
      buildTagInventorySql(columns, Boolean(scope)),
      scope ? { account: { int: scope.pk } } : {}
    )
  );
  return assembleInventory(rows, context.accounts, scope);
}

/** Groups tag rows into inventory entries. Exported for unit tests. */
export function assembleInventory(
  rows: TagRow[],
  accounts: StoreAccount[],
  scope?: StoreAccount
): NativeTagInventory {
  const accountNames = new Map(accounts.map((account) => [account.pk, account.name]));
  const bodies = new Map<number, Set<string> | null>();
  for (const row of rows) if (row.k === "body") bodies.set(row.note, referencedObjects(row.data));

  interface Group {
    spellings: Map<string, number>;
    notes: Map<number, number | null>;
  }
  const groups = new Map<string, Group>();
  // weight 0 registers a tag object's spelling without counting a use.
  const group = (text: string, weight: number): Group => {
    const key = text.toLocaleLowerCase();
    let found = groups.get(key);
    if (!found) groups.set(key, (found = { spellings: new Map(), notes: new Map() }));
    found.spellings.set(text, (found.spellings.get(text) ?? 0) + weight);
    return found;
  };

  const unverified = new Set<number>();
  for (const row of rows) {
    if (row.k === "tag" && row.text && bareTag(row.text)) group(bareTag(row.text), 0);
    if (row.k !== "use" || !row.text || !bareTag(row.text)) continue;
    const referenced = row.locked ? null : (bodies.get(row.note) ?? null);
    if (referenced && !(row.object && referenced.has(row.object))) continue; // stale tag object
    if (!referenced) unverified.add(row.note);
    group(bareTag(row.text), 1).notes.set(row.note, row.account);
  }

  const inventory: NativeTagInventoryEntry[] = [...groups.values()].map((entry) => {
    const spellings = [...entry.spellings.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    const perAccount: Record<string, number> = {};
    for (const accountPk of entry.notes.values()) {
      const name = (accountPk !== null && accountNames.get(accountPk)) || "unknown";
      perAccount[name] = (perAccount[name] ?? 0) + 1;
    }
    const result: NativeTagInventoryEntry = {
      tag: spellings[0][0],
      noteCount: entry.notes.size,
      accounts: perAccount,
    };
    if (spellings.length > 1) result.spellings = spellings.slice(1).map(([text]) => text);
    return result;
  });
  inventory.sort((a, b) => b.noteCount - a.noteCount || a.tag.localeCompare(b.tag));
  return {
    inventory,
    tagCount: inventory.length,
    complete: unverified.size === 0,
    unverifiedNotes: unverified.size,
    ...(scope ? { account: scope.name } : {}),
  };
}
