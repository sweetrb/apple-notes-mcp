/**
 * Read-only link inventory across one note, a folder, an account, or the
 * whole library, for `list-note-links`.
 *
 * Link cards and native note/section chips live in their own database rows,
 * so listing them is one query. Inline hyperlinks live inside note bodies, so
 * they are listed only when requested (always for a single note): every body
 * in scope is then decompressed and decoded, in batches.
 *
 * Folder paths, account matching and the active-note scope are the shared
 * ones in noteStoreSql.ts, so a folder path here is the one list-folders
 * prints and an account name resolves as it does in the other tools. Folder
 * and account names are matched in JavaScript; only integer keys are bound
 * into SQL.
 *
 * @module utils/noteLinkInventory
 */

import { dirname } from "node:path";
import { splitFolderPath } from "@/services/appleNotesManager.js";
import {
  listPreviewEntries,
  parseNoteId,
  previewPaths,
  resolveAccountDir,
} from "./attachmentAssets.js";
import { decodeCompressedNoteBlocks, type NoteBlocksDocument } from "./noteBlocks.js";
import {
  cardLink,
  inlineLinks,
  nativeLink,
  NOTE_LINK_UTI,
  type LinkKind,
  type NoteLinkEntry,
} from "./noteLinks.js";
import { folderAccountJoins } from "./noteListings.js";
import {
  activeNoteSql,
  col,
  coreDataToIso,
  entity,
  folderPaths,
  noteIdFor,
  NOTES_DB_PATH,
  NoteStoreError,
  notTombstonedSql,
  parseJsonLines,
  readColumns,
  readStoreContext,
  requireColumns,
  resolveAccountName,
  runReadOnlySql,
  type BoundValue,
  type StoreFolder,
} from "./noteStoreSql.js";

const BODY_BATCH = 100;

/** One link with the note, folder and account it came from. */
export interface InventoryLink extends NoteLinkEntry {
  noteId: string;
  noteIdentifier: string | null;
  noteTitle: string | null;
  noteModified: string | null;
  folder: string | null;
  folderPath: string | null;
  account: string | null;
  accountIdentifier: string | null;
}

/** Options for {@link listNoteLinks}. Give at most one of `id` or a scope. */
export interface LinkInventoryOptions {
  /** One exact note (canonical x-coredata id). Inline links are always included. */
  id?: string;
  /** Account name: exact (case-insensitive) or a unique prefix, as in the other tools. */
  account?: string;
  /** Folder name or path as list-folders prints it (`Work/Clients`, `\/` for a literal slash). */
  folder?: string;
  /** With `folder`, also list notes in its subfolders (default true). */
  includeSubfolders?: boolean;
  /** Decode bodies for inline hyperlinks (slower). Defaults to true for `id`. */
  includeInline?: boolean;
  /** Only these kinds. */
  kinds?: LinkKind[];
  offset?: number;
  limit?: number;
  /** Stop a page early once its links would exceed this many JSON bytes. */
  maxBytes?: number;
  dbPath?: string;
}

/** Result of {@link listNoteLinks}. */
export interface LinkInventory {
  scope: {
    note?: string;
    account?: string;
    accountIdentifier?: string | null;
    folder?: string | null;
    folderPath?: string;
    includeSubfolders?: boolean;
  };
  inlineIncluded: boolean;
  notesInScope: number;
  /** Notes whose body could not be decoded (locked, empty, malformed) when inline was requested. */
  notesWithoutBody: number;
  counts: Record<LinkKind, number>;
  links: InventoryLink[];
  page: { offset: number; returned: number; total: number; hasMore: boolean; nextOffset?: number };
}

type InventoryRow =
  | {
      k: "note";
      pk: number;
      identifier: string | null;
      title: string | null;
      folder: number | null;
      account: number | null;
      modified: number | null;
    }
  | {
      k: "card";
      pk: number;
      note: number;
      identifier: string | null;
      url: string;
      title: string | null;
    }
  | {
      k: "chip";
      note: number;
      identifier: string | null;
      token: string | null;
      alt: string | null;
    };

/**
 * Find one folder, optionally within one account, among live folders. A
 * single name matches a folder with that name at any depth; a path
 * (`Work/Clients`) matches from the top level, split with list-folders' own
 * rules. A name containing a literal `/` also matches unescaped. Throws when
 * nothing matches or several folders do (the error lists their paths).
 */
