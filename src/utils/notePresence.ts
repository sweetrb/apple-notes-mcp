/**
 * Exact-ID note presence from the NoteStore database (#316).
 *
 * get-note-content used to start with an AppleScript metadata read (name, id,
 * dates, shared, password protected: one Apple Event per property, each
 * resolving `note id` across the whole library) before the AppleScript body
 * read. When Notes.app is busy, for example while iCloud syncs, that first
 * step can time out or report "Can't get note id" for a note that exists,
 * while get-note-structure, which reads the database directly, finds it.
 *
 * This reader answers the two questions the metadata step was asked (does the
 * note exist, and is it locked) from the database, so the tool can skip that
 * step, and it lets an AppleScript "not found" be checked against the store
 * before it is reported as definitive.
 *
 * It never throws and never guesses: any doubt (no Full Disk Access, a query
 * error, another store's id, a tombstoned row) returns null, and the caller
 * keeps the AppleScript path it had before.
 *
 * @module utils/notePresence
 */
import {
  NOTES_DB_PATH,
  col,
  entity,
  notTombstonedSql,
  parseJsonLines,
  readColumns,
  runReadOnlySql,
  trashFolderSql,
} from "./noteStoreSql.js";

/** A note the database holds, live (not marked for deletion). */
export interface NotePresence {
  /** The note's title, or null when the database holds none. */
  title: string | null;
  /** Password-protected (or its body is encrypted). */
  locked: boolean;
  /** The note is in Recently Deleted (AppleScript still resolves it there). */
  inRecentlyDeleted: boolean;
}

interface PresenceRow {
  store: string | null;
  isNote: number | null;
  live: number | null;
  title: string | null;
  locked: number | null;
  encrypted: number | null;
  inTrash: number | null;
}

const NOTE_ID = /^x-coredata:\/\/([0-9A-Fa-f-]+)\/ICNote\/p(\d+)$/;

/**
 * Read whether the database holds a live note with this exact id.
 *
 * @param id - Canonical x-coredata note id
 * @param dbPath - NoteStore path (tests pass a fixture)
 * @returns The note's presence, or null when the database cannot vouch for it
 */
export function readNotePresence(id: string, dbPath: string = NOTES_DB_PATH): NotePresence | null {
  const match = NOTE_ID.exec(id);
  if (!match) return null;
  const [, store, pk] = match;
  try {
    const columns = readColumns(dbPath);
    const c = (alias: string, name: string) => col(columns, alias, name);
    const sql = `SELECT json_object(
        'store', (SELECT Z_UUID FROM Z_METADATA LIMIT 1),
        'isNote', n.Z_ENT = ${entity("ICNote")},
        'live', ${notTombstonedSql(columns, "n")},
        'title', ${c("n", "ZTITLE1")},
        'locked', ${c("n", "ZISPASSWORDPROTECTED")},
        'encrypted', (SELECT d.ZCRYPTOINITIALIZATIONVECTOR IS NOT NULL FROM ZICNOTEDATA d WHERE d.ZNOTE = n.Z_PK),
        'inTrash', CASE WHEN f.Z_PK IS NULL THEN 0 ELSE ${trashFolderSql(columns, "f")} END)
      FROM ZICCLOUDSYNCINGOBJECT n
      LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = ${c("n", "ZFOLDER")}
      WHERE n.Z_PK = @pk;`;
    const [row] = parseJsonLines<PresenceRow>(
      runReadOnlySql(dbPath, sql, { pk: { int: Number(pk) } })
    );
    // Another store's id shares primary keys with unrelated rows here.
    if (!row || typeof row.store !== "string" || row.store.toUpperCase() !== store.toUpperCase())
      return null;
    if (row.isNote !== 1 || row.live !== 1) return null;
    return {
      title: typeof row.title === "string" ? row.title : null,
      locked: row.locked === 1 || row.encrypted === 1,
      inRecentlyDeleted: row.inTrash === 1,
    };
  } catch {
    return null;
  }
}
