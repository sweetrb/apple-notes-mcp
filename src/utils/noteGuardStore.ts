/**
 * Read-only NoteStore facts used by guarded note deletion.
 *
 * - Which folders are Recently Deleted (folder type 1). Their Core Data keys are
 *   stable, so the database's save lag for a just-moved note does not matter:
 *   the delete script compares the note's live AppleScript container against
 *   these ids.
 * - Whether a note is a Quick Note (`ZISSYSTEMPAPER`), which AppleScript does
 *   not expose.
 *
 * Safety: `sqlite3 -readonly` through execFileSync with an argument array; the
 * only variable input (a note's primary key) is bound with `.parameter set`
 * after being constrained to a positive integer.
 *
 * @module utils/noteGuardStore
 */

import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

/** Default location of the live Notes database. */
export const NOTE_STORE_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Why a store read failed. */
export class NoteGuardStoreError extends Error {
  constructor(
    message: string,
    readonly reason: "no_fda" | "query_error"
  ) {
    super(message);
    this.name = "NoteGuardStoreError";
  }
}

/** Primary keys of every Recently Deleted folder, across accounts. */
export const TRASH_FOLDERS_SQL = `SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT
WHERE Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICFolder')
  AND ZFOLDERTYPE = 1
ORDER BY Z_PK;`;

/** Quick Note flag for the note bound to `@pk` (no row when it is not a note). */
export const QUICK_NOTE_SQL = `SELECT coalesce(ZISSYSTEMPAPER, 0) FROM ZICCLOUDSYNCINGOBJECT
WHERE Z_PK = @pk
  AND Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote');`;

/** The same lookup for a store without the Quick Note column (always 0). */
export const NOTE_EXISTS_SQL = `SELECT 0 FROM ZICCLOUDSYNCINGOBJECT
WHERE Z_PK = @pk
  AND Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote');`;

/** Runs one read-only sqlite3 call, binding `@pk` when given. */
function runSqlite(dbPath: string, sql: string, pk?: number): string {
  const args = ["-readonly"];
  if (pk !== undefined) args.push("-cmd", `.parameter set @pk ${pk}`);
  args.push(dbPath, sql);
  try {
    return execFileSync("sqlite3", args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database|not authorized/i.test(message)) {
      throw new NoteGuardStoreError(
        "Full Disk Access is required to check this guard. Grant it to the app that launches this server, then relaunch it.",
        "no_fda"
      );
    }
    throw new NoteGuardStoreError(`Failed to read the Notes store: ${message}`, "query_error");
  }
}

/** Lists the primary keys of Recently Deleted folders. */
export function readTrashFolderPks(dbPath: string = NOTE_STORE_PATH): number[] {
  const out = runSqlite(dbPath, TRASH_FOLDERS_SQL);
  return out
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pk) => Number.isSafeInteger(pk) && pk > 0);
}

/**
 * Whether a note is a Quick Note.
 *
 * @returns true or false, or null when the store has no note with that key
 */
export function readIsQuickNote(pk: number, dbPath: string = NOTE_STORE_PATH): boolean | null {
  if (!Number.isSafeInteger(pk) || pk <= 0)
    throw new NoteGuardStoreError("Note key must be a positive integer", "query_error");
  const columns = runSqlite(dbPath, "PRAGMA table_info(ZICCLOUDSYNCINGOBJECT);");
  // Quick Notes arrived with the column; a store without it has none.
  const hasColumn = columns.split("\n").some((line) => line.split("|")[1] === "ZISSYSTEMPAPER");
  const out = runSqlite(dbPath, hasColumn ? QUICK_NOTE_SQL : NOTE_EXISTS_SQL, pk);
  if (out === "") return null;
  return out === "1";
}