export function matchFolder(
  folders: StoreFolder[],
  wanted: string,
  account?: number
): { folder: StoreFolder; path: string } {
  const paths = folderPaths(folders);
  const segments = splitFolderPath(wanted);
  const key = (parts: string[]) => parts.join("\u0000");
  const pool = folders.filter(
    (f) => !f.tombstoned && !f.trash && (account === undefined || f.account === account)
  );
  const byPath =
    segments.length === 1
      ? pool.filter((f) => f.name === segments[0])
      : pool.filter((f) => key(splitFolderPath(paths.get(f.pk)!)) === key(segments));
  const matches = byPath.length ? byPath : pool.filter((f) => f.name === wanted);
  if (!matches.length) throw new NoteStoreError(`No folder matches "${wanted}".`, "invalid_input");
  if (matches.length > 1)
    throw new NoteStoreError(
      `Folder "${wanted}" is ambiguous; use one of these paths: ${matches
        .map((f) => paths.get(f.pk))
        .join(", ")}.`,
      "invalid_input"
    );
  return { folder: matches[0], path: paths.get(matches[0].pk)! };
}

/**
 * The read-only SQL for one inventory, one JSON object per line tagged with
 * `k`. Bound integers: `@note`, `@account`, `@folder` (0 = no filter),
 * `@subfolders` (0 = the folder only) and, for the body batches, `@after`.
 */
export function inventorySql(columns: ReadonlySet<string>) {
  requireColumns(columns, ["ZFOLDER"], "list-note-links");
  const c = (alias: string, name: string) => col(columns, alias, name);
  // The folder and, unless @subfolders is 0, every folder below it.
  const subtree = columns.has("ZPARENT")
    ? `WITH RECURSIVE sub(pk) AS (SELECT @folder UNION
         SELECT x.Z_PK FROM ZICCLOUDSYNCINGOBJECT x JOIN sub ON x.ZPARENT = sub.pk
         WHERE @subfolders <> 0 AND x.Z_ENT = ${entity("ICFolder")})
       SELECT pk FROM sub`
    : "SELECT @folder";
  // A single requested note is listed wherever it is; a scope covers only
  // notes Notes.app shows outside Recently Deleted (activeNoteSql).
  const scopeWhere = `n.Z_ENT = ${entity("ICNote")} AND (
      (@note <> 0 AND n.Z_PK = @note) OR
      (@note = 0 AND ${activeNoteSql(columns, "n", "f")}
        AND (@account = 0 OR a.Z_PK = @account)
        AND (@folder = 0 OR n.ZFOLDER IN (${subtree}))))`;
  const scope = `SELECT n.Z_PK FROM ZICCLOUDSYNCINGOBJECT n ${folderAccountJoins(columns)} WHERE ${scopeWhere}`;
  return {
    rows: [
      "BEGIN;",
      `SELECT json_object('k', 'note', 'pk', n.Z_PK, 'identifier', ${c("n", "ZIDENTIFIER")},
        'title', ${c("n", "ZTITLE1")}, 'folder', n.ZFOLDER, 'account', a.Z_PK,
        'modified', ${c("n", "ZMODIFICATIONDATE1")})
      FROM ZICCLOUDSYNCINGOBJECT n ${folderAccountJoins(columns)} WHERE ${scopeWhere};`,
      `SELECT json_object('k', 'card', 'pk', att.Z_PK, 'note', ${c("att", "ZNOTE")},
        'identifier', ${c("att", "ZIDENTIFIER")}, 'url', ${c("att", "ZURLSTRING")},
        'title', ${c("att", "ZTITLE")})
      FROM ZICCLOUDSYNCINGOBJECT att
      WHERE att.Z_ENT = ${entity("ICAttachment")} AND ${notTombstonedSql(columns, "att")}
        AND ${c("att", "ZTYPEUTI")} LIKE 'public.url%' AND ${c("att", "ZURLSTRING")} IS NOT NULL
        AND ${c("att", "ZNOTE")} IN (${scope});`,
      `SELECT json_object('k', 'chip', 'note', ${c("i", "ZNOTE1")},
        'identifier', ${c("i", "ZIDENTIFIER")}, 'token', ${c("i", "ZTOKENCONTENTIDENTIFIER")},
        'alt', ${c("i", "ZALTTEXT")})
      FROM ZICCLOUDSYNCINGOBJECT i
      WHERE i.Z_ENT = ${entity("ICInlineAttachment")} AND ${notTombstonedSql(columns, "i")}
        AND ${c("i", "ZTYPEUTI1")} = '${NOTE_LINK_UTI}' AND ${c("i", "ZNOTE1")} IN (${scope});`,
      "COMMIT;",
    ].join("\n"),
    bodies: `SELECT json_object('note', d.ZNOTE, 'data', hex(d.ZDATA),
        'encrypted', d.ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL)
      FROM ZICNOTEDATA d WHERE d.ZNOTE IN (${scope}) AND d.ZNOTE > @after
      ORDER BY d.ZNOTE LIMIT ${BODY_BATCH};`,
  };
}

