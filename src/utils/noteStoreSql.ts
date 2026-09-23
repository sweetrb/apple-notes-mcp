/**
 * Read-only SQL plumbing for the NoteStore database.
 *
 * Every query runs through `/usr/bin/sqlite3 -readonly` with an argument
 * array (no shell). The only values ever bound into a query are integers,
 * set as sqlite3 parameters (`.parameter set @name <int>`); names and other
 * user text are matched in JavaScript, never spliced into SQL. Column names
 * come from fixed allowlists and are checked against `PRAGMA table_info`, so
 * a column missing on one macOS version reads as NULL instead of failing.
 *
 * @module utils/noteStoreSql
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** The live NoteStore database. */
export const NOTES_DB_PATH = join(
  homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

/** Stable failure classes for store reads. */
export type NoteStoreErrorCode =
  | "invalid-id"
  | "invalid-argument"
  | "no-full-disk-access"
  | "not-found"
  | "unsupported-schema"
  | "query-failed";

export class NoteStoreError extends Error {
  readonly code: NoteStoreErrorCode;
  constructor(code: NoteStoreErrorCode, message: string) {
    super(message);
    this.name = "NoteStoreError";
    this.code = code;
  }
}

/** Primary key of a canonical `x-coredata://.../ICNote/p<n>` id, or throw. */
export function notePrimaryKey(id: string): number {
  const pk = /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p([0-9]{1,15})$/i.exec(id)?.[1];
  if (!pk)
    throw new NoteStoreError(
      "invalid-id",
      "Invalid note ID: expected x-coredata://<store>/ICNote/p<number>"
    );
  return Number(pk);
}

/**
 * Run read-only SQL and return one output line per statement. `params` are
 * bound as integer sqlite3 parameters; anything else is rejected.
 */
export function runStoreSql(
  dbPath: string,
  sql: string,
  params: Record<string, number> = {}
): string[] {
  const args = ["-readonly", "-cmd", ".parameter init"];
  for (const [name, value] of Object.entries(params)) {
    if (!/^[a-z]\w*$/i.test(name) || !Number.isSafeInteger(value))
      throw new NoteStoreError("invalid-argument", "Invalid query parameter");
    args.push("-cmd", `.parameter set @${name} ${value}`);
  }
  let output: string;
  try {
    output = execFileSync("/usr/bin/sqlite3", [...args, dbPath, sql], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authorization denied|unable to open database/i.test(message))
      throw new NoteStoreError("no-full-disk-access", "The Notes database is not readable");
    throw new NoteStoreError("query-failed", "Failed to query the Notes database");
  }
  return output.split("\n").filter((line) => line !== "");
}

/** Parse one JSON output line from {@link runStoreSql}. */
export function parseJsonLine<T>(line: string | undefined, fallback: T): T {
  if (line === undefined || line === "") return fallback;
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new NoteStoreError("query-failed", "Unexpected Notes database response");
  }
}

/** Column names of ZICCLOUDSYNCINGOBJECT on this store. */
export function objectColumns(dbPath: string): Set<string> {
  const [line] = runStoreSql(
    dbPath,
    "SELECT json_group_array(name) FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT');"
  );
  const names = parseJsonLine<string[]>(line, []);
  if (!names.length)
    throw new NoteStoreError("unsupported-schema", "The Notes database has no object table");
  return new Set(names);
}

/**
 * Column helper bound to one store's schema: `col("n", "ZTITLE1")` yields
 * `n.ZTITLE1` when the column exists and `NULL` when it does not.
 * `accountOf("n")` coalesces every per-entity account foreign key
 * (`ZACCOUNT`, `ZACCOUNT1`…), because each entity uses a different one.
 */
export function schemaHelpers(columns: Set<string>) {
  const col = (alias: string, name: string) => (columns.has(name) ? `${alias}.${name}` : "NULL");
  const accountColumns = [...columns].filter((name) => /^ZACCOUNT\d*$/.test(name)).sort();
  const accountOf = (alias: string) =>
    accountColumns.length
      ? `COALESCE(${accountColumns.map((name) => `${alias}.${name}`).join(", ")})`
      : "NULL";
  const notDeleted = (alias: string) => `COALESCE(${col(alias, "ZMARKEDFORDELETION")}, 0) = 0`;
  return { col, accountOf, notDeleted, has: (name: string) => columns.has(name) };
}

/** SQL expression for a Core Data entity number, looked up by class name. */
export const entity = (name: string): string => {
  if (!/^IC[A-Za-z]+$/.test(name)) throw new NoteStoreError("invalid-argument", "Invalid entity");
  return `(SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = '${name}')`;
};
