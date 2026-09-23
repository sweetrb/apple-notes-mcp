/**
 * Read-only link inventory across one note, a folder, an account, or the
 * whole library, for `list-note-links`.
 *
 * Link cards and native note/section chips live in their own database rows,
 * so listing them is one query. Inline hyperlinks live inside note bodies, so
 * they are listed only when requested (always for a single note): every body
 * in scope is then decompressed and decoded, in batches.
 *
 * Folder and account names are matched in JavaScript; only integer primary
 * keys are ever bound into SQL.
 *
 * @module utils/noteLinkInventory
 */

import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { decodeCompressedNoteBlocks, type NoteBlocksDocument } from "./noteBlocks.js";
import {
  cardLink,
  inlineLinks,
  nativeLink,
  NOTE_LINK_UTI,
  resolvePreviewPath,
  type LinkKind,
  type NoteLinkEntry,
  type PreviewRow,
} from "./noteLinks.js";
import {
  entity,
  NOTES_DB_PATH,
  NoteStoreError,
  notePrimaryKey,
  objectColumns,
  parseJsonLine,
  runStoreSql,
  schemaHelpers,
} from "./noteStoreSql.js";

const APPLE_EPOCH_OFFSET = 978307200;
const BODY_BATCH = 100;

/** One link with the note, folder and account it came from. */
export interface InventoryLink extends NoteLinkEntry {
  noteId: string | null;
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
  /** One exact note (x-coredata id). Inline links are always included. */
  id?: string;
  /** Account name (case-insensitive) or account identifier. */
  account?: string;
  /** Folder name or path (`Work/Clients`, `\/` for a literal slash). */
  folder?: string;
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
    account?: string | null;
    accountIdentifier?: string | null;
    folder?: string | null;
    folderPath?: string | null;
  };
  inlineIncluded: boolean;
  notesInScope: number;
  /** Notes whose body could not be decoded (locked, empty, malformed) when inline was requested. */
  notesWithoutBody: number;
  counts: Record<LinkKind, number>;
  links: InventoryLink[];
  page: { offset: number; returned: number; total: number; hasMore: boolean; nextOffset?: number };
}

interface FolderRow {
  pk: number;
  title: string | null;
  parent: number | null;
  account: number | null;
  type: number | null;
}
interface AccountRow {
  pk: number;
  name: string | null;
  identifier: string | null;
}
interface NoteRow {
  pk: number;
  identifier: string | null;
  title: string | null;
  folder: number | null;
  account: number | null;
  modified: number | null;
}