/**
 * Decode every body in scope, one batch of rows at a time. Locked, empty and
 * malformed bodies are skipped; the caller counts them as notes without a body.
 *
 * The batches are separate reads from the note rows, so a note created or
 * moved into scope in between can appear here without a note row. Only notes
 * in `notes` (the pks the note rows returned) are decoded.
 */
function decodeBodies(
  dbPath: string,
  sql: string,
  params: Record<string, BoundValue>,
  notes: ReadonlySet<number>
): Map<number, NoteBlocksDocument> {
  const docs = new Map<number, NoteBlocksDocument>();
  let after = 0;
  for (;;) {
    const rows = parseJsonLines<{ note: number; data: string | null; encrypted: number }>(
      runReadOnlySql(dbPath, sql, { ...params, after: { int: after } })
    );
    for (const row of rows) {
      after = Math.max(after, row.note);
      if (row.encrypted || !row.data || !notes.has(row.note)) continue;
      try {
        docs.set(row.note, decodeCompressedNoteBlocks(Buffer.from(row.data, "hex")));
      } catch {
        // Counted through notesWithoutBody.
      }
    }
    if (rows.length < BODY_BATCH) return docs;
  }
}

const KIND_ORDER: Record<LinkKind, number> = { inline: 0, card: 1, note: 2, section: 3 };

