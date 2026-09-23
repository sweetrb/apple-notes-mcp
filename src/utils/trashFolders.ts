/**
 * Identifies the Recently Deleted folders so AppleScript paths can recognise
 * notes that sit in them (#198, #207).
 *
 * Notes.app's scripting dictionary has no folder-type property, and the
 * folder's name is localised, so the reliable marker lives in the NoteStore
 * database: ZFOLDERTYPE = 1, or a `TrashFolder` identifier prefix on stores
 * without that column. Only the folder's identity is taken from the
 * database. Whether a particular note is in that folder is always asked of
 * Notes.app itself, because the database can lag a just-deleted note by
 * several seconds (#198).
 *
 * Every failure (no Full Disk Access, no database, unexpected schema) yields
 * an empty list; callers then fall back to matching the English folder name.
 *
 * @module utils/trashFolders
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Name Notes.app gives the trash folder in English, used as the fallback marker. */
export const RECENTLY_DELETED_FOLDER_NAME = "Recently Deleted";

/** Folder ids are stable, so a successful read is reused for this long. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { dbPath: string; at: number; ids: string[] } | null = null;

/** Clears the cached folder ids (tests, or after an account change). */
export function clearTrashFolderCache(): void {
  cache = null;
}

function query(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-readonly", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Returns the Core Data ids (`x-coredata://<store>/ICFolder/p<N>`) of every
 * Recently Deleted folder, or an empty list when the database cannot say.
 */
export function readTrashFolderIds(dbPath: string = NOTES_DB_PATH): string[] {
  if (cache && cache.dbPath === dbPath && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.ids;
  }
  try {
    if (!fs.existsSync(dbPath)) return [];
    const columns = new Set(
      query(dbPath, "SELECT name FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    );
    const predicates: string[] = [];
    if (columns.has("ZFOLDERTYPE")) predicates.push("COALESCE(ZFOLDERTYPE, 0) = 1");
    if (columns.has("ZIDENTIFIER"))
      predicates.push("COALESCE(ZIDENTIFIER, '') LIKE 'TrashFolder%'");
    if (!predicates.length) return [];
    const sql =
      "SELECT (SELECT Z_UUID FROM Z_METADATA LIMIT 1); " +
      "SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT " +
      "WHERE Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICFolder') " +
      `AND (${predicates.join(" OR ")}) ORDER BY Z_PK;`;
    const [uuid, ...pks] = query(dbPath, sql)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!uuid || !/^[0-9A-F-]+$/i.test(uuid)) return [];
    const ids = pks
      .filter((pk) => /^\d+$/.test(pk))
      .map((pk) => `x-coredata://${uuid}/ICFolder/p${pk}`);
    cache = { dbPath, at: Date.now(), ids };
    return ids;
  } catch {
    return [];
  }
}