/** Split a folder path on unescaped `/`, unescaping `\/` in each segment. */
export function splitFolderPath(path: string): string[] {
  return path
    .split(/(?<!\\)\//)
    .map((segment) => segment.replace(/\\\//g, "/"))
    .filter((segment) => segment !== "");
}

/** Full `/`-joined path of every folder, with `/` inside a name escaped as `\/`. */
export function folderPaths(folders: FolderRow[]): Map<number, string> {
  const byPk = new Map(folders.map((f) => [f.pk, f]));
  const paths = new Map<number, string>();
  for (const folder of folders) {
    const parts: string[] = [];
    const seen = new Set<number>();
    for (
      let f: FolderRow | undefined = folder;
      f && !seen.has(f.pk);
      f = byPk.get(f.parent ?? -1)
    ) {
      seen.add(f.pk);
      parts.unshift((f.title ?? "").replace(/\//g, "\\/"));
    }
    paths.set(folder.pk, parts.join("/"));
  }
  return paths;
}

/**
 * Find one folder, optionally within one account. A single name matches a
 * folder with that name at any depth; a path (`Work/Clients`) matches from
 * the top level. A name containing a literal `/` also matches unescaped.
 * Throws `not-found` when nothing matches and `invalid-argument` when several
 * folders match (the error lists their paths).
 */
export function matchFolder(
  folders: FolderRow[],
  wanted: string,
  account?: number
): { pk: number; path: string } {
  const paths = folderPaths(folders);
  const segments = splitFolderPath(wanted);
  const pool = folders.filter((f) => account === undefined || f.account === account);
  const byPath =
    segments.length === 1
      ? pool.filter((f) => f.title === segments[0])
      : pool.filter(
          (f) => splitFolderPath(paths.get(f.pk)!).join("\u0000") === segments.join("\u0000")
        );
  const matches = byPath.length ? byPath : pool.filter((f) => f.title === wanted);
  if (!matches.length) throw new NoteStoreError("not-found", `No folder matches "${wanted}"`);
  if (matches.length > 1)
    throw new NoteStoreError(
      "invalid-argument",
      `Folder "${wanted}" is ambiguous; use one of these paths: ${matches
        .map((f) => paths.get(f.pk))
        .join(", ")}`
    );
  return { pk: matches[0].pk, path: paths.get(matches[0].pk)! };
}

/** Find one account by identifier or case-insensitive name. */
export function matchAccount(accounts: AccountRow[], wanted: string): AccountRow {
  const byId = accounts.filter((a) => a.identifier === wanted);
  const matches = byId.length
    ? byId
    : accounts.filter((a) => (a.name ?? "").toLowerCase() === wanted.toLowerCase());
  if (!matches.length) throw new NoteStoreError("not-found", `No account matches "${wanted}"`);
  if (matches.length > 1)
    throw new NoteStoreError(
      "invalid-argument",
      `Account "${wanted}" is ambiguous; pass its identifier instead`
    );
  return matches[0];
}

/**
 * The read-only SQL for one inventory. Bound integers: `@note`, `@account`,
 * `@folder` (0 = no filter) and, for the body batches, `@after`.
 */
export function inventorySql(columns: Set<string>) {
  const { col, accountOf, notDeleted } = schemaHelpers(columns);
  // A single requested note is listed wherever it is; a scope skips
  // folderless notes and Recently Deleted, which Notes does not show there.
  const scope = `SELECT n.Z_PK FROM ZICCLOUDSYNCINGOBJECT n
    LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = ${col("n", "ZFOLDER")}
    WHERE n.Z_ENT = ${entity("ICNote")} AND (
      (@note <> 0 AND n.Z_PK = @note) OR
      (@note = 0 AND ${notDeleted("n")} AND ${col("n", "ZFOLDER")} IS NOT NULL
        AND ${notDeleted("f")} AND COALESCE(${col("f", "ZFOLDERTYPE")}, 0) <> 1
        AND (@account = 0 OR ${accountOf("n")} = @account)
        AND (@folder = 0 OR ${col("n", "ZFOLDER")} = @folder)))`;
  const cards = `SELECT att.Z_PK FROM ZICCLOUDSYNCINGOBJECT att
    WHERE att.Z_ENT = ${entity("ICAttachment")} AND ${notDeleted("att")}
      AND ${col("att", "ZURLSTRING")} IS NOT NULL AND att.ZNOTE IN (${scope})`;
  return {
    folders: `SELECT json_group_array(json_object('pk', Z_PK, 'title', ${col("x", "ZTITLE2")},
        'parent', ${col("x", "ZPARENT")}, 'account', ${accountOf("x")}, 'type', ${col("x", "ZFOLDERTYPE")}))
      FROM ZICCLOUDSYNCINGOBJECT x WHERE x.Z_ENT = ${entity("ICFolder")} AND ${notDeleted("x")};
      SELECT json_group_array(json_object('pk', Z_PK, 'name', ${col("x", "ZNAME")}, 'identifier', ${col("x", "ZIDENTIFIER")}))
      FROM ZICCLOUDSYNCINGOBJECT x WHERE x.Z_ENT = ${entity("ICAccount")};
      SELECT json_object('uuid', (SELECT Z_UUID FROM Z_METADATA LIMIT 1));`,
    rows: `SELECT json_group_array(json_object('pk', n.Z_PK, 'identifier', ${col("n", "ZIDENTIFIER")},
        'title', ${col("n", "ZTITLE1")}, 'folder', ${col("n", "ZFOLDER")}, 'account', ${accountOf("n")},
        'modified', ${col("n", "ZMODIFICATIONDATE1")}))
      FROM ZICCLOUDSYNCINGOBJECT n WHERE n.Z_PK IN (${scope});
      SELECT json_group_array(json_object('pk', att.Z_PK, 'note', att.ZNOTE,
        'identifier', ${col("att", "ZIDENTIFIER")}, 'url', ${col("att", "ZURLSTRING")},
        'title', ${col("att", "ZTITLE")}, 'account', ${col("acc", "ZIDENTIFIER")}))
      FROM ZICCLOUDSYNCINGOBJECT att LEFT JOIN ZICCLOUDSYNCINGOBJECT acc ON acc.Z_PK = ${accountOf("att")}
      WHERE att.Z_PK IN (${cards});
      SELECT json_group_array(json_object('attachment', ${col("p", "ZATTACHMENT")},
        'identifier', ${col("p", "ZIDENTIFIER")}, 'width', ${col("p", "ZWIDTH")},
        'height', ${col("p", "ZHEIGHT")}, 'scale', ${col("p", "ZSCALE")},
        'appearance', ${col("p", "ZAPPEARANCETYPE")}))
      FROM ZICCLOUDSYNCINGOBJECT p
      WHERE p.Z_ENT = ${entity("ICAttachmentPreviewImage")} AND ${notDeleted("p")}
        AND ${col("p", "ZATTACHMENT")} IN (${cards});
      SELECT json_group_array(json_object('note', ${col("i", "ZNOTE1")},
        'identifier', ${col("i", "ZIDENTIFIER")}, 'token', ${col("i", "ZTOKENCONTENTIDENTIFIER")},
        'alt', ${col("i", "ZALTTEXT")}))
      FROM ZICCLOUDSYNCINGOBJECT i
      WHERE i.Z_ENT = ${entity("ICInlineAttachment")} AND ${notDeleted("i")}
        AND ${col("i", "ZTYPEUTI1")} = '${NOTE_LINK_UTI}' AND ${col("i", "ZNOTE1")} IN (${scope});`,
    bodies: `SELECT json_object('note', d.ZNOTE, 'data', hex(d.ZDATA),
        'encrypted', d.ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL)
      FROM ZICNOTEDATA d WHERE d.ZNOTE IN (${scope}) AND d.ZNOTE > @after
      ORDER BY d.ZNOTE LIMIT ${BODY_BATCH};`,
  };
}

/**
 * Decode every body in scope, one batch of rows at a time. Locked, empty and
 * malformed bodies are skipped; the caller counts them as notes without a body.
 */
function decodeBodies(
  dbPath: string,
  sql: string,
  params: Record<string, number>
): Map<number, NoteBlocksDocument> {
  const docs = new Map<number, NoteBlocksDocument>();
  let after = 0;
  for (;;) {
    const lines = runStoreSql(dbPath, sql, { ...params, after });
    for (const line of lines) {
      const row = parseJsonLine<{ note: number; data: string | null; encrypted: number }>(line, {
        note: 0,
        data: null,
        encrypted: 0,
      });
      after = Math.max(after, row.note);
      if (row.encrypted || !row.data) continue;
      try {
        docs.set(row.note, decodeCompressedNoteBlocks(Buffer.from(row.data, "hex")));
      } catch {
        // Counted through notesWithoutBody.
      }
    }
    if (lines.length < BODY_BATCH) return docs;
  }
}

const KIND_ORDER: Record<LinkKind, number> = { inline: 0, card: 1, note: 2, section: 3 };

/** List links in one note or across a scope. See {@link LinkInventoryOptions}. */
export function listNoteLinks(options: LinkInventoryOptions = {}): LinkInventory {
  const { dbPath = NOTES_DB_PATH, offset = 0, limit = 200, maxBytes = 4 * 1024 * 1024 } = options;
  if (options.id && (options.account || options.folder))
    throw new NoteStoreError("invalid-argument", "Pass either id or account/folder, not both");
  const notePk = options.id ? notePrimaryKey(options.id) : 0;
  if (!existsSync(dbPath))
    throw new NoteStoreError("no-full-disk-access", "The Notes database is not readable");
  const columns = objectColumns(dbPath);
  const sql = inventorySql(columns);

  const [folderLine, accountLine, storeLine] = runStoreSql(dbPath, sql.folders);
  const folders = parseJsonLine<FolderRow[]>(folderLine, []);
  const accounts = parseJsonLine<AccountRow[]>(accountLine, []);
  // The store part of an x-coredata id is the Core Data store UUID.
  const storeId =
    (options.id && /^x-coredata:\/\/([^/]+)\//.exec(options.id)![1]) ||
    parseJsonLine<{ uuid: string | null }>(storeLine, { uuid: null }).uuid;
  const paths = folderPaths(folders);
  const scope: LinkInventory["scope"] = {};
  let accountPk = 0;
  let folderPk = 0;
  if (options.account) {
    const account = matchAccount(accounts, options.account);
    accountPk = account.pk;
    scope.account = account.name;
    scope.accountIdentifier = account.identifier;
  }
  if (options.folder) {
    const folder = matchFolder(folders, options.folder, accountPk || undefined);
    folderPk = folder.pk;
    scope.folder = folders.find((f) => f.pk === folder.pk)!.title;
    scope.folderPath = folder.path;
  }
  if (options.id) scope.note = options.id;
  const params = { note: notePk, account: accountPk, folder: folderPk };

  const [noteLine, cardLine, previewLine, chipLine] = runStoreSql(dbPath, sql.rows, params);
  const notes = parseJsonLine<NoteRow[]>(noteLine, []);
  if (options.id && !notes.length)
    throw new NoteStoreError("not-found", `No note found for ID "${options.id}"`);
  const cards = parseJsonLine<
    Array<{
      pk: number;
      note: number;
      identifier: string | null;
      url: string;
      title: string | null;
      account: string | null;
    }>
  >(cardLine, []);
  const previews = parseJsonLine<PreviewRow[]>(previewLine, []);
  const chips = parseJsonLine<
    Array<{ note: number; identifier: string | null; token: string | null; alt: string | null }>
  >(chipLine, []);

  const includeInline = options.includeInline ?? Boolean(options.id);
  const docs = includeInline
    ? decodeBodies(dbPath, sql.bodies, params)
    : new Map<number, NoteBlocksDocument>();

  const noteIdOf = (pk: number) => (storeId ? `x-coredata://${storeId}/ICNote/p${pk}` : null);
  const noteById = new Map(notes.map((note) => [note.pk, note]));
  const accountById = new Map(accounts.map((account) => [account.pk, account]));
  const folderById = new Map(folders.map((folder) => [folder.pk, folder]));
  const source = (pk: number) => {
    const note = noteById.get(pk)!;
    const account = accountById.get(note.account ?? -1);
    const folder = folderById.get(note.folder ?? -1);
    return {
      noteId: noteIdOf(pk),
      noteIdentifier: note.identifier,
      noteTitle: note.title,
      noteModified:
        typeof note.modified === "number"
          ? new Date((note.modified + APPLE_EPOCH_OFFSET) * 1000).toISOString()
          : null,
      folder: folder?.title ?? null,
      folderPath: folder ? paths.get(folder.pk)! : null,
      account: account?.name ?? null,
      accountIdentifier: account?.identifier ?? null,
    };
  };

  const storeDir = dirname(dbPath);
  const all: Array<{ pk: number; link: InventoryLink }> = [];
  const add = (pk: number, link: NoteLinkEntry) =>
    all.push({ pk, link: { ...link, ...source(pk) } });
  for (const [pk, doc] of docs) for (const link of inlineLinks(doc)) add(pk, link);
  for (const card of cards) {
    const rows = previews.filter((row) => row.attachment === card.pk);
    const noteId = noteIdOf(card.note);
    const link = cardLink(
      { pk: card.pk, identifier: card.identifier ?? "", url: card.url, title: card.title },
      {
        doc: docs.get(card.note),
        ...(noteId ? { noteId } : {}),
        previewPath: rows.length ? resolvePreviewPath(storeDir, card.account, rows) : null,
      }
    );
    if (link) add(card.note, link);
  }
  for (const chip of chips) {
    const link = nativeLink(
      { identifier: chip.identifier ?? "", token: chip.token, alt: chip.alt },
      docs.get(chip.note)
    );
    if (link) add(chip.note, link);
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