/** List links in one note or across a scope. See {@link LinkInventoryOptions}. */
export function listNoteLinks(options: LinkInventoryOptions = {}): LinkInventory {
  const { dbPath = NOTES_DB_PATH, offset = 0, limit = 200, maxBytes = 4 * 1024 * 1024 } = options;
  if (options.id && (options.account || options.folder))
    throw new NoteStoreError("Pass either id or account/folder, not both.", "invalid_input");
  const notePk = options.id ? parseNoteId(options.id).pk : 0;
  const columns = readColumns(dbPath);
  const sql = inventorySql(columns);
  const context = readStoreContext(dbPath, columns);
  const paths = folderPaths(context.folders);

  const scope: LinkInventory["scope"] = {};
  let accountPk = 0;
  let folderPk = 0;
  const includeSubfolders = options.includeSubfolders ?? true;
  if (options.account) {
    const account = resolveAccountName(context.accounts, options.account);
    accountPk = account.pk;
    scope.account = account.name;
    scope.accountIdentifier = account.identifier;
  }
  if (options.folder) {
    const { folder, path } = matchFolder(context.folders, options.folder, accountPk || undefined);
    folderPk = folder.pk;
    scope.folder = folder.name;
    scope.folderPath = path;
    scope.includeSubfolders = includeSubfolders;
  }
  if (options.id) scope.note = options.id;
  const params: Record<string, BoundValue> = {
    note: { int: notePk },
    account: { int: accountPk },
    folder: { int: folderPk },
    subfolders: { int: includeSubfolders ? 1 : 0 },
  };

  const rows = parseJsonLines<InventoryRow>(runReadOnlySql(dbPath, sql.rows, params));
  const notes = rows.filter((row) => row.k === "note");
  if (options.id && !notes.length)
    throw new NoteStoreError(`No note found for ID "${options.id}".`, "invalid_input");
  const includeInline = options.includeInline ?? Boolean(options.id);
  const docs = includeInline
    ? decodeBodies(dbPath, sql.bodies, params, new Set(notes.map((note) => note.pk)))
    : new Map<number, NoteBlocksDocument>();

  const noteById = new Map(notes.map((note) => [note.pk, note]));
  const accountById = new Map(context.accounts.map((account) => [account.pk, account]));
  const folderById = new Map(context.folders.map((folder) => [folder.pk, folder]));
  const source = (pk: number) => {
    const note = noteById.get(pk)!;
    const account = accountById.get(note.account ?? -1);
    const folder = folderById.get(note.folder ?? -1);
    return {
      noteId: noteIdFor(context.uuid, pk),
      noteIdentifier: note.identifier,
      noteTitle: note.title,
      noteModified: coreDataToIso(note.modified),
      folder: folder?.name ?? null,
      folderPath: folder ? paths.get(folder.pk)! : null,
      account: account?.name ?? null,
      accountIdentifier: account?.identifier ?? null,
    };
  };

  // Card thumbnails resolve exactly as list-attachments resolves previews.
  const containerDir = dirname(dbPath);
  const previewEntries = new Map<string, string[]>();
  const previewFor = (identifier: string | null, account: string | null): string | null => {
    const accountDir = identifier ? resolveAccountDir(containerDir, account) : null;
    if (!accountDir || !identifier) return null;
    if (!previewEntries.has(accountDir))
      previewEntries.set(accountDir, listPreviewEntries(accountDir));
    return previewPaths(accountDir, identifier, previewEntries.get(accountDir)!)[0] ?? null;
  };

  const all: Array<{ pk: number; link: InventoryLink }> = [];
  const add = (pk: number, link: NoteLinkEntry) =>
    all.push({ pk, link: { ...link, ...source(pk) } });
  for (const [pk, doc] of docs) for (const link of inlineLinks(doc)) add(pk, link);
  for (const row of rows) {
    if (row.k === "card") {
      const noteId = noteIdFor(context.uuid, row.note);
      const link = cardLink(
        { pk: row.pk, identifier: row.identifier ?? "", url: row.url, title: row.title },
        {
          doc: docs.get(row.note),
          noteId,
          previewPath: previewFor(row.identifier, source(row.note).accountIdentifier),
        }
      );
      if (link) add(row.note, link);
    } else if (row.k === "chip") {
      const link = nativeLink(
        { identifier: row.identifier ?? "", token: row.token, alt: row.alt },
        docs.get(row.note)
      );
      if (link) add(row.note, link);
    }
  }

  const wanted = options.kinds?.length ? new Set(options.kinds) : undefined;
  const links = all
    .filter(({ link }) => !wanted || wanted.has(link.kind))
    .sort(
      (a, b) =>
        (b.link.noteModified ?? "").localeCompare(a.link.noteModified ?? "") ||
        a.pk - b.pk ||
        (a.link.start ?? Number.MAX_SAFE_INTEGER) - (b.link.start ?? Number.MAX_SAFE_INTEGER) ||
        KIND_ORDER[a.link.kind] - KIND_ORDER[b.link.kind]
    )
    .map(({ link }) => link);
  const counts: Record<LinkKind, number> = { inline: 0, card: 0, note: 0, section: 0 };
  for (const link of links) counts[link.kind]++;

  const start = Math.min(Math.max(0, offset), links.length);
  const page: InventoryLink[] = [];
  let bytes = 0;
  for (let i = start; i < links.length && page.length < limit; i++) {
    const size = Buffer.byteLength(JSON.stringify(links[i]));
    if (page.length && bytes + size > maxBytes) break;
    page.push(links[i]);
    bytes += size;
  }
  const next = start + page.length;
  return {
    scope,
    inlineIncluded: includeInline,
    notesInScope: notes.length,
    notesWithoutBody: includeInline ? notes.length - docs.size : 0,
    counts,
    links: page,
    page: {
      offset: start,
      returned: page.length,
      total: links.length,
      hasMore: next < links.length,
      ...(next < links.length ? { nextOffset: next } : {}),
    },
  };
}

/** One-line text summary for the tool response. */
export function describeLinkInventory(result: LinkInventory): string {
  const { counts, page } = result;
  return (
    `Found ${page.total} links in ${result.notesInScope} notes (inline ${counts.inline}` +
    `${result.inlineIncluded ? "" : " not scanned"}, card ${counts.card}, note ${counts.note}, section ${counts.section}); ` +
    `returned ${page.returned} from offset ${page.offset}` +
    (page.hasMore ? `; more at offset ${page.nextOffset}` : "") +
    "."
  );
}
