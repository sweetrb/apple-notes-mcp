/**
 * Read-only folder facts from the NoteStore database.
 *
 * AppleScript can resolve (and delete) folders it never lists: a smart folder's
 * `folder id "x-coredata://…/ICFolder/pN"` reference resolves even though
 * `folders of account` omits it, and Recently Deleted is listed like any other
 * folder. Folder type, the stable Notes identifier, the tombstone flag, and the
 * CloudKit share record are only visible in the store, so guarded folder
 * deletion reads them here before it asks Notes.app to delete anything.
 *
 * Safety:
 * - The database is opened READ-ONLY (`sqlite3 -readonly`) through execFileSync
 *   with an argument array, so no shell ever sees the query or the path.
 * - The folder's primary key is bound with `.parameter set`, never spliced into
 *   the SQL text, and it is constrained to digits before it gets that far.
 * - Missing required columns fail closed: a schema this reader does not know
 *   cannot prove a folder is safe to delete.
 *
 * @module utils/folderStore
 */

import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

/** Default location of the live Notes database. */
export const NOTE_STORE_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Store-level facts about one folder row. */
export interface FolderStoreFacts {
  /** Core Data primary key (the `pN` number of the x-coredata id). */
  pk: number;
  /** Stable Notes identifier (a UUID, or an Apple name such as `DefaultFolder-CloudKit`). */
  identifier: string | null;
  /** Notes folder type: 0 ordinary, 1 Recently Deleted, 2 smart folder. */
  folderType: number | null;
  /** Whether the row is already tombstoned. */
  markedForDeletion: boolean;
  /** Primary key of the parent folder, or null at an account root. */
  parentPk: number | null;
  /** Primary key of the owning account. */
  accountPk: number | null;
  /** Whether the row stores a smart-folder query. */
  hasSmartQuery: boolean;
  /** Whether the folder itself carries a CloudKit share record. */
  sharedRecord: boolean;
  /** Whether any ancestor folder carries a CloudKit share record. */
  sharedAncestor: boolean;
  /** Direct child folders that are not tombstoned (smart folders included). */
  childFolderCount: number;
  /** Notes whose folder is this one and that are not tombstoned. */
  noteCount: number;
  /** Primary keys of up to NOTE_KEY_LIMIT of those notes, for a live cross-check. */
  noteKeys: number[];
}

/** How many note keys the facts query returns. */
export const NOTE_KEY_LIMIT = 50;

/** Why a store read failed, so callers can give an actionable message. */
export class FolderStoreError extends Error {
  constructor(
    message: string,
    readonly reason: "no_fda" | "schema" | "not_folder" | "query_error"
  ) {
    super(message);
    this.name = "FolderStoreError";
  }
}

/** Columns the folder query reads; a missing one fails closed. */
export const REQUIRED_FOLDER_COLUMNS = [
  "ZFOLDERTYPE",
  "ZIDENTIFIER",
  "ZMARKEDFORDELETION",
  "ZPARENT",
  "ZOWNER",
  "ZFOLDER",
  "ZSERVERSHAREDATA",
] as const;

/**
 * Builds the folder facts query. The only variable input is the `@pk`
 * parameter; `hasSmartQueryColumn` switches between two fixed SQL fragments.
 */
export function buildFolderFactsSql(hasSmartQueryColumn: boolean): string {
  const smart = hasSmartQueryColumn ? "coalesce(f.ZSMARTFOLDERQUERYJSON, '') <> ''" : "0";
  return `WITH RECURSIVE anc(pk, depth) AS (
  SELECT ZPARENT, 1 FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = @pk
  UNION ALL
  SELECT o.ZPARENT, anc.depth + 1 FROM ZICCLOUDSYNCINGOBJECT o JOIN anc ON o.Z_PK = anc.pk
  WHERE anc.pk IS NOT NULL AND anc.depth < 64
)
SELECT json_object(
  'pk', f.Z_PK,
  'entity', e.Z_NAME,
  'identifier', f.ZIDENTIFIER,
  'folderType', f.ZFOLDERTYPE,
  'markedForDeletion', coalesce(f.ZMARKEDFORDELETION, 0),
  'parentPk', f.ZPARENT,
  'accountPk', f.ZOWNER,
  'hasSmartQuery', ${smart},
  'sharedRecord', f.ZSERVERSHAREDATA IS NOT NULL,
  'sharedAncestor', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT a JOIN anc ON a.Z_PK = anc.pk
                     WHERE a.ZSERVERSHAREDATA IS NOT NULL) > 0,
  'childFolderCount', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT c
                       WHERE c.Z_ENT = f.Z_ENT AND c.ZPARENT = f.Z_PK
                         AND coalesce(c.ZMARKEDFORDELETION, 0) = 0),
  'noteCount', (SELECT count(*) FROM ZICCLOUDSYNCINGOBJECT n
                WHERE n.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')
                  AND n.ZFOLDER = f.Z_PK AND coalesce(n.ZMARKEDFORDELETION, 0) = 0),
  'noteKeys', json((SELECT json_group_array(k.Z_PK) FROM (
                SELECT n.Z_PK FROM ZICCLOUDSYNCINGOBJECT n
                WHERE n.Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')
                  AND n.ZFOLDER = f.Z_PK AND coalesce(n.ZMARKEDFORDELETION, 0) = 0
                ORDER BY n.Z_PK LIMIT ${NOTE_KEY_LIMIT}) k))
)
FROM ZICCLOUDSYNCINGOBJECT f JOIN Z_PRIMARYKEY e ON e.Z_ENT = f.Z_ENT
WHERE f.Z_PK = @pk;`;
}

/** Runs one read-only sqlite3 call, binding `@pk` when given. */
function runSqlite(dbPath: string, sql: string, pk?: number): string {
  const args = ["-readonly"];
  if (pk !== undefined) args.push("-cmd", `.parameter set @pk ${pk}`);
  args.push(dbPath, sql);
  return execFileSync("sqlite3", args, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Classifies a sqlite3 failure; permission problems become `no_fda`. */
function classify(error: unknown): FolderStoreError {
  const message = error instanceof Error ? error.message : String(error);
  if (/authorization denied|unable to open database|not authorized/i.test(message)) {
    return new FolderStoreError(
      "Full Disk Access is required to verify folder type and contents before deleting. Grant it to the Node binary running this server (or the terminal that launches it), then relaunch it.",
      "no_fda"
    );
  }
  return new FolderStoreError(`Failed to read folder facts: ${message}`, "query_error");
}

/** Converts a JSON number or null into a number or null. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads the store facts for one folder by primary key.
 *
 * @param pk - Core Data primary key from the folder's x-coredata id
 * @param dbPath - NoteStore path (tests pass a fixture database)
 * @returns The facts, or null when no row has that key
 * @throws FolderStoreError when the store is unreadable, the schema is unknown,
 *   or the row is not a folder
 */
export function readFolderStoreFacts(
  pk: number,
  dbPath: string = NOTE_STORE_PATH
): FolderStoreFacts | null {
  if (!Number.isSafeInteger(pk) || pk <= 0) {
    throw new FolderStoreError("Folder key must be a positive integer", "query_error");
  }
  let columns: Set<string>;
  let row: string;
  try {
    columns = new Set(
      runSqlite(dbPath, "PRAGMA table_info(ZICCLOUDSYNCINGOBJECT);")
        .split("\n")
        .map((line) => line.split("|")[1])
        .filter(Boolean)
    );
    const missing = REQUIRED_FOLDER_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new FolderStoreError(
        `This macOS Notes schema lacks ${missing.join(", ")}; folder safety cannot be verified`,
        "schema"
      );
    }
    row = runSqlite(dbPath, buildFolderFactsSql(columns.has("ZSMARTFOLDERQUERYJSON")), pk);
  } catch (error) {
    if (error instanceof FolderStoreError) throw error;
    throw classify(error);
  }
  if (!row) return null;
  const raw = JSON.parse(row) as Record<string, unknown>;
  if (raw.entity !== "ICFolder") {
    throw new FolderStoreError("That identifier does not name a folder", "not_folder");
  }
  return {
    pk,
    identifier: typeof raw.identifier === "string" ? raw.identifier : null,
    folderType: numberOrNull(raw.folderType),
    markedForDeletion: raw.markedForDeletion === 1,
    parentPk: numberOrNull(raw.parentPk),
    accountPk: numberOrNull(raw.accountPk),
    hasSmartQuery: raw.hasSmartQuery === 1,
    sharedRecord: raw.sharedRecord === 1,
    sharedAncestor: raw.sharedAncestor === 1,
    childFolderCount: numberOrNull(raw.childFolderCount) ?? 0,
    noteCount: numberOrNull(raw.noteCount) ?? 0,
    noteKeys: Array.isArray(raw.noteKeys)
      ? raw.noteKeys.filter((key): key is number => typeof key === "number")
      : [],
  };
}
